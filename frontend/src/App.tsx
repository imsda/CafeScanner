import {
  FormEvent,
  KeyboardEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { BarcodeFormat, EncodeHintType, MultiFormatWriter } from "@zxing/library";
import { ApiNetworkError, api, API_BASE } from "./api/client";
import type {
  MealTrackingMode,
  MealType,
  ReportsSummaryResponse,
  ScanPerson,
  ScanResponse,
  Settings,
  GoogleSheetsSchedulerStatus,
} from "./api/types";
import QrScanner from "./components/QrScanner";
import { useAuth } from "./context/AuthContext";
import type { AppPage } from "./context/AuthContext";



type BadgeCodeType = "barcode" | "qr" | "auto";

const BADGE_CODE_TYPE_STORAGE_KEY = "cafescanner.badgeCodeType";

function resolveBadgeCodeType(type: BadgeCodeType, value: string): "barcode" | "qr" {
  if (type !== "auto") return type;
  return /^\d{1,20}$/.test(value.trim()) ? "barcode" : "qr";
}

function BarcodeSvg({ value, width = 150, height = 54 }: { value: string; width?: number; height?: number }) {
  const [svgMarkup, setSvgMarkup] = useState<string>("");

  useEffect(() => {
    const writer = new MultiFormatWriter();
    try {
      const hints = new Map();
      hints.set(EncodeHintType.MARGIN, 0);
      const matrix = writer.encode(value, BarcodeFormat.CODE_128, width, height, hints);
      let markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${matrix.getWidth()} ${matrix.getHeight()}" width="${width}" height="${height}" role="img" aria-label="Barcode for ${value}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/>`;
      for (let y = 0; y < matrix.getHeight(); y += 1) {
        for (let x = 0; x < matrix.getWidth(); x += 1) {
          if (matrix.get(x, y)) {
            markup += `<rect x="${x}" y="${y}" width="1" height="1" fill="black"/>`;
          }
        }
      }
      markup += "</svg>";
      setSvgMarkup(markup);
    } catch {
      setSvgMarkup("");
    }
  }, [height, value, width]);

  if (!svgMarkup) return null;
  return <div aria-hidden dangerouslySetInnerHTML={{ __html: svgMarkup }} />;
}
const PAGE_LABELS: Array<{ key: AppPage; path: string; label: string }> = [
  { key: "DASHBOARD", path: "dashboard", label: "Dashboard" },
  { key: "SCAN", path: "scan", label: "Scan Station" },
  { key: "PEOPLE", path: "people", label: "People" },
  { key: "IMPORT", path: "import", label: "Import" },
  { key: "BADGES", path: "badges", label: "Badges" },
  { key: "TRANSACTIONS", path: "transactions", label: "Transactions" },
  { key: "REPORTS", path: "reports", label: "Reports" },
  { key: "SETTINGS", path: "settings", label: "Settings" },
  { key: "USER_MANAGEMENT", path: "users", label: "User Management" },
];
const TIMEZONE_OPTIONS = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Etc/UTC",
] as const;

function normalizeTimeValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!match) return trimmed;
  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3].toUpperCase();
  const hour24 = (hour12 % 12) + (suffix === "PM" ? 12 : 0);
  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeSettingsForTimeAndTimezone(source: Settings): Settings {
  return {
    ...source,
    timezone: TIMEZONE_OPTIONS.includes(source.timezone as (typeof TIMEZONE_OPTIONS)[number])
      ? source.timezone
      : "America/Chicago",
    breakfastStart: normalizeTimeValue(source.breakfastStart),
    breakfastEnd: normalizeTimeValue(source.breakfastEnd),
    lunchStart: normalizeTimeValue(source.lunchStart),
    lunchEnd: normalizeTimeValue(source.lunchEnd),
    dinnerStart: normalizeTimeValue(source.dinnerStart),
    dinnerEnd: normalizeTimeValue(source.dinnerEnd),
  };
}

function renderStoredTimeValue(timeValue: string): string {
  return normalizeTimeValue(timeValue);
}

function formatMealLabel(meal: string): string {
  return meal.charAt(0) + meal.slice(1).toLowerCase();
}

function modeLabel(mode: MealTrackingMode): string {
  if (mode === "camp_meeting") return "Camp Meeting";
  if (mode === "countdown") return "Count Down";
  return "Tally Up";
}

function formatDateInputValue(date: Date): string {
  const offsetDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60000,
  );
  return offsetDate.toISOString().slice(0, 10);
}

function getRangeForPreset(
  preset: "today" | "week" | "month" | "year" | "last7",
): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  if (preset === "week") {
    const day = start.getDay();
    const offsetToMonday = (day + 6) % 7;
    start.setDate(start.getDate() - offsetToMonday);
  } else if (preset === "month") {
    start.setDate(1);
  } else if (preset === "year") {
    start.setMonth(0, 1);
  } else if (preset === "last7") {
    start.setDate(start.getDate() - 6);
  }

  return {
    from: formatDateInputValue(start),
    to: formatDateInputValue(end),
  };
}

function ButtonLink({
  href,
  children,
  className = "",
  ...props
}: {
  href: string;
  children: ReactNode;
  className?: string;
  target?: string;
  rel?: string;
}) {
  return (
    <a href={href} className={`btn ${className}`.trim()} {...props}>
      {children}
    </a>
  );
}

function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [devDiagnostics, setDevDiagnostics] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await login(username, password);
      setError("");
      setDevDiagnostics("");
    } catch (submitError) {
      if (import.meta.env.DEV && submitError instanceof Error) {
        // Helpful during local troubleshooting without leaking credentials/tokens.
        console.error("Login request failed", submitError);
      }

      if (submitError instanceof ApiNetworkError) {
        setError(
          `Login request failed.\nURL: ${submitError.requestUrl}\nError: ${submitError.name}\nMessage: ${submitError.message}`,
        );
        if (import.meta.env.DEV) {
          setDevDiagnostics(
            `Dev diagnostics — API_BASE: ${API_BASE}; origin: ${window.location.origin}; attempted endpoint: ${submitError.requestUrl}`,
          );
        }
        return;
      }

      setError(
        submitError instanceof Error
          ? submitError.message
          : "Unable to sign in",
      );
      if (import.meta.env.DEV) {
        setDevDiagnostics(
          `Dev diagnostics — API_BASE: ${API_BASE}; origin: ${window.location.origin}; attempted endpoint: ${API_BASE}/auth/login`,
        );
      }
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Cafeteria Scanner</h1>
        <p className="muted">IMSDA Meal Scanner</p>
        <form onSubmit={onSubmit} className="stack">
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              name="login-user"
              placeholder="Enter username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              name="login-pass"
            />
          </label>
          <button className="primary" type="submit">
            Sign in
          </button>
          {error && (
            <p className="error" style={{ whiteSpace: "pre-line" }}>
              {error}
            </p>
          )}
          {import.meta.env.DEV && devDiagnostics && (
            <p className="muted">{devDiagnostics}</p>
          )}
        </form>
      </div>
    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const { logout, user } = useAuth();
  const links = PAGE_LABELS.filter((entry) =>
    user?.allowedPages?.includes(entry.key),
  );

  return (
    <div>
      <header className="topbar">
        <div className="topbar-inner">
          <h2 className="topbar-title">Cafeteria Scanner</h2>
          <div className="right-actions">
            <span className="user-pill">
              {user?.username} · {user?.role}
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => logout()}
            >
              Logout
            </button>
          </div>
        </div>
        <nav>
          {links.map((entry) => (
            <NavLink
              key={entry.path}
              to={`/${entry.path}`}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {entry.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== "ADMIN" && user?.role !== "OWNER")
    return <Navigate to="/scan" replace />;
  return <>{children}</>;
}

function PermissionOnly({
  page,
  children,
}: {
  page: AppPage;
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  if (!user?.allowedPages?.includes(page))
    return (
      <div className="card">
        <h2>Not authorized</h2>
        <p>You do not have access to this page.</p>
      </div>
    );
  return <>{children}</>;
}

function Dashboard() {
  const [data, setData] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    void api<Record<string, number>>("/dashboard/summary").then(setData);
  }, []);
  if (!data) return <p>Loading dashboard…</p>;
  return (
    <div className="card">
      <h2>Today at a glance</h2>
      <div className="stats-grid">
        {Object.entries(data).map(([key, value]) => (
          <div className="stat-card" key={key}>
            <p className="muted">{key}</p>
            <p className="value">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

type ScanResultState =
  | (
      | {
          ok: true;
          person: ScanPerson;
          mealType: MealType;
          mealTrackingMode: MealTrackingMode;
          scannedValue?: string;
          remainingAvailableTodayForMeal?: number;
          redeemedEntitlement?: {
            id: number;
            personName?: string | null;
            personId: string;
            mealDay: string;
            mealDate: string;
          };
        }
      | { ok: false; error: string }
    )
  | null;

type PendingCampMeetingSelection = {
  scannedValue: string;
  originalScannedValue?: string;
  mealType: MealType;
  mealDay: string;
  options: Array<{ entitlementId: number; personName: string }>;
};

function ScanResultCard({ result }: { result: ScanResultState }) {
  if (!result)
    return (
      <div className="scan-result info">
        <h3>Ready</h3>
        <p>Scan a person ID barcode or use USB scanner/manual ID entry.</p>
      </div>
    );
  if (!result.ok)
    return (
      <div className="scan-result fail">
        <h3>Scan Failed</h3>
        <p>{result.error}</p>
      </div>
    );

  const tally =
    result.mealType === "BREAKFAST"
      ? result.person.breakfastCount
      : result.mealType === "LUNCH"
        ? result.person.lunchCount
        : result.person.dinnerCount;

  const sharedId = result.scannedValue || result.person.personId || "N/A";
  return (
    <div className="scan-result success">
      <h3>
        {result.mealTrackingMode === "camp_meeting"
          ? "Meal Redeemed"
          : result.mealTrackingMode === "countdown"
            ? "Meal Deducted"
            : "Meal Recorded"}
      </h3>
      <p className="scan-person">
        {result.person.firstName} {result.person.lastName}
      </p>
      <p>
        Shared ID: <strong>{sharedId}</strong>
      </p>
      <p>
        Meal: <strong>{formatMealLabel(result.mealType)}</strong>
      </p>
      <p>
        Mode: <strong>{modeLabel(result.mealTrackingMode)}</strong>
      </p>
      {result.mealTrackingMode === "camp_meeting" ? (
        <>
          <p>
            {result.redeemedEntitlement?.personName
              ? `Meal redeemed for ${result.redeemedEntitlement.personName}`
              : "Meal redeemed."}
          </p>
          <p>
            Remaining available today for this meal:{" "}
            <strong>{result.remainingAvailableTodayForMeal ?? 0}</strong>
          </p>
        </>
      ) : result.mealTrackingMode === "countdown" ? (
        <>
          <p>{formatMealLabel(result.mealType)} deducted by 1.</p>
          <p>
            Remaining {formatMealLabel(result.mealType).toLowerCase()}:{" "}
            <strong>
              {result.mealType === "BREAKFAST"
                ? result.person.breakfastRemaining
                : result.mealType === "LUNCH"
                  ? result.person.lunchRemaining
                  : result.person.dinnerRemaining}
            </strong>
          </p>
        </>
      ) : (
        <>
          <p>
            {formatMealLabel(result.mealType)} tally: <strong>{tally}</strong>
          </p>
          <p>
            Total meals served: <strong>{result.person.totalMealsCount}</strong>
          </p>
        </>
      )}
    </div>
  );
}

function ScanPage() {
  const [result, setResult] = useState<ScanResultState>(null);
  const [pendingSelection, setPendingSelection] =
    useState<PendingCampMeetingSelection | null>(null);
  const [manual, setManual] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<"camera" | "usb">("camera");
  const [mealTrackingMode, setMealTrackingMode] =
    useState<MealTrackingMode>("camp_meeting");
  const [scanCooldownSeconds, setScanCooldownSeconds] = useState(1);
  const [scannerDiagnosticsEnabled, setScannerDiagnosticsEnabled] =
    useState(false);
  const [lastScannerError, setLastScannerError] = useState("");
  const usbInputRef = useRef<HTMLInputElement>(null);
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
    void api<Settings>("/settings").then((s) => {
      setMealTrackingMode(s.mealTrackingMode);
      setScanCooldownSeconds(
        Math.min(10, Math.max(0.5, s.scannerCooldownSeconds || 1)),
      );
      setScannerDiagnosticsEnabled(Boolean(s.scannerDiagnosticsEnabled));
    });
  }, []);

  useEffect(() => () => clearAutoSubmitTimeout(), []);

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
        setManual("");
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
        redeemedEntitlement: response.redeemedEntitlement,
      });
      setPendingSelection(null);
      setMealTrackingMode(response.mealTrackingMode);
      setLastScannerError("");
      setManual("");
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
      setManual("");
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
            USB Scanner / Manual ID Entry
          </button>
        </div>
        <p className="muted">
          For the fastest line, use camera scan when available. If needed,
          switch to USB Scanner / Manual ID Entry.
        </p>
        {mode === "camera" ? (
          <QrScanner
            cooldownMs={scanCooldownSeconds * 1000}
            diagnosticsEnabled={scannerDiagnosticsEnabled}
            selectedScannerMode={mode}
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
                onBlur={() => focusUsbInput()}
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
      <ScanResultCard result={result} />
    </div>
  );
}

type PersonRecord = {
  id: number;
  firstName: string;
  lastName: string;
  personId: string;
  codeValue: string;
  breakfastRemaining: number;
  lunchRemaining: number;
  dinnerRemaining: number;
  breakfastCount: number;
  lunchCount: number;
  dinnerCount: number;
  totalMealsCount: number;
  active?: boolean;
  grade?: string | null;
  group?: string | null;
  campus?: string | null;
  notes?: string | null;
  campMeetingEntitlements?: number;
  campMeetingRedeemed?: number;
  campMeetingRemaining?: number;
  breakfastTotal?: number;
  lunchTotal?: number;
  dinnerTotal?: number;
  breakfastAvailable?: number;
  lunchAvailable?: number;
  dinnerAvailable?: number;
  breakfastRedeemed?: number;
  lunchRedeemed?: number;
  dinnerRedeemed?: number;
  todayBreakfastAvailable?: number;
  todayLunchAvailable?: number;
  todayDinnerAvailable?: number;
  associatedNames?: string[];
  associatedNamesSummary?: string;
};

function PeoplePage() {
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [gradeFilter, setGradeFilter] = useState("ALL");
  const [settings, setSettings] = useState<{
    mealTrackingMode: MealTrackingMode;
  } | null>(null);
  const [form, setForm] = useState<Record<string, string | number | boolean>>({
    firstName: "",
    lastName: "",
    personId: "",
    codeValue: "",
    breakfastRemaining: 0,
    lunchRemaining: 0,
    dinnerRemaining: 0,
    breakfastCount: 0,
    lunchCount: 0,
    dinnerCount: 0,
    totalMealsCount: 0,
    active: true,
  });
  const [personToDelete, setPersonToDelete] = useState<PersonRecord | null>(
    null,
  );
  const [deletePhrase, setDeletePhrase] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = () =>
    api<PersonRecord[]>("/people?showInactive=true").then(setPeople);
  useEffect(() => {
    void load();
    void api<{ mealTrackingMode: MealTrackingMode }>("/settings").then(
      setSettings,
    );
  }, []);

  const isTally = settings?.mealTrackingMode === "tally";
  const isCampMeeting = settings?.mealTrackingMode === "camp_meeting";
  const isCountdown = settings?.mealTrackingMode === "countdown";

  async function addPerson(e: FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    const payload = isTally
      ? {
          ...form,
          breakfastRemaining: 0,
          lunchRemaining: 0,
          dinnerRemaining: 0,
        }
      : {
          ...form,
          breakfastCount: 0,
          lunchCount: 0,
          dinnerCount: 0,
          totalMealsCount: 0,
        };
    await api("/people", { method: "POST", body: JSON.stringify(payload) });
    await load();
  }

  async function savePerson(person: PersonRecord) {
    setError("");
    setMessage("");
    const payload = isTally
      ? {
          breakfastCount: person.breakfastCount,
          lunchCount: person.lunchCount,
          dinnerCount: person.dinnerCount,
          totalMealsCount:
            person.breakfastCount + person.lunchCount + person.dinnerCount,
        }
      : {
          breakfastRemaining: person.breakfastRemaining,
          lunchRemaining: person.lunchRemaining,
          dinnerRemaining: person.dinnerRemaining,
        };
    await api(`/people/${person.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    await load();
  }

  async function deletePerson() {
    if (!personToDelete || deletePhrase !== "DELETE USER") return;
    setIsDeleting(true);
    setError("");
    setMessage("");

    try {
      await api(`/people/${personToDelete.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmationPhrase: deletePhrase }),
      });
      setMessage(
        `Deleted ${personToDelete.firstName} ${personToDelete.lastName} (${personToDelete.personId}).`,
      );
      setPersonToDelete(null);
      setDeletePhrase("");
      await load();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete this person",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  const deleteEnabled = deletePhrase === "DELETE USER" && !isDeleting;
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const gradeOptions = useMemo(() => {
    const grades = Array.from(
      new Set(
        people.map((person) => (person.grade || "").trim()).filter(Boolean),
      ),
    );
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return grades.sort((a, b) => collator.compare(a, b));
  }, [people]);
  const filteredPeople = useMemo(
    () =>
      people.filter((person) => {
        const firstName = person.firstName.toLowerCase();
        const lastName = person.lastName.toLowerCase();
        const fullName = `${firstName} ${lastName}`.trim();
        const personId = person.personId.toLowerCase();
        const associatedNames = (
          person.associatedNamesSummary || ""
        ).toLowerCase();
        const matchesSearch =
          normalizedSearch.length === 0 ||
          firstName.includes(normalizedSearch) ||
          lastName.includes(normalizedSearch) ||
          fullName.includes(normalizedSearch) ||
          personId.includes(normalizedSearch) ||
          associatedNames.includes(normalizedSearch);
        const gradeValue = (person.grade || "").trim();
        const matchesGrade = isCampMeeting
          ? true
          : gradeFilter === "ALL" || gradeValue === gradeFilter;
        return matchesSearch && matchesGrade;
      }),
    [people, normalizedSearch, gradeFilter, isCampMeeting],
  );
  const hasAnyGrade = useMemo(
    () => people.some((person) => Boolean((person.grade || "").trim())),
    [people],
  );
  const noResultsColSpan =
    3 + (hasAnyGrade ? 1 : 0) + (isCampMeeting ? 12 : 4) + 1;
  const personDisplayName = (person: PersonRecord) => {
    if (isCampMeeting && person.associatedNamesSummary)
      return person.associatedNamesSummary;
    return `${person.firstName} ${person.lastName}`.trim() || person.personId;
  };

  return (
    <div className="card stack">
      <h2>People</h2>
      <p className="muted">
        Active mode:{" "}
        <strong>
          {modeLabel(settings?.mealTrackingMode || "camp_meeting")}
        </strong>
        .{" "}
        {isTally
          ? "Tally counters are editable in this mode."
          : isCountdown
            ? "Remaining balances are editable in this mode."
            : "Camp Meeting entitlement status is shown from imported CSV data. Today B/L/D are based on the current local day-of-week."}
      </p>
      {message && <p>{message}</p>}
      {error && <p className="error">{error}</p>}
      <form
        className="grid-form grid-form-people"
        onSubmit={(e) => void addPerson(e)}
      >
        {[
          "firstName",
          "lastName",
          "personId",
          "codeValue",
          "grade",
          "group",
          "campus",
        ].map((k) => (
          <input
            key={k}
            placeholder={k}
            value={String(form[k] || "")}
            onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          />
        ))}
        <button className="primary add-person-btn">Add</button>
      </form>
      <div className="filters-row people-filters">
        <label>
          Search people
          <input
            type="search"
            placeholder="Search by first name, last name, full name, or ID"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </label>
        {!isCampMeeting && (
          <label>
            Grade
            <select
              value={gradeFilter}
              onChange={(e) => setGradeFilter(e.target.value)}
            >
              <option value="ALL">All Grades</option>
              {gradeOptions.map((grade) => (
                <option key={grade} value={grade}>
                  {grade}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setSearchTerm("");
            setGradeFilter("ALL");
          }}
          disabled={
            searchTerm.trim().length === 0 &&
            (isCampMeeting || gradeFilter === "ALL")
          }
        >
          Clear
        </button>
      </div>
      <div className="table-scroll">
        <table className="people-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Person ID</th>
              {hasAnyGrade && <th>Grade</th>}
              {isCampMeeting ? (
                <>
                  <th>B</th>
                  <th>L</th>
                  <th>D</th>
                  <th>B Av</th>
                  <th>L Av</th>
                  <th>D Av</th>
                  <th>B Rd</th>
                  <th>L Rd</th>
                  <th>D Rd</th>
                  <th>Today B</th>
                  <th>Today L</th>
                  <th>Today D</th>
                </>
              ) : isCountdown ? (
                <>
                  <th>Breakfast Remaining</th>
                  <th>Lunch Remaining</th>
                  <th>Dinner Remaining</th>
                </>
              ) : (
                <>
                  <th>Breakfast Count</th>
                  <th>Lunch Count</th>
                  <th>Dinner Count</th>
                  <th>Total</th>
                </>
              )}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredPeople.length > 0 ? (
              filteredPeople.map((p) => (
                <tr key={p.id}>
                  <td>{personDisplayName(p)}</td>
                  <td>{p.personId}</td>
                  {hasAnyGrade && <td>{(p.grade || "").trim() || null}</td>}
                  {isCampMeeting ? (
                    <>
                      <td>{p.breakfastTotal ?? 0}</td>
                      <td>{p.lunchTotal ?? 0}</td>
                      <td>{p.dinnerTotal ?? 0}</td>
                      <td>{p.breakfastAvailable ?? 0}</td>
                      <td>{p.lunchAvailable ?? 0}</td>
                      <td>{p.dinnerAvailable ?? 0}</td>
                      <td>{p.breakfastRedeemed ?? 0}</td>
                      <td>{p.lunchRedeemed ?? 0}</td>
                      <td>{p.dinnerRedeemed ?? 0}</td>
                      <td>{p.todayBreakfastAvailable ?? 0}</td>
                      <td>{p.todayLunchAvailable ?? 0}</td>
                      <td>{p.todayDinnerAvailable ?? 0}</td>
                    </>
                  ) : isCountdown ? (
                    <>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.breakfastRemaining}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      breakfastRemaining: Number(
                                        e.target.value,
                                      ),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.lunchRemaining}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      lunchRemaining: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.dinnerRemaining}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      dinnerRemaining: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.breakfastCount}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      breakfastCount: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.lunchCount}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      lunchCount: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.dinnerCount}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      dinnerCount: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>{p.breakfastCount + p.lunchCount + p.dinnerCount}</td>
                    </>
                  )}
                  <td>
                    <div className="people-actions">
                      {!isCampMeeting && (
                        <button
                          className="small"
                          type="button"
                          onClick={() => void savePerson(p)}
                        >
                          Save
                        </button>
                      )}
                      {isTally && (
                        <button
                          className="small secondary"
                          type="button"
                          onClick={() =>
                            void api(`/people/reset-tallies/${p.id}`, {
                              method: "POST",
                            }).then(load)
                          }
                        >
                          Reset
                        </button>
                      )}
                      <button
                        className="small danger"
                        type="button"
                        onClick={() => {
                          setPersonToDelete(p);
                          setDeletePhrase("");
                          setError("");
                          setMessage("");
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="muted" colSpan={noResultsColSpan}>
                  No people match your current{" "}
                  {isCampMeeting ? "search" : "search and grade filters"}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {personToDelete && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-modal stack">
            <h4>Confirm Person Deletion</h4>
            <p>
              You are deleting{" "}
              <strong>{personDisplayName(personToDelete)}</strong>.
            </p>
            <p>
              Person ID: <strong>{personToDelete.personId}</strong>
            </p>
            <p className="error">
              Warning: This permanently removes this person and their related
              scan transaction history. This cannot be easily undone.
            </p>
            <p>
              Type <code>DELETE USER</code> to enable deletion.
            </p>
            <input
              value={deletePhrase}
              onChange={(e) => setDeletePhrase(e.target.value)}
              placeholder="DELETE USER"
            />
            <div className="button-row">
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setPersonToDelete(null);
                  setDeletePhrase("");
                }}
              >
                Cancel
              </button>
              <button
                className="danger"
                type="button"
                disabled={!deleteEnabled}
                onClick={() => void deletePerson()}
              >
                {isDeleting ? "Deleting…" : "Delete Person"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ImportPage() {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<any>();
  const [result, setResult] = useState<any>();
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [settings, setSettings] = useState<{
    mealTrackingMode: MealTrackingMode;
  } | null>(null);

  useEffect(() => {
    void api<{ mealTrackingMode: MealTrackingMode }>("/settings").then(
      setSettings,
    );
  }, []);

  const isCampMeeting = settings?.mealTrackingMode === "camp_meeting";

  async function parseJsonOrThrow(res: Response) {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : "Import request failed";
      throw new Error(message);
    }

    return payload;
  }

  async function previewFile() {
    if (!file) return;

    setError("");
    setResult(undefined);

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_BASE}/import/preview`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      setPreview(await parseJsonOrThrow(res));
    } catch (previewError) {
      setPreview(undefined);
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Unable to preview import file.",
      );
    }
  }

  async function commit() {
    if (!file || isSubmitting) return;

    const form = new FormData();
    form.append("file", file);
    if (isCampMeeting) {
      const confirmed = window.confirm(
        "Replace existing Camp Meeting entitlements with this upload?",
      );
      if (!confirmed) return;
      form.append("replaceExisting", "true");
    } else {
      form.append("generateMissingCodes", "true");
    }

    setIsSubmitting(true);
    setError("");
    setResult(undefined);

    try {
      const res = await fetch(`${API_BASE}/import/commit`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      setResult(await parseJsonOrThrow(res));
    } catch (commitError) {
      setError(
        commitError instanceof Error
          ? commitError.message
          : "Unable to import CSV.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="card stack">
      <h2>{isCampMeeting ? "Camp Meeting Import" : "CSV Import"}</h2>
      <div className="button-row">
        <ButtonLink
          href={`${API_BASE}/import/template`}
          className="btn-secondary"
          target="_blank"
          rel="noreferrer"
        >
          Download Template
        </ButtonLink>
      </div>
      <input
        type="file"
        accept=".csv"
        onChange={(e) => setFile(e.target.files?.[0])}
      />
      <div className="button-row">
        <button
          className="secondary"
          onClick={previewFile}
          disabled={!file || isSubmitting}
        >
          Preview
        </button>
        <button
          className="primary"
          onClick={commit}
          disabled={!file || isSubmitting}
        >
          {isSubmitting
            ? "Importing…"
            : isCampMeeting
              ? "Upload Camp Meeting CSV"
              : "Commit Partial Import"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {preview && <pre>{JSON.stringify(preview, null, 2)}</pre>}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}

function BadgesPage() {
  const [people, setPeople] = useState<any[]>([]);
  const [codeType, setCodeType] = useState<BadgeCodeType>(() => {
    const stored = window.localStorage.getItem(BADGE_CODE_TYPE_STORAGE_KEY);
    return stored === "barcode" || stored === "qr" || stored === "auto" ? stored : "barcode";
  });

  useEffect(() => {
    void api<any[]>("/people?showInactive=true").then(setPeople);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(BADGE_CODE_TYPE_STORAGE_KEY, codeType);
  }, [codeType]);

  return (
    <div className="card">
      <h2>Printable Badges</h2>
      <div className="button-row">
        <label>
          Code Type
          <select value={codeType} onChange={(e) => setCodeType(e.target.value as BadgeCodeType)}>
            <option value="barcode">Barcode (Code 128)</option>
            <option value="qr">QR Code</option>
            <option value="auto">Auto (recommended)</option>
          </select>
        </label>
        <button className="secondary" onClick={() => window.print()}>
          Print Sheet
        </button>
      </div>
      <div className="badge-grid">
        {people.map((p) => {
          const codeValue = p.personId;
          const resolvedType = resolveBadgeCodeType(codeType, codeValue);
          return (
            <div className="badge" key={p.id}>
              <div className="badge-code" aria-label={`${resolvedType} code`}>
                {resolvedType === "qr" ? (
                  <QRCodeSVG value={codeValue} size={120} fgColor="#000000" bgColor="#ffffff" />
                ) : (
                  <BarcodeSvg value={codeValue} width={150} height={54} />
                )}
              </div>
              <p>
                {p.firstName} {p.lastName}
              </p>
              <small>{codeValue}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function TransactionsPage() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    void api<any[]>("/transactions").then(setRows);
  }, []);
  return (
    <div className="card stack">
      <h2>Transactions</h2>
      <div className="button-row">
        <ButtonLink
          href={`${API_BASE}/transactions/export.csv`}
          className="btn-secondary"
          target="_blank"
          rel="noreferrer"
        >
          Export CSV
        </ButtonLink>
      </div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Value</th>
            <th>Meal</th>
            <th>Result</th>
            <th>Reason</th>
            <th>Person</th>
            <th>Station</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.timestamp).toLocaleString()}</td>
              <td>{r.scannedValue}</td>
              <td>{r.mealType}</td>
              <td>{r.result}</td>
              <td>{r.failureReason || "-"}</td>
              <td>
                {r.entitlementPersonName ||
                  (r.person
                    ? `${r.person.firstName} ${r.person.lastName}`
                    : "-")}
              </td>
              <td>{r.stationName || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportsPage() {
  const todayRange = useMemo(() => getRangeForPreset("today"), []);
  const [fromDate, setFromDate] = useState(todayRange.from);
  const [toDate, setToDate] = useState(todayRange.to);
  const [appliedFromDate, setAppliedFromDate] = useState(todayRange.from);
  const [appliedToDate, setAppliedToDate] = useState(todayRange.to);
  const [activePreset, setActivePreset] = useState<
    "custom" | "today" | "last7" | "week" | "month" | "year"
  >("today");
  const [report, setReport] = useState<ReportsSummaryResponse | null>(null);
  const [error, setError] = useState("");

  async function loadReport(range?: { from: string; to: string }) {
    const selectedRange = range ?? { from: fromDate, to: toDate };
    try {
      const query = new URLSearchParams({
        from: selectedRange.from,
        to: selectedRange.to,
        startDate: selectedRange.from,
        endDate: selectedRange.to,
      });
      const data = await api<ReportsSummaryResponse>(
        `/reports/summary?${query.toString()}`,
      );
      setReport(data);
      setAppliedFromDate(selectedRange.from);
      setAppliedToDate(selectedRange.to);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load report",
      );
    }
  }

  function applyPreset(preset: "today" | "last7" | "week" | "month" | "year") {
    const range = getRangeForPreset(preset);
    setFromDate(range.from);
    setToDate(range.to);
    setActivePreset(preset);
  }

  useEffect(() => {
    void loadReport();
  }, []);

  const mealTotals = report?.mealTotalsByPerson ?? report?.perPersonUsage ?? [];
  const exportQuery = new URLSearchParams({
    from: appliedFromDate,
    to: appliedToDate,
    startDate: appliedFromDate,
    endDate: appliedToDate,
  }).toString();

  return (
    <div className="card stack">
      <h2>Reports</h2>
      <div className="stack report-controls">
        <div className="button-row">
          <button
            type="button"
            className={activePreset === "today" ? "primary" : "secondary"}
            onClick={() => applyPreset("today")}
          >
            Today
          </button>
          <button
            type="button"
            className={activePreset === "last7" ? "primary" : "secondary"}
            onClick={() => applyPreset("last7")}
          >
            Last 7 Days
          </button>
          <button
            type="button"
            className={activePreset === "week" ? "primary" : "secondary"}
            onClick={() => applyPreset("week")}
          >
            Current Week
          </button>
          <button
            type="button"
            className={activePreset === "month" ? "primary" : "secondary"}
            onClick={() => applyPreset("month")}
          >
            Current Month
          </button>
          <button
            type="button"
            className={activePreset === "year" ? "primary" : "secondary"}
            onClick={() => applyPreset("year")}
          >
            Current Year
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setActivePreset("custom")}
            disabled={activePreset === "custom"}
          >
            Custom Range
          </button>
        </div>
        <div className="filters-row">
          <label>
            From{" "}
            <input
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setActivePreset("custom");
              }}
            />
          </label>
          <label>
            To{" "}
            <input
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setActivePreset("custom");
              }}
            />
          </label>
          <button
            className="primary"
            type="button"
            onClick={() => void loadReport()}
          >
            Apply Filter
          </button>
          <ButtonLink
            className="btn-secondary"
            href={`${API_BASE}/reports/export.csv?${exportQuery}`}
            target="_blank"
            rel="noreferrer"
          >
            Export Transactions CSV
          </ButtonLink>
          <ButtonLink
            className="btn-secondary"
            href={`${API_BASE}/reports/meal-totals.csv?${exportQuery}`}
            target="_blank"
            rel="noreferrer"
          >
            Export Meal Totals CSV
          </ButtonLink>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {report && (
        <>
          <p className="muted">
            Active mode: <strong>{modeLabel(report.mealTrackingMode)}</strong>
          </p>
          <div className="stats-grid">
            <div className="stat-card">
              <p className="muted">Scans</p>
              <p className="value">{report.stats.scans}</p>
            </div>
            <div className="stat-card">
              <p className="muted">Failed Scans</p>
              <p className="value">{report.stats.failedScans}</p>
            </div>
            {report.mealTrackingMode === "camp_meeting" ? (
              <>
                <div className="stat-card">
                  <p className="muted">Total Entitlements</p>
                  <p className="value">
                    {report.entitlementSummary.totalEntitlements}
                  </p>
                </div>
                <div className="stat-card">
                  <p className="muted">Total Redeemed</p>
                  <p className="value">
                    {report.entitlementSummary.totalRedeemed}
                  </p>
                </div>
                <div className="stat-card">
                  <p className="muted">Unused Entitlements</p>
                  <p className="value">
                    {report.entitlementSummary.totalRemaining}
                  </p>
                </div>
              </>
            ) : report.mealTrackingMode === "countdown" ? (
              <>
                <div className="stat-card">
                  <p className="muted">Breakfast Remaining</p>
                  <p className="value">
                    {report.remainingBalanceSummary.breakfastRemaining}
                  </p>
                </div>
                <div className="stat-card">
                  <p className="muted">Lunch Remaining</p>
                  <p className="value">
                    {report.remainingBalanceSummary.lunchRemaining}
                  </p>
                </div>
                <div className="stat-card">
                  <p className="muted">Dinner Remaining</p>
                  <p className="value">
                    {report.remainingBalanceSummary.dinnerRemaining}
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="stat-card">
                  <p className="muted">Breakfast Tally</p>
                  <p className="value">{report.tallySummary.breakfastCount}</p>
                </div>
                <div className="stat-card">
                  <p className="muted">Lunch Tally</p>
                  <p className="value">{report.tallySummary.lunchCount}</p>
                </div>
                <div className="stat-card">
                  <p className="muted">Dinner Tally</p>
                  <p className="value">{report.tallySummary.dinnerCount}</p>
                </div>
                <div className="stat-card">
                  <p className="muted">Total Meals Tallied</p>
                  <p className="value">{report.tallySummary.totalMealsCount}</p>
                </div>
              </>
            )}
          </div>
          <section className="stack">
            <h3>Meal Totals by Person</h3>
            {mealTotals.length === 0 ? (
              <p className="muted">
                No meals found for the selected date range.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Person ID</th>
                    <th>Total Meals</th>
                    <th>Breakfast</th>
                    <th>Lunch</th>
                    <th>Dinner</th>
                  </tr>
                </thead>
                <tbody>
                  {mealTotals.map((row) => (
                    <tr key={row.personId}>
                      <td>
                        {row.firstName} {row.lastName}
                      </td>
                      <td>{row.personId}</td>
                      <td>{row.total}</td>
                      <td>{row.breakfasts}</td>
                      <td>{row.lunches}</td>
                      <td>{row.dinners}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SettingsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<Settings>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [clearPhrase, setClearPhrase] = useState("");
  const [clearAction, setClearAction] = useState<
    "clear-meal-data" | "clear-people-import-data" | "reset-meal-tracking-data"
  >("reset-meal-tracking-data");
  const [showClearModal, setShowClearModal] = useState(false);
  const [isClearingDatabase, setIsClearingDatabase] = useState(false);
  const [showModeConfirm, setShowModeConfirm] = useState(false);
  const [modePhrase, setModePhrase] = useState("");
  const [pendingMode, setPendingMode] = useState<MealTrackingMode | null>(null);
  const [showFullWipeConfirm, setShowFullWipeConfirm] = useState(false);
  const [fullWipePhrase, setFullWipePhrase] = useState("");
  const [fullWipeResult, setFullWipeResult] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);
  const [isSyncingSheet, setIsSyncingSheet] = useState(false);
  const [isWritingBackSheet, setIsWritingBackSheet] = useState(false);
  const [isSavingGoogleSheetsSettings, setIsSavingGoogleSheetsSettings] = useState(false);
  const [isRunningScheduledCheckNow, setIsRunningScheduledCheckNow] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState<GoogleSheetsSchedulerStatus | null>(null);
  const [savedGoogleSheetsSettings, setSavedGoogleSheetsSettings] = useState<{
    googleSheetsEnabled: boolean;
    googleSheetId: string;
    googleSheetTabName: string;
    googleSyncIntervalMinutes: number;
  } | null>(null);

  const load = async () => {
    const loaded = await api<Settings>("/settings");
    setSettings(normalizeSettingsForTimeAndTimezone(loaded));
    setSavedGoogleSheetsSettings({
      googleSheetsEnabled: loaded.googleSheetsEnabled,
      googleSheetId: loaded.googleSheetId ?? "",
      googleSheetTabName: loaded.googleSheetTabName,
      googleSyncIntervalMinutes: loaded.googleSyncIntervalMinutes,
    });
    if (user?.role === "OWNER" || user?.role === "ADMIN") {
      const status = await api<GoogleSheetsSchedulerStatus>("/settings/google-sheets/scheduler-status");
      setSchedulerStatus(status);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!settings) return <p>Loading...</p>;

  const clearEnabled =
    clearPhrase === "RESET MEAL TRACKING DATA" && !isClearingDatabase;
  const modeEnabled = modePhrase === "SWITCH MODE";
  const fullWipeEnabled = fullWipePhrase === "ARM FULL WIPE";
  const isOwner = user?.role === "OWNER";
  const canManageGoogleSheets = user?.role === "OWNER" || user?.role === "ADMIN";
  const isCampMeetingMode = settings.mealTrackingMode === "camp_meeting";
  const isGoogleSheetsSyncEnabled = settings.googleSheetsEnabled;
  const hasGoogleSheetId = Boolean(settings.googleSheetId?.trim());
  const hasUnsavedGoogleSheetsChanges =
    !!savedGoogleSheetsSettings &&
    (settings.googleSheetsEnabled !== savedGoogleSheetsSettings.googleSheetsEnabled ||
      (settings.googleSheetId ?? "") !== savedGoogleSheetsSettings.googleSheetId ||
      settings.googleSheetTabName !== savedGoogleSheetsSettings.googleSheetTabName ||
      settings.googleSyncIntervalMinutes !== savedGoogleSheetsSettings.googleSyncIntervalMinutes);

  async function saveSettings(settingsOverride?: Settings, successMessage = "Settings saved.") {
    const sourceSettings = settingsOverride ?? settings;
    if (!sourceSettings) return null;
    const normalized = normalizeSettingsForTimeAndTimezone(sourceSettings);
    setError("");
    const payload = Object.fromEntries(
      Object.entries(normalized).filter(
        ([key]) =>
          ![
            "id",
            "updatedAt",
            "mealTrackingMode",
            "fullWipeTokenHash",
            "fullWipeTokenExpiresAt",
            "fullWipeTokenUsedAt",
            "fullWipeArmedByUserId",
          ].includes(key),
      ),
    );
    const saved = normalizeSettingsForTimeAndTimezone(
      await api<Settings>("/settings", { method: "PUT", body: JSON.stringify(payload) }),
    );
    setMessage(successMessage);
    setSettings(saved);
    setSavedGoogleSheetsSettings({
      googleSheetsEnabled: saved.googleSheetsEnabled,
      googleSheetId: saved.googleSheetId ?? "",
      googleSheetTabName: saved.googleSheetTabName,
      googleSyncIntervalMinutes: saved.googleSyncIntervalMinutes,
    });
    return saved;
  }

  async function saveGoogleSheetsSettings(settingsOverride?: Settings) {
    setIsSavingGoogleSheetsSettings(true);
    try {
      return await saveSettings(settingsOverride, "Google Sheets settings saved.");
    } finally {
      setIsSavingGoogleSheetsSettings(false);
    }
  }

  async function clearOperationalData() {
    if (!clearEnabled) return;
    setIsClearingDatabase(true);
    setError("");
    setMessage("");
    try {
      await api(`/system/${clearAction}`, { method: "POST" });
      setMessage("Operation completed successfully.");
      setShowClearModal(false);
      setClearPhrase("");
      await load();
    } catch (clearError) {
      setError(
        clearError instanceof Error
          ? clearError.message
          : "Unable to clear data.",
      );
    } finally {
      setIsClearingDatabase(false);
    }
  }

  async function armFullWipe() {
    if (!fullWipeEnabled) return;
    setError("");
    setMessage("");
    const response = await api<{ token: string; expiresAt: string }>(
      "/settings/full-wipe/arm",
      {
        method: "POST",
        body: JSON.stringify({ confirmationPhrase: fullWipePhrase }),
      },
    );
    setFullWipeResult(response);
    setShowFullWipeConfirm(false);
    setFullWipePhrase("");
  }

  return (
    <div className="card stack">
      <h2>Settings</h2>
      {message && <p>{message}</p>}
      {error && <p className="error">{error}</p>}

      <section className="card stack">
        <h3>Meal Tracking Mode</h3>
        <p className="muted">
          Current active mode: <strong>{modeLabel(settings.mealTrackingMode)}</strong>
        </p>
        <label>
          Meal tracking mode
          <select
            value={settings.mealTrackingMode}
            onChange={(e) => {
              const selected = e.target.value as MealTrackingMode;
              if (selected === settings.mealTrackingMode) return;
              setPendingMode(selected);
              setShowModeConfirm(true);
              setModePhrase("");
            }}
          >
            <option value="camp_meeting">
              Camp Meeting (redeem imported meal entitlements)
            </option>
            <option value="countdown">
              Count Down (deduct from remaining balances)
            </option>
            <option value="tally">Tally Up (count each served meal)</option>
          </select>
        </label>
        <p className="error">
          Warning: Switching mode is destructive and will clear all people,
          transaction history, import history, and meal entitlements.
        </p>
      </section>

      <section className="card stack">
        <h3>Scanner Settings</h3>
        <label>
          Scanner cooldown (seconds)
          <input
            type="number"
            min={0.5}
            max={10}
            step={0.5}
            value={settings.scannerCooldownSeconds}
            onChange={(e) =>
              setSettings({ ...settings, scannerCooldownSeconds: Number(e.target.value) })
            }
          />
        </label>
        <label>
          Station name
          <input
            value={settings.stationName}
            onChange={(e) => setSettings({ ...settings, stationName: e.target.value })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.scannerDiagnosticsEnabled}
            onChange={(e) =>
              setSettings({ ...settings, scannerDiagnosticsEnabled: e.target.checked })
            }
          />
          Enable scanner diagnostics
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.enableSounds}
            onChange={(e) => setSettings({ ...settings, enableSounds: e.target.checked })}
          />
          Enable scan sounds
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.allowManualMealOverride}
            onChange={(e) =>
              setSettings({ ...settings, allowManualMealOverride: e.target.checked })
            }
          />
          Allow manual meal override
        </label>
      </section>

      <section className="card stack">
        <h3>General Settings</h3>
        <label>
          School name
          <input
            value={settings.schoolName}
            onChange={(e) => setSettings({ ...settings, schoolName: e.target.value })}
          />
        </label>
        <label>
          Timezone
          <select
            value={settings.timezone}
            onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          Your browser may display AM/PM, but values are saved as 24-hour HH:mm.
        </p>
        <label>
          Breakfast start
          <input
            type="time"
            value={settings.breakfastStart}
            onChange={(e) => setSettings({ ...settings, breakfastStart: e.target.value })}
          />
          <small className="muted">Stored value: {renderStoredTimeValue(settings.breakfastStart)}</small>
        </label>
        <label>
          Breakfast end
          <input
            type="time"
            value={settings.breakfastEnd}
            onChange={(e) => setSettings({ ...settings, breakfastEnd: e.target.value })}
          />
          <small className="muted">Stored value: {renderStoredTimeValue(settings.breakfastEnd)}</small>
        </label>
        <label>
          Lunch start
          <input
            type="time"
            value={settings.lunchStart}
            onChange={(e) => setSettings({ ...settings, lunchStart: e.target.value })}
          />
          <small className="muted">Stored value: {renderStoredTimeValue(settings.lunchStart)}</small>
        </label>
        <label>
          Lunch end
          <input
            type="time"
            value={settings.lunchEnd}
            onChange={(e) => setSettings({ ...settings, lunchEnd: e.target.value })}
          />
          <small className="muted">Stored value: {renderStoredTimeValue(settings.lunchEnd)}</small>
        </label>
        <label>
          Dinner start
          <input
            type="time"
            value={settings.dinnerStart}
            onChange={(e) => setSettings({ ...settings, dinnerStart: e.target.value })}
          />
          <small className="muted">Stored value: {renderStoredTimeValue(settings.dinnerStart)}</small>
        </label>
        <label>
          Dinner end
          <input
            type="time"
            value={settings.dinnerEnd}
            onChange={(e) => setSettings({ ...settings, dinnerEnd: e.target.value })}
          />
          <small className="muted">Stored value: {renderStoredTimeValue(settings.dinnerEnd)}</small>
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.hideInactiveByDefault}
            onChange={(e) =>
              setSettings({ ...settings, hideInactiveByDefault: e.target.checked })
            }
          />
          Hide inactive people by default
        </label>
        <button type="button" className="primary" onClick={() => void saveSettings()}>
          Save Settings
        </button>
      </section>

      {canManageGoogleSheets ? (
        <section className="card stack">
          <h3>Google Sheets Sync</h3>
          <>
              <label>
                <input
                  type="checkbox"
                  checked={settings.googleSheetsEnabled}
                  onChange={(e) =>
                    setSettings({ ...settings, googleSheetsEnabled: e.target.checked })
                  }
                />
                Enable Google Sheets Sync
              </label>
              <label>
                Google Sheet URL or Sheet ID
                <input
                  value={settings.googleSheetId ?? ""}
                  onChange={(e) => setSettings({ ...settings, googleSheetId: e.target.value })}
                />
              </label>
              <p className="muted">
                Share your Google Sheet with the service account email, then paste the sheet URL here.
              </p>
              <p className="muted">
                Expected columns: {isCampMeetingMode ? "ticket_id, reg_id, guest_name, meal_type, meal_day, meal_date, ticket_type, price, redeemed, redeemed_at, redeemed_by, notes" : "ID, Name, Breakfast, Lunch, Dinner, Total"}
              </p>
              <label>
                Worksheet / Tab Name
                <input
                  value={settings.googleSheetTabName}
                  onChange={(e) =>
                    setSettings({ ...settings, googleSheetTabName: e.target.value || "Sheet1" })
                  }
                />
              </label>
              <label>
                Sync interval (minutes)
                <input
                  type="number"
                  min={1}
                  value={settings.googleSyncIntervalMinutes}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      googleSyncIntervalMinutes: Math.max(1, Number(e.target.value) || 5),
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="primary"
                disabled={isSavingGoogleSheetsSettings}
                onClick={() => {
                  setMessage("");
                  setError("");
                  void saveGoogleSheetsSettings();
                }}
              >
                {isSavingGoogleSheetsSettings
                  ? "Saving Google Sheets Settings…"
                  : "Save Google Sheets Settings"}
              </button>
              {!hasGoogleSheetId ? (
                <p className="muted">Enter and save a Google Sheet URL or Sheet ID first.</p>
              ) : null}
          </>
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => window.open("/api/import/template", "_blank")}>
              Download Template
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                !isGoogleSheetsSyncEnabled ||
                isSyncingSheet ||
                isSavingGoogleSheetsSettings ||
                !hasGoogleSheetId
              }
              onClick={() => {
                setMessage("");
                setError("");
                setIsSyncingSheet(true);
                const settingsToSave = settings;
                const savePromise = hasUnsavedGoogleSheetsChanges
                  ? saveGoogleSheetsSettings(settingsToSave)
                  : Promise.resolve(settingsToSave);
                void savePromise
                  .then(async (saved) => {
                    if (!saved) return;
                    if (!saved.googleSheetId?.trim()) {
                      throw new Error("Save Google Sheets settings before importing.");
                    }
                    const result = await api<{
                      peopleCreated: number; peopleUpdated: number; rowsImported: number; rowsSkipped: number; writeBackRowsUpdated: number; errors: string[];
                    }>(
                      "/import/google-sheet/import",
                      { method: "POST" },
                    );
                    const importedCount = result.peopleCreated + result.peopleUpdated;
                    const errorSuffix = result.errors.length
                      ? ` Reason: ${result.errors.join(" | ")}`
                      : "";
                    if (importedCount === 0) {
                      setError(`Imported 0 rows (${result.rowsSkipped} skipped).${errorSuffix || " Reason: no valid rows"}`);
                    } else {
                      setMessage(`Imported ${importedCount} rows (${result.rowsSkipped} skipped).${errorSuffix}`);
                    }
                  })
                  .catch((syncError) => {
                    if (syncError instanceof ApiNetworkError) {
                      setError(`Google Sheet import failed: could not reach backend (${syncError.message}).`);
                      return;
                    }
                    setError(syncError instanceof Error ? syncError.message : "Google Sheet import failed.");
                  })
                  .finally(() => setIsSyncingSheet(false));
              }}
            >
              Import from Google Sheet
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                !isGoogleSheetsSyncEnabled ||
                isWritingBackSheet ||
                isSavingGoogleSheetsSettings ||
                !hasGoogleSheetId
              }
              onClick={() => {
                setMessage("");
                setError("");
                setIsWritingBackSheet(true);
                const settingsToSave = settings;
                const savePromise = hasUnsavedGoogleSheetsChanges
                  ? saveGoogleSheetsSettings(settingsToSave)
                  : Promise.resolve(settingsToSave);
                void savePromise
                  .then(() =>
                    api("/import/google-sheet/write-back-now", { method: "POST" }),
                  )
                  .then(() => setMessage("Wrote back current mode data to Google Sheet."))
                  .catch((syncError) =>
                    setError(syncError instanceof Error ? syncError.message : "Google Sheet write-back failed."),
                  )
                  .finally(() => setIsWritingBackSheet(false));
              }}
            >
              Write Back to Google Sheet
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                !isGoogleSheetsSyncEnabled ||
                isRunningScheduledCheckNow ||
                isSavingGoogleSheetsSettings ||
                !hasGoogleSheetId
              }
              onClick={() => {
                setMessage("");
                setError("");
                setIsRunningScheduledCheckNow(true);
                void api<{ ran: boolean; rowsUpdated?: number; reason?: string }>("/settings/google-sheets/run-scheduled-check-now", { method: "POST" })
                  .then((result) => {
                    if (!result.ran) {
                      setMessage(`Scheduled check skipped: ${result.reason ?? "unknown reason"}.`);
                    } else {
                      setMessage(`Scheduled check completed: ${result.rowsUpdated ?? 0} rows updated.`);
                    }
                    return api<GoogleSheetsSchedulerStatus>("/settings/google-sheets/scheduler-status");
                  })
                  .then((status) => setSchedulerStatus(status))
                  .catch((syncError) =>
                    setError(syncError instanceof Error ? syncError.message : "Scheduled check failed."),
                  )
                  .finally(() => setIsRunningScheduledCheckNow(false));
              }}
            >
              Run Scheduled Check Now
            </button>
          </div>
          <section className="card stack">
            <h4>Google Sheets Sync Status</h4>
            <p><strong>Scheduler:</strong> {schedulerStatus?.schedulerEnabled ? "Enabled" : "Disabled"}</p>
            <p><strong>Last automatic check:</strong> {schedulerStatus?.lastAutomaticCheckTime ? new Date(schedulerStatus.lastAutomaticCheckTime).toLocaleString() : "Never"}</p>
            <p><strong>Last automatic write-back:</strong> {schedulerStatus?.lastAutomaticWriteBackTime ? new Date(schedulerStatus.lastAutomaticWriteBackTime).toLocaleString() : "Never"}</p>
            <p><strong>Last skip reason:</strong> {schedulerStatus?.lastSkipReason ?? "None"}</p>
            <p><strong>Last rows updated:</strong> {schedulerStatus?.lastRowsUpdated ?? 0}</p>
            <p><strong>Next expected run:</strong> {schedulerStatus?.nextExpectedRunTime ? new Date(schedulerStatus.nextExpectedRunTime).toLocaleString() : "Unknown"}</p>
          </section>
        </section>
      ) : null}

      <section className="card stack">
        <h3>Data Reset Tools</h3>
        <label>
          Reset action
          <select
            value={clearAction}
            onChange={(e) =>
              setClearAction(
                e.target.value as
                  | "clear-meal-data"
                  | "clear-people-import-data"
                  | "reset-meal-tracking-data",
              )
            }
          >
            <option value="clear-meal-data">Clear meal data only</option>
            <option value="clear-people-import-data">Clear people/import data</option>
            <option value="reset-meal-tracking-data">Reset all meal tracking data</option>
          </select>
        </label>
        <button type="button" className="danger" onClick={() => setShowClearModal(true)}>
          Run Reset Tool
        </button>
      </section>

      {isOwner && (
        <section className="card stack">
          <h3>Full Application Wipe (OWNER only)</h3>
          <p className="error">
            Arms a one-time wipe token for use by protected backend wipe endpoint.
          </p>
          <button
            type="button"
            className="danger"
            onClick={() => {
              setFullWipeResult(null);
              setShowFullWipeConfirm(true);
            }}
          >
            Arm Full Wipe Token
          </button>
          {fullWipeResult && (
            <div className="stack">
              <p>
                <strong>One-time token:</strong> <code>{fullWipeResult.token}</code>
              </p>
              <p className="muted">
                Expires at: {new Date(fullWipeResult.expiresAt).toLocaleString()}
              </p>
            </div>
          )}
        </section>
      )}

      {showModeConfirm && pendingMode && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-modal stack">
            <h4>Confirm Mode Switch</h4>
            <p>
              You are switching from <strong>{modeLabel(settings.mealTrackingMode)}</strong> to{' '}
              <strong>{modeLabel(pendingMode)}</strong>.
            </p>
            <p className="error">
              This will permanently clear operational data (people, scans, imports).
              Accounts and settings will be preserved.
            </p>
            <p>
              Type <code>SWITCH MODE</code> to continue.
            </p>
            <input
              value={modePhrase}
              onChange={(e) => setModePhrase(e.target.value)}
              placeholder="SWITCH MODE"
            />
            <div className="button-row">
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setShowModeConfirm(false);
                  setPendingMode(null);
                  setModePhrase("");
                }}
              >
                Cancel
              </button>
              <button
                className="danger"
                type="button"
                disabled={!modeEnabled}
                onClick={() => {
                  void api("/settings/meal-tracking-mode", {
                    method: "PUT",
                    body: JSON.stringify({
                      mealTrackingMode: pendingMode,
                      confirmationPhrase: modePhrase,
                    }),
                  }).then(async () => {
                    setMessage(
                      `Meal tracking mode switched to ${modeLabel(pendingMode)}. Operational data was cleared.`,
                    );
                    setError("");
                    setShowModeConfirm(false);
                    setPendingMode(null);
                    setModePhrase("");
                    await load();
                  });
                }}
              >
                Switch Mode + Clear Data
              </button>
            </div>
          </div>
        </div>
      )}

      {showClearModal && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-modal stack">
            <h4>Confirm Data Reset</h4>
            <p>
              Type <code>RESET MEAL TRACKING DATA</code> to continue.
            </p>
            <input
              value={clearPhrase}
              onChange={(e) => setClearPhrase(e.target.value)}
              placeholder="RESET MEAL TRACKING DATA"
            />
            <div className="button-row">
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setShowClearModal(false);
                  setClearPhrase("");
                }}
              >
                Cancel
              </button>
              <button
                className="danger"
                type="button"
                disabled={!clearEnabled}
                onClick={() => void clearOperationalData()}
              >
                Confirm Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {showFullWipeConfirm && isOwner && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-modal stack">
            <h4>Arm Full Application Wipe</h4>
            <p>
              Type <code>ARM FULL WIPE</code> to arm a short-lived full wipe token.
            </p>
            <input
              value={fullWipePhrase}
              onChange={(e) => setFullWipePhrase(e.target.value)}
              placeholder="ARM FULL WIPE"
            />
            <div className="button-row">
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setShowFullWipeConfirm(false);
                  setFullWipePhrase("");
                }}
              >
                Cancel
              </button>
              <button
                className="danger"
                type="button"
                disabled={!fullWipeEnabled}
                onClick={() => void armFullWipe()}
              >
                Arm Token
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UserManagementPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"OWNER" | "ADMIN" | "SCANNER" | "CUSTOM">(
    "SCANNER",
  );
  const [allowedPages, setAllowedPages] = useState<AppPage[]>(["SCAN"]);

  const loadUsers = () => api<any[]>("/users").then(setUsers);
  useEffect(() => {
    void loadUsers();
  }, []);
  const togglePage = (page: AppPage) =>
    setAllowedPages((prev) =>
      prev.includes(page)
        ? prev.filter((entry) => entry !== page)
        : [...prev, page],
    );
  const roleAllowsCustomPermissions = role === "CUSTOM";
  const effectivePages =
    role === "ADMIN" || role === "OWNER"
      ? PAGE_LABELS.map((entry) => entry.key)
      : role === "SCANNER"
        ? ["SCAN"]
        : allowedPages;
  const pageLabelMap = new Map(
    PAGE_LABELS.map((entry) => [entry.key, entry.label]),
  );
  const formatPages = (pages: AppPage[]) =>
    pages.map((page) => pageLabelMap.get(page) || page).join(", ");

  return (
    <div className="card stack">
      <h2>User Management</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void api("/users", {
            method: "POST",
            body: JSON.stringify({
              username,
              password,
              role,
              allowedPages: effectivePages,
            }),
          }).then(() => {
            setUsername("");
            setPassword("");
            setRole("SCANNER");
            setAllowedPages(["SCAN"]);
            return loadUsers();
          });
        }}
      >
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Role
          <select
            value={role}
            onChange={(e) =>
              setRole(
                e.target.value as "OWNER" | "ADMIN" | "SCANNER" | "CUSTOM",
              )
            }
          >
            {user?.role === "OWNER" && <option value="OWNER">OWNER</option>}
            <option value="ADMIN">ADMIN</option>
            <option value="SCANNER">SCANNER</option>
            <option value="CUSTOM">CUSTOM</option>
          </select>
        </label>
        {roleAllowsCustomPermissions && (
          <div>
            <p className="muted">Allowed tabs</p>
            <div className="permission-grid">
              {PAGE_LABELS.map((entry) => (
                <label key={entry.key} className="permission-option">
                  <input
                    type="checkbox"
                    checked={allowedPages.includes(entry.key)}
                    onChange={() => togglePage(entry.key)}
                  />
                  <span>{entry.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <button className="primary" type="submit">
          Add user
        </button>
      </form>
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Allowed Pages</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.role}</td>
              <td>{formatPages((u.allowedPages || []) as AppPage[])}</td>
              <td>
                <button
                  className="secondary"
                  onClick={() => {
                    const next = prompt(`New password for ${u.username}`);
                    if (next)
                      void api(`/users/${u.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ password: next }),
                      }).then(loadUsers);
                  }}
                >
                  Reset Password
                </button>{" "}
                <button
                  className="secondary"
                  onClick={() => {
                    if (confirm(`Delete ${u.username}?`))
                      void api(`/users/${u.id}`, { method: "DELETE" }).then(
                        loadUsers,
                      );
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <p>Loading...</p>;
  if (!user) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route
          path="/"
          element={
            <Navigate
              to={
                user.allowedPages.includes("DASHBOARD") ? "/dashboard" : "/scan"
              }
            />
          }
        />
        <Route
          path="/scan"
          element={
            <PermissionOnly page="SCAN">
              <ScanPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/dashboard"
          element={
            <PermissionOnly page="DASHBOARD">
              <Dashboard />
            </PermissionOnly>
          }
        />
        <Route
          path="/people"
          element={
            <PermissionOnly page="PEOPLE">
              <PeoplePage />
            </PermissionOnly>
          }
        />
        <Route
          path="/import"
          element={
            <PermissionOnly page="IMPORT">
              <ImportPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/badges"
          element={
            <PermissionOnly page="BADGES">
              <BadgesPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/transactions"
          element={
            <PermissionOnly page="TRANSACTIONS">
              <TransactionsPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/reports"
          element={
            <PermissionOnly page="REPORTS">
              <ReportsPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/settings"
          element={
            <PermissionOnly page="SETTINGS">
              <SettingsPage />
            </PermissionOnly>
          }
        />
        <Route
          path="/users"
          element={
            <AdminOnly>
              <PermissionOnly page="USER_MANAGEMENT">
                <UserManagementPage />
              </PermissionOnly>
            </AdminOnly>
          }
        />
      </Routes>
    </Layout>
  );
}
