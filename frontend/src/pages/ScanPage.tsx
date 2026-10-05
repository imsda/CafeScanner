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

export function ScanPage() {
  const [result, setResult] = useState<ScanResultState>(null);
  const [pendingSelection, setPendingSelection] =
    useState<PendingCampMeetingSelection | null>(null);
  const [manual, setManual] = useState("");
  const [peopleQuery, setPeopleQuery] = useState("");
  const [peopleMatches, setPeopleMatches] = useState<Array<{ personId: string; name: string; personType?: string }>>([]);
  const [searchStatus, setSearchStatus] = useState("");
  useEffect(() => {
    setPeopleMatches([]);
    if (!peopleQuery.trim()) { setSearchStatus(""); return; }
    setSearchStatus("Searching…");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void api<Array<{ personId: string; name: string; personType?: string }>>(`/scan/people?q=${encodeURIComponent(peopleQuery.trim())}`, { signal: controller.signal })
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
  const lastSubmissionRef = useRef<{ value: string; timestamp: number } | null>(
    null,
  );

  const focusUsbInput = () => {
    if (mode !== "usb") return;
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

  const clearSubmittedInput = (submitted: string) =>
    setManual((current) => (current.trim() === submitted ? "" : current));

  const submitScan = async (code: string, entitlementId?: number) => {
    const trimmed = code.trim();
    if (!trimmed || isSubmitting) return;
    const dedupeKey = `${trimmed}:${entitlementId ?? "none"}`;
    const now = Date.now();
    if (
      lastSubmissionRef.current &&
      lastSubmissionRef.current.value === dedupeKey &&
      now - lastSubmissionRef.current.timestamp < scanCooldownSeconds * 1000
    ) {
      return;
    }
    lastSubmissionRef.current = { value: dedupeKey, timestamp: now };

    clearAutoSubmitTimeout();
    setIsSubmitting(true);

    try {
      const response = await api<ScanResponse>("/scan", {
        method: "POST",
        body: JSON.stringify({ personId: trimmed, entitlementId }),
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
        clearSubmittedInput(trimmed);
        scannerLikeInputRef.current = false;
        focusUsbInput();
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
      clearSubmittedInput(trimmed);
      scannerLikeInputRef.current = false;
      focusUsbInput();
    } catch (error) {
      const failureMessage =
        error instanceof Error
          ? error.message
          : "Unable to process this scan right now.";
      setResult({ ok: false, error: failureMessage });
      setLastScannerError(failureMessage);
      setPendingSelection(null);
      clearSubmittedInput(trimmed);
      // A scan the server rejected (4xx: cooldown, no meals left…) stays de-duplicated, but a network or
      // server failure must not block an immediate retry of the same ID.
      if (!(error instanceof ApiError && error.status < 500)) lastSubmissionRef.current = null;
      scannerLikeInputRef.current = false;
      focusUsbInput();
    } finally {
      setIsSubmitting(false);
    }
  };

  const onManualSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setPendingSelection(null);
    await submitScan(manual);
  };

  useEffect(() => {
    if (mode !== "usb" || isSubmitting) return;

    const trimmed = manual.trim();
    if (!scannerLikeInputRef.current || !trimmed) return;

    clearAutoSubmitTimeout();
    autoSubmitTimeoutRef.current = window.setTimeout(() => {
      void submitScan(trimmed);
    }, 120);
  }, [manual, mode, isSubmitting]);

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
    scannerLikeInputRef.current = false;
    clearAutoSubmitTimeout();
    setPendingSelection(null);
    void submitScan(manual);
  };

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
            onResult={(text) => void submitScan(text)}
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
              disabled={isSubmitting || manual.trim().length === 0}
            >
              {isSubmitting ? "Submitting…" : "Submit ID"}
            </button>
          </form>
        )}
        <div className="stack scanner-card">
          <h3>Find Person by Name</h3>
          <label>Name or person ID
            <input ref={peopleSearchInputRef} type="search" value={peopleQuery} placeholder="Enter an ID, first name, or last name"
              onChange={(e) => setPeopleQuery(e.target.value)} />
          </label>
          <p role="status">{searchStatus}</p>
          {peopleMatches.length > 0 && <>
            <p className="muted">Select Scan to record a meal. Shared IDs use the normal ticket selection rules. Showing up to 20 matches.</p>
            <ul>{peopleMatches.map((person, index) => <li key={`${person.personId}-${index}`}>
              <strong>{person.name}</strong> — ID: {person.personId} {person.personType ? `(${formatPersonType(person.personType)})` : ''}{" "}
              <button type="button" disabled={isSubmitting} onClick={() => {
                setPeopleQuery("");
                void submitScan(person.personId).finally(() => window.setTimeout(() => peopleSearchInputRef.current?.focus(), 0));
              }}>
                Scan ID {person.personId}
              </button>
            </li>)}</ul>
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
                  onClick={() =>
                    void submitScan(
                      pendingSelection.scannedValue,
                      option.entitlementId,
                    )
                  }
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
                setManual("");
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
