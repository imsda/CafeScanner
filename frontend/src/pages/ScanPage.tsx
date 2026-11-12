import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ApiError, api, errorMessage } from "../api/client";
import type { MealTrackingMode, MealType, ScanResponse, Settings } from "../api/types";
import QrScanner from "../components/QrScanner";
import { ScanResultCard } from "../components/ScanResultCard";
import type { ScanResultState } from "../components/ScanResultCard";
import { formatMealLabel, formatPersonType, modeLabel } from "../lib/format";

export type PendingCampMeetingSelection = {
  scannedValue: string;
  originalScannedValue?: string;
  mealType: MealType;
  mealDay: string;
  options: Array<{ entitlementId: number; personName: string; sourceRowKey?: string; sourceRow?: number | null }>;
};

type PersonMatch = { personId: string; name: string; personType?: string };
type QueuedScan = { code: string; entitlementId?: number; quantity?: number; afterScan?: () => void };

const MAX_SCAN_QUANTITY = 20;
// Scans waiting behind the one in flight; more than this means something is stuck.
const MAX_QUEUED_SCANS = 5;
// How long after a successful scan a server "cooldown" answer for the same badge is treated as a double read.
const DUPLICATE_GRACE_MS = 15_000;

// Badge IDs are matched case-insensitively by the server, so de-duplicate the same way.
const scanKey = (code: string, entitlementId?: number) => `${code.trim().toUpperCase()}:${entitlementId ?? "none"}`;

export function ScanPage() {
  const [result, setResult] = useState<ScanResultState>(null);
  const [pendingSelection, setPendingSelection] =
    useState<PendingCampMeetingSelection | null>(null);
  const [manual, setManual] = useState("");
  const [peopleQuery, setPeopleQuery] = useState("");
  const [peopleMatches, setPeopleMatches] = useState<PersonMatch[]>([]);
  const [searchQuantity, setSearchQuantity] = useState(1);
  const [scanNotice, setScanNotice] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  useEffect(() => {
    setPeopleMatches([]);
    if (!peopleQuery.trim()) { setSearchStatus(""); return; }
    setSearchStatus("Searching…");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void api<PersonMatch[]>(`/scan/people?q=${encodeURIComponent(peopleQuery.trim())}`, { signal: controller.signal })
        .then((rows) => { if (!controller.signal.aborted) { setPeopleMatches(rows); setSearchStatus(rows.length ? "" : "No people found."); } })
        .catch(() => { if (!controller.signal.aborted) setSearchStatus("Search failed. Please try again."); });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [peopleQuery]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<"camera" | "usb">("usb");
  const [mealTrackingMode, setMealTrackingMode] =
    useState<MealTrackingMode>("camp_meeting");
  const [scanCooldownSeconds, setScanCooldownSeconds] = useState(1);
  const [scannerDiagnosticsEnabled, setScannerDiagnosticsEnabled] =
    useState(false);
  const [lastScannerError, setLastScannerError] = useState("");
  const [hasStudentMealWarnings, setHasStudentMealWarnings] = useState(false);
  const usbInputRef = useRef<HTMLInputElement>(null);
  const peopleSearchInputRef = useRef<HTMLInputElement>(null);
  const autoSubmitTimeoutRef = useRef<number | null>(null);
  const lastInputAtRef = useRef(0);
  const previousManualRef = useRef("");
  const scannerLikeInputRef = useRef(false);
  const queueRef = useRef<QueuedScan[]>([]);
  const processingRef = useRef(false);
  const inFlightKeyRef = useRef<string | null>(null);
  const lastFinishedRef = useRef<{ key: string; timestamp: number } | null>(null);
  const lastSuccessRef = useRef<{ key: string; timestamp: number } | null>(null);
  // Read through refs because the scan queue keeps running across re-renders.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const cooldownMsRef = useRef(scanCooldownSeconds * 1000);
  cooldownMsRef.current = scanCooldownSeconds * 1000;

  const focusUsbInput = () => {
    if (modeRef.current !== "usb") return;
    setTimeout(() => usbInputRef.current?.focus(), 0);
  };

  const clearAutoSubmitTimeout = () => {
    if (autoSubmitTimeoutRef.current !== null) {
      window.clearTimeout(autoSubmitTimeoutRef.current);
      autoSubmitTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    if (mode === "usb") {
      usbInputRef.current?.focus();
    }
  }, [mode]);

  useEffect(() => {
    api<Settings>("/scan/settings").then((s) => {
      setMealTrackingMode(s.mealTrackingMode);
      setScanCooldownSeconds(
        Math.min(10, Math.max(0.5, s.scannerCooldownSeconds || 1)),
      );
      setScannerDiagnosticsEnabled(Boolean(s.scannerDiagnosticsEnabled));
    }).catch((loadError) => {
      setLastScannerError(errorMessage(loadError, "Unable to load scanner settings; using defaults."));
    });
  }, []);

  useEffect(() => {
    const refreshWarningStatus = () => {
      api<{ hasWarnings: boolean }>("/scan/warnings/status")
        .then((status) => setHasStudentMealWarnings(status.hasWarnings))
        // Keep the last known state; the next poll retries.
        .catch(() => undefined);
    };
    refreshWarningStatus();
    const interval = window.setInterval(refreshWarningStatus, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => () => clearAutoSubmitTimeout(), []);

  // Empties the scan box. Called the moment a code is taken from it, so a dropped or
  // duplicate read can never leave text behind for the next badge to be appended to.
  const clearScanInput = () => {
    setManual("");
    previousManualRef.current = "";
    scannerLikeInputRef.current = false;
    clearAutoSubmitTimeout();
  };

  const performScan = async ({ code, entitlementId, quantity }: QueuedScan) => {
    const key = scanKey(code, entitlementId);
    inFlightKeyRef.current = key;
    setIsSubmitting(true);
    // Whether the server gave a definite answer (recorded or refused) for this badge.
    let answered = true;

    try {
      const response = await api<ScanResponse>("/scan", {
        method: "POST",
        body: JSON.stringify({ personId: code, entitlementId, ...(quantity && quantity > 1 ? { quantity } : {}) }),
      });
      if (!response.ok && response.pendingSelection) {
        setPendingSelection({
          scannedValue: response.scannedValue,
          originalScannedValue: response.originalScannedValue,
          mealType: response.mealType,
          mealDay: response.mealDay,
          options: response.options,
        });
        setResult(null);
        return;
      }
      if (!response.ok) {
        throw new Error("Unable to process this scan right now.");
      }

      setResult({
        ok: true,
        person: response.person,
        mealType: response.mealType,
        mealTrackingMode: response.mealTrackingMode,
        quantity: response.quantity,
        scannedValue: response.scannedValue,
        remainingAvailableTodayForMeal: response.remainingAvailableTodayForMeal,
        remainingAvailableCount: response.remainingAvailableCount,
        selectedPerson: response.selectedPerson,
        selectedEntitlementId: response.selectedEntitlementId,
        sourceRowKey: response.sourceRowKey,
        sourceRow: response.sourceRow,
        redeemedEntitlement: response.redeemedEntitlement,
      });
      setPendingSelection(null);
      setMealTrackingMode(response.mealTrackingMode);
      setLastScannerError("");
      setScanNotice("");
      lastSuccessRef.current = { key, timestamp: Date.now() };
    } catch (error) {
      // The scanner read the same badge twice and the server's cooldown caught the repeat:
      // keep showing the successful scan instead of replacing it with an error.
      const reason = error instanceof ApiError ? (error.payload as { reason?: string } | null)?.reason : undefined;
      const lastSuccess = lastSuccessRef.current;
      if (reason === "COOLDOWN_ACTIVE" && lastSuccess?.key === key && Date.now() - lastSuccess.timestamp < DUPLICATE_GRACE_MS) {
        setScanNotice(`Duplicate scan of ${code} ignored.`);
        return;
      }
      answered = error instanceof ApiError && error.status < 500;
      const failureMessage = errorMessage(error, "Unable to process this scan right now.");
      setResult({ ok: false, error: failureMessage });
      setLastScannerError(failureMessage);
      setPendingSelection(null);
    } finally {
      // A network or server failure must not block an immediate retry of the same ID.
      lastFinishedRef.current = answered ? { key, timestamp: Date.now() } : null;
      inFlightKeyRef.current = null;
    }
  };

  // Scans are processed strictly one at a time, in the order they were read. A badge scanned
  // while the previous request is still in flight waits its turn instead of being dropped.
  const processQueue = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        await performScan(next);
        if (next.afterScan) next.afterScan();
        else focusUsbInput();
      }
    } finally {
      processingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const submitScan = (code: string, options: { entitlementId?: number; quantity?: number; afterScan?: () => void } = {}) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    const key = scanKey(trimmed, options.entitlementId);
    const now = Date.now();
    const lastFinished = lastFinishedRef.current;
    // A repeat read of the badge that is being processed, is already waiting, or just finished
    // within the scan delay is a double read from the scanner, not a second meal.
    const isRepeat = inFlightKeyRef.current === key
      || queueRef.current.some((queued) => scanKey(queued.code, queued.entitlementId) === key)
      || (lastFinished !== null && lastFinished.key === key && now - lastFinished.timestamp < cooldownMsRef.current);
    if (isRepeat) {
      setScanNotice(`Duplicate scan of ${trimmed} ignored.`);
      focusUsbInput();
      return;
    }
    if (queueRef.current.length >= MAX_QUEUED_SCANS) {
      setScanNotice("Scanning too fast. Wait for the current scan to finish.");
      return;
    }
    queueRef.current.push({ code: trimmed, ...options });
    void processQueue();
  };

  // Takes whatever is in the scan box, clears the box, and submits it.
  const submitScanInput = () => {
    const code = manual;
    clearScanInput();
    setPendingSelection(null);
    submitScan(code);
  };

  const onManualSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitScanInput();
  };

  // USB scanners that do not send Enter: submit once the burst of fast keystrokes stops.
  useEffect(() => {
    if (mode !== "usb") return;
    if (!scannerLikeInputRef.current || !manual.trim()) return;

    clearAutoSubmitTimeout();
    autoSubmitTimeoutRef.current = window.setTimeout(submitScanInput, 120);
  }, [manual, mode]);

  const onManualInputChange = (value: string) => {
    const now = Date.now();
    const previousValue = previousManualRef.current;
    const elapsedMs = now - lastInputAtRef.current;
    const appendedQuickly =
      value.length > previousValue.length && elapsedMs > 0 && elapsedMs <= 35;

    setManual(value);
    previousManualRef.current = value;
    lastInputAtRef.current = now;

    if (!value.trim()) {
      scannerLikeInputRef.current = false;
      clearAutoSubmitTimeout();
      return;
    }

    if (appendedQuickly || scannerLikeInputRef.current) {
      scannerLikeInputRef.current = true;
    }
  };

  const onManualKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;

    event.preventDefault();
    submitScanInput();
  };

  // Name search: scan the chosen person (with the chosen quantity), then put the cursor back
  // in the scan box so the next badge can be scanned straight away.
  const scanFromSearch = (person: PersonMatch) => {
    const isStudent = person.personType === "STUDENT" || person.personType === "VILLAGE_STUDENT";
    const quantity = quantityAllowed && !isStudent ? searchQuantity : 1;
    setPeopleQuery("");
    setSearchQuantity(1);
    setPendingSelection(null);
    submitScan(person.personId, {
      quantity,
      afterScan: () => {
        if (modeRef.current === "usb") focusUsbInput();
        else window.setTimeout(() => peopleSearchInputRef.current?.focus(), 0);
      },
    });
  };

  const quantityAllowed = mealTrackingMode !== "camp_meeting";

  return (
    <div className="scan-layout">
      <section className="card stack">
        <h2>Scan Station</h2>
        <p className="muted">
          Active tracking mode: <strong>{modeLabel(mealTrackingMode)}</strong>
        </p>
        {hasStudentMealWarnings && (
          <div className="scan-warning" role="status">
            <strong>Please notify administration to check Reports for students.</strong>
          </div>
        )}
        <p className="muted">
          Scan cooldown:{" "}
          <strong>
            {scanCooldownSeconds} second{scanCooldownSeconds === 1 ? "" : "s"}
          </strong>
        </p>
        <div className="button-row">
          <button
            className={mode === "camera" ? "primary" : "secondary"}
            type="button"
            onClick={() => setMode("camera")}
          >
            Camera Scan
          </button>
          <button
            className={mode === "usb" ? "primary" : "secondary"}
            type="button"
            onClick={() => setMode("usb")}
          >
            USB Scanner
          </button>
        </div>
        <p className="muted">
          {mode === "usb" ? "USB scanner ready. Scan a badge to record the meal automatically."
            : "Scan a badge with the camera, or use the name search below."}
        </p>
        {mode === "camera" ? (
          <QrScanner
            cooldownMs={scanCooldownSeconds * 1000}
            diagnosticsEnabled={scannerDiagnosticsEnabled}
            selectedScannerMode="camera"
            lastScannerError={lastScannerError}
            onResult={(text) => submitScan(text)}
            onError={(message) => {
              setLastScannerError(message);
              setResult({ ok: false, error: message });
            }}
          />
        ) : (
          <form className="stack" onSubmit={onManualSubmit}>
            <label>
              Person ID input
              <input
                ref={usbInputRef}
                className="scan-input"
                placeholder="Scan with USB scanner or type person ID and press Enter"
                value={manual}
                onChange={(e) => onManualInputChange(e.target.value)}
                onKeyDown={onManualKeyDown}
                aria-label="Person ID input"
                onBlur={() => {
                  window.setTimeout(() => {
                    if (document.activeElement === document.body) usbInputRef.current?.focus();
                  }, 0);
                }}
              />
            </label>
            <button
              className="primary"
              type="submit"
              disabled={manual.trim().length === 0}
            >
              {isSubmitting ? "Submitting…" : "Submit ID"}
            </button>
          </form>
        )}
        <p className="muted scan-notice" role="status">{scanNotice}</p>
        <div className="stack scanner-card">
          <h3>Find Person by Name</h3>
          <label>Name or person ID
            <input ref={peopleSearchInputRef} type="search" value={peopleQuery} placeholder="Enter an ID, first name, or last name"
              onChange={(e) => setPeopleQuery(e.target.value)} />
          </label>
          <p role="status">{searchStatus}</p>
          {peopleMatches.length > 0 && <>
            {quantityAllowed && (
              <div className="quantity-row">
                <span id="scan-quantity-label">Number of meals</span>
                <div className="quantity-stepper" role="group" aria-labelledby="scan-quantity-label">
                  <button type="button" className="secondary" aria-label="One fewer meal"
                    disabled={searchQuantity <= 1} onClick={() => setSearchQuantity((q) => Math.max(1, q - 1))}>−</button>
                  <input type="number" inputMode="numeric" min={1} max={MAX_SCAN_QUANTITY} value={searchQuantity}
                    aria-labelledby="scan-quantity-label"
                    onChange={(e) => setSearchQuantity(Math.min(MAX_SCAN_QUANTITY, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))} />
                  <button type="button" className="secondary" aria-label="One more meal"
                    disabled={searchQuantity >= MAX_SCAN_QUANTITY} onClick={() => setSearchQuantity((q) => Math.min(MAX_SCAN_QUANTITY, q + 1))}>+</button>
                </div>
                <span className="muted">For staff or guests bringing family on one ID. Students are always 1.</span>
              </div>
            )}
            <p className="muted">Select Scan to record a meal. Shared IDs use the normal ticket selection rules. Showing up to 20 matches.</p>
            <ul className="people-matches">{peopleMatches.map((person, index) => {
              const isStudent = person.personType === "STUDENT" || person.personType === "VILLAGE_STUDENT";
              const quantity = quantityAllowed && !isStudent ? searchQuantity : 1;
              return <li key={`${person.personId}-${index}`}>
                <span>
                  <strong>{person.name}</strong> — ID: {person.personId} {person.personType ? `(${formatPersonType(person.personType)})` : ''}
                </span>
                <button type="button" className="primary" onClick={() => scanFromSearch(person)}>
                  {quantity > 1 ? `Scan ${quantity} meals` : "Scan"}
                </button>
              </li>;
            })}</ul>
          </>}
        </div>
        {scannerDiagnosticsEnabled && (
          <div className="scanner-diagnostics">
            <p>
              <strong>Scanner diagnostics:</strong>
            </p>
            <ul>
              <li>
                Selected scanner mode: <strong>{mode}</strong>
              </li>
              {lastScannerError && (
                <li>
                  Last scanner error: <strong>{lastScannerError}</strong>
                </li>
              )}
            </ul>
          </div>
        )}
        {pendingSelection && (
          <div className="selection-card stack">
            <h3>Select person for this meal</h3>
            <p className="muted">
              Shared ID: <strong>{pendingSelection.scannedValue}</strong>
              {pendingSelection.originalScannedValue &&
              pendingSelection.originalScannedValue !==
                pendingSelection.scannedValue
                ? ` (entered: ${pendingSelection.originalScannedValue})`
                : ""}
            </p>
            <p className="muted">
              Meal:{" "}
              <strong>{formatMealLabel(pendingSelection.mealType)}</strong> ·
              Day: <strong>{pendingSelection.mealDay}</strong>
            </p>
            <div className="selection-options">
              {pendingSelection.options.map((option) => (
                <button
                  key={option.entitlementId}
                  type="button"
                  className="primary selection-option"
                  onClick={() => submitScan(pendingSelection.scannedValue, { entitlementId: option.entitlementId })}
                  disabled={isSubmitting}
                >
                  {option.personName}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setPendingSelection(null);
                clearScanInput();
                focusUsbInput();
              }}
              disabled={isSubmitting}
            >
              Cancel
            </button>
          </div>
        )}
      </section>
      {/* Live region so screen readers announce each scan outcome. */}
      <div role="status" aria-live="polite">
        <ScanResultCard result={result} />
      </div>
    </div>
  );
}
