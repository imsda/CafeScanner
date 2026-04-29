import { FormEvent, KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { ApiNetworkError, api, API_BASE } from './api/client';
import type { MealTrackingMode, MealType, ReportsSummaryResponse, ScanPerson, ScanResponse, Settings } from './api/types';
import QrScanner from './components/QrScanner';
import { useAuth } from './context/AuthContext';

function formatMealLabel(meal: string): string {
  return meal.charAt(0) + meal.slice(1).toLowerCase();
}

function modeLabel(mode: MealTrackingMode): string {
  if (mode === 'camp_meeting') return 'Camp Meeting';
  if (mode === 'countdown') return 'Count Down';
  return 'Tally Up';
}

function formatDateInputValue(date: Date): string {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 10);
}

function getRangeForPreset(preset: 'today' | 'week' | 'month' | 'year' | 'last7'): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  if (preset === 'week') {
    const day = start.getDay();
    const offsetToMonday = (day + 6) % 7;
    start.setDate(start.getDate() - offsetToMonday);
  } else if (preset === 'month') {
    start.setDate(1);
  } else if (preset === 'year') {
    start.setMonth(0, 1);
  } else if (preset === 'last7') {
    start.setDate(start.getDate() - 6);
  }

  return {
    from: formatDateInputValue(start),
    to: formatDateInputValue(end)
  };
}

function ButtonLink({ href, children, className = '', ...props }: { href: string; children: ReactNode; className?: string; target?: string; rel?: string }) {
  return <a href={href} className={`btn ${className}`.trim()} {...props}>{children}</a>;
}

function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [devDiagnostics, setDevDiagnostics] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await login(username, password);
      setError('');
      setDevDiagnostics('');
    } catch (submitError) {
      if (import.meta.env.DEV && submitError instanceof Error) {
        // Helpful during local troubleshooting without leaking credentials/tokens.
        console.error('Login request failed', submitError);
      }

      if (submitError instanceof ApiNetworkError) {
        setError(`Login request failed.\nURL: ${submitError.requestUrl}\nError: ${submitError.name}\nMessage: ${submitError.message}`);
        if (import.meta.env.DEV) {
          setDevDiagnostics(`Dev diagnostics — API_BASE: ${API_BASE}; origin: ${window.location.origin}; attempted endpoint: ${submitError.requestUrl}`);
        }
        return;
      }

      setError(submitError instanceof Error ? submitError.message : 'Unable to sign in');
      if (import.meta.env.DEV) {
        setDevDiagnostics(`Dev diagnostics — API_BASE: ${API_BASE}; origin: ${window.location.origin}; attempted endpoint: ${API_BASE}/auth/login`);
      }
    }
  }

  return <div className="login-shell"><div className="login-card"><h1>Cafeteria Scanner</h1><p className="muted">IMSDA Meal Scanner</p><form onSubmit={onSubmit} className="stack"><label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label><button className="primary" type="submit">Sign in</button>{error && <p className="error" style={{ whiteSpace: 'pre-line' }}>{error}</p>}{import.meta.env.DEV && devDiagnostics && <p className="muted">{devDiagnostics}</p>}</form></div></div>;
}

function Layout({ children }: { children: React.ReactNode }) {
  const { logout, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const links = isAdmin ? [['dashboard', 'Dashboard'], ['scan', 'Scan Station'], ['people', 'People'], ['import', 'Import'], ['badges', 'Badges'], ['transactions', 'Transactions'], ['reports', 'Reports'], ['settings', 'Settings']] : [['scan', 'Scan Station']];

  return <div><header className="topbar"><div className="topbar-inner"><a href="https://tools.imsda.org" className="back-link" rel="noreferrer">← Back to Tools</a><h2>Cafeteria Scanner</h2><div className="right-actions"><span className="user-pill">{user?.username} · {user?.role}</span><button type="button" className="secondary" onClick={() => logout()}>Logout</button></div></div><nav>{links.map(([path, label]) => <NavLink key={path} to={`/${path}`} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}</nav></header><main className="page">{children}</main></div>;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'ADMIN') return <Navigate to="/scan" replace />;
  return <>{children}</>;
}

function Dashboard() {
  const [data, setData] = useState<Record<string, number> | null>(null);
  useEffect(() => { void api<Record<string, number>>('/dashboard/summary').then(setData); }, []);
  if (!data) return <p>Loading dashboard…</p>;
  return <div className="card"><h2>Today at a glance</h2><div className="stats-grid">{Object.entries(data).map(([key, value]) => <div className="stat-card" key={key}><p className="muted">{key}</p><p className="value">{value}</p></div>)}</div></div>;
}

type ScanResultState = ({
  ok: true;
  person: ScanPerson;
  mealType: MealType;
  mealTrackingMode: MealTrackingMode;
  scannedValue?: string;
  remainingAvailableTodayForMeal?: number;
  redeemedEntitlement?: { id: number; personName?: string | null; personId: string; mealDay: string; mealDate: string };
} | { ok: false; error: string }) | null;

type PendingCampMeetingSelection = {
  scannedValue: string;
  originalScannedValue?: string;
  mealType: MealType;
  mealDay: string;
  options: Array<{ entitlementId: number; personName: string }>;
};

function ScanResultCard({ result }: { result: ScanResultState }) {
  if (!result) return <div className="scan-result info"><h3>Ready</h3><p>Scan a person ID barcode or use USB scanner/manual ID entry.</p></div>;
  if (!result.ok) return <div className="scan-result fail"><h3>Scan Failed</h3><p>{result.error}</p></div>;

  const tally = result.mealType === 'BREAKFAST' ? result.person.breakfastCount : result.mealType === 'LUNCH' ? result.person.lunchCount : result.person.dinnerCount;

  const sharedId = result.scannedValue || result.person.personId || 'N/A';
  return <div className="scan-result success"><h3>{result.mealTrackingMode === 'camp_meeting' ? 'Meal Redeemed' : result.mealTrackingMode === 'countdown' ? 'Meal Deducted' : 'Meal Recorded'}</h3><p className="scan-person">{result.person.firstName} {result.person.lastName}</p><p>Shared ID: <strong>{sharedId}</strong></p><p>Meal: <strong>{formatMealLabel(result.mealType)}</strong></p><p>Mode: <strong>{modeLabel(result.mealTrackingMode)}</strong></p>{result.mealTrackingMode === 'camp_meeting' ? <><p>{result.redeemedEntitlement?.personName ? `Meal redeemed for ${result.redeemedEntitlement.personName}` : 'Meal redeemed.'}</p><p>Remaining available today for this meal: <strong>{result.remainingAvailableTodayForMeal ?? 0}</strong></p></> : result.mealTrackingMode === 'countdown' ? <><p>{formatMealLabel(result.mealType)} deducted by 1.</p><p>Remaining {formatMealLabel(result.mealType).toLowerCase()}: <strong>{result.mealType === 'BREAKFAST' ? result.person.breakfastRemaining : result.mealType === 'LUNCH' ? result.person.lunchRemaining : result.person.dinnerRemaining}</strong></p></> : <><p>{formatMealLabel(result.mealType)} tally: <strong>{tally}</strong></p><p>Total meals served: <strong>{result.person.totalMealsCount}</strong></p></>}</div>;
}

function ScanPage() {
  const [result, setResult] = useState<ScanResultState>(null);
  const [pendingSelection, setPendingSelection] = useState<PendingCampMeetingSelection | null>(null);
  const [manual, setManual] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<'camera' | 'usb'>('camera');
  const [mealTrackingMode, setMealTrackingMode] = useState<MealTrackingMode>('camp_meeting');
  const [scanCooldownSeconds, setScanCooldownSeconds] = useState(1);
  const [scannerDiagnosticsEnabled, setScannerDiagnosticsEnabled] = useState(false);
  const [lastScannerError, setLastScannerError] = useState('');
  const usbInputRef = useRef<HTMLInputElement>(null);
  const autoSubmitTimeoutRef = useRef<number | null>(null);
  const lastInputAtRef = useRef(0);
  const previousManualRef = useRef('');
  const scannerLikeInputRef = useRef(false);
  const lastSubmissionRef = useRef<{ value: string; timestamp: number } | null>(null);

  const focusUsbInput = () => {
    if (mode !== 'usb') return;
    setTimeout(() => usbInputRef.current?.focus(), 0);
  };

  const clearAutoSubmitTimeout = () => {
    if (autoSubmitTimeoutRef.current !== null) {
      window.clearTimeout(autoSubmitTimeoutRef.current);
      autoSubmitTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    if (mode === 'usb') {
      usbInputRef.current?.focus();
    }
  }, [mode]);

  useEffect(() => {
    void api<Settings>('/settings').then((s) => {
      setMealTrackingMode(s.mealTrackingMode);
      setScanCooldownSeconds(Math.min(10, Math.max(0.5, s.scannerCooldownSeconds || 1)));
      setScannerDiagnosticsEnabled(Boolean(s.scannerDiagnosticsEnabled));
    });
  }, []);

  useEffect(() => () => clearAutoSubmitTimeout(), []);

  const submitScan = async (code: string, entitlementId?: number) => {
    const trimmed = code.trim();
    if (!trimmed || isSubmitting) return;
    const dedupeKey = `${trimmed}:${entitlementId ?? 'none'}`;
    const now = Date.now();
    if (lastSubmissionRef.current && lastSubmissionRef.current.value === dedupeKey && (now - lastSubmissionRef.current.timestamp) < scanCooldownSeconds * 1000) {
      return;
    }
    lastSubmissionRef.current = { value: dedupeKey, timestamp: now };

    clearAutoSubmitTimeout();
    setIsSubmitting(true);

    try {
      const response = await api<ScanResponse>('/scan', { method: 'POST', body: JSON.stringify({ personId: trimmed, entitlementId }) });
      if (!response.ok && response.pendingSelection) {
      setPendingSelection({
          scannedValue: response.scannedValue,
          originalScannedValue: response.originalScannedValue,
          mealType: response.mealType,
          mealDay: response.mealDay,
          options: response.options
        });
        setResult(null);
        setManual('');
        scannerLikeInputRef.current = false;
        focusUsbInput();
        return;
      }
      if (!response.ok) {
        throw new Error('Unable to process this scan right now.');
      }

      setResult({
        ok: true,
        person: response.person,
        mealType: response.mealType,
        mealTrackingMode: response.mealTrackingMode,
        scannedValue: response.scannedValue,
        remainingAvailableTodayForMeal: response.remainingAvailableTodayForMeal,
        redeemedEntitlement: response.redeemedEntitlement
      });
      setPendingSelection(null);
      setMealTrackingMode(response.mealTrackingMode);
      setLastScannerError('');
      setManual('');
      scannerLikeInputRef.current = false;
      focusUsbInput();
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : 'Unable to process this scan right now.';
      setResult({ ok: false, error: failureMessage });
      setLastScannerError(failureMessage);
      setPendingSelection(null);
      setManual('');
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
    if (mode !== 'usb' || isSubmitting) return;

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
    const appendedQuickly = value.length > previousValue.length && elapsedMs > 0 && elapsedMs <= 35;

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
    if (event.key !== 'Enter') return;

    event.preventDefault();
    scannerLikeInputRef.current = false;
    clearAutoSubmitTimeout();
    setPendingSelection(null);
    void submitScan(manual);
  };

  return <div className="scan-layout"><section className="card stack"><h2>Scan Station</h2><p className="muted">Active tracking mode: <strong>{modeLabel(mealTrackingMode)}</strong></p><p className="muted">Scan cooldown: <strong>{scanCooldownSeconds} second{scanCooldownSeconds === 1 ? '' : 's'}</strong></p><div className="button-row"><button className={mode === 'camera' ? 'primary' : 'secondary'} type="button" onClick={() => setMode('camera')}>Camera Scan</button><button className={mode === 'usb' ? 'primary' : 'secondary'} type="button" onClick={() => setMode('usb')}>USB Scanner / Manual ID Entry</button></div><p className="muted">For the fastest line, use camera scan when available. If needed, switch to USB Scanner / Manual ID Entry.</p>{mode === 'camera' ? <QrScanner cooldownMs={scanCooldownSeconds * 1000} diagnosticsEnabled={scannerDiagnosticsEnabled} selectedScannerMode={mode} lastScannerError={lastScannerError} onResult={(text) => void submitScan(text)} onError={(message) => { setLastScannerError(message); setResult({ ok: false, error: message }); }} /> : <form className="stack" onSubmit={onManualSubmit}><label>Person ID input<input ref={usbInputRef} className="scan-input" placeholder="Scan with USB scanner or type person ID and press Enter" value={manual} onChange={(e) => onManualInputChange(e.target.value)} onKeyDown={onManualKeyDown} aria-label="Person ID input" onBlur={() => focusUsbInput()} /></label><button className="primary" type="submit" disabled={isSubmitting || manual.trim().length === 0}>{isSubmitting ? 'Submitting…' : 'Submit ID'}</button></form>}{scannerDiagnosticsEnabled && <div className="scanner-diagnostics"><p><strong>Scanner diagnostics:</strong></p><ul><li>Selected scanner mode: <strong>{mode}</strong></li>{lastScannerError && <li>Last scanner error: <strong>{lastScannerError}</strong></li>}</ul></div>}{pendingSelection && <div className="selection-card stack"><h3>Select person for this meal</h3><p className="muted">Shared ID: <strong>{pendingSelection.scannedValue}</strong>{pendingSelection.originalScannedValue && pendingSelection.originalScannedValue !== pendingSelection.scannedValue ? ` (entered: ${pendingSelection.originalScannedValue})` : ''}</p><p className="muted">Meal: <strong>{formatMealLabel(pendingSelection.mealType)}</strong> · Day: <strong>{pendingSelection.mealDay}</strong></p><div className="selection-options">{pendingSelection.options.map((option) => <button key={option.entitlementId} type="button" className="primary selection-option" onClick={() => void submitScan(pendingSelection.scannedValue, option.entitlementId)} disabled={isSubmitting}>{option.personName}</button>)}</div><button type="button" className="secondary" onClick={() => { setPendingSelection(null); setManual(''); focusUsbInput(); }} disabled={isSubmitting}>Cancel</button></div>}</section><ScanResultCard result={result} /></div>;
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
  const [searchTerm, setSearchTerm] = useState('');
  const [gradeFilter, setGradeFilter] = useState('ALL');
  const [settings, setSettings] = useState<{ mealTrackingMode: MealTrackingMode } | null>(null);
  const [form, setForm] = useState<Record<string, string | number | boolean>>({ firstName: '', lastName: '', personId: '', codeValue: '', breakfastRemaining: 0, lunchRemaining: 0, dinnerRemaining: 0, breakfastCount: 0, lunchCount: 0, dinnerCount: 0, totalMealsCount: 0, active: true });
  const [personToDelete, setPersonToDelete] = useState<PersonRecord | null>(null);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = () => api<PersonRecord[]>('/people?showInactive=true').then(setPeople);
  useEffect(() => { void load(); void api<{ mealTrackingMode: MealTrackingMode }>('/settings').then(setSettings); }, []);

  const isTally = settings?.mealTrackingMode === 'tally';
  const isCampMeeting = settings?.mealTrackingMode === 'camp_meeting';
  const isCountdown = settings?.mealTrackingMode === 'countdown';

  async function addPerson(e: FormEvent) {
    e.preventDefault();
    setError('');
    setMessage('');
    const payload = isTally
      ? { ...form, breakfastRemaining: 0, lunchRemaining: 0, dinnerRemaining: 0 }
      : { ...form, breakfastCount: 0, lunchCount: 0, dinnerCount: 0, totalMealsCount: 0 };
    await api('/people', { method: 'POST', body: JSON.stringify(payload) });
    await load();
  }

  async function savePerson(person: PersonRecord) {
    setError('');
    setMessage('');
    const payload = isTally
      ? { breakfastCount: person.breakfastCount, lunchCount: person.lunchCount, dinnerCount: person.dinnerCount, totalMealsCount: person.totalMealsCount }
      : { breakfastRemaining: person.breakfastRemaining, lunchRemaining: person.lunchRemaining, dinnerRemaining: person.dinnerRemaining };
    await api(`/people/${person.id}`, { method: 'PUT', body: JSON.stringify(payload) });
    await load();
  }

  async function deletePerson() {
    if (!personToDelete || deletePhrase !== 'DELETE USER') return;
    setIsDeleting(true);
    setError('');
    setMessage('');

    try {
      await api(`/people/${personToDelete.id}`, { method: 'DELETE', body: JSON.stringify({ confirmationPhrase: deletePhrase }) });
      setMessage(`Deleted ${personToDelete.firstName} ${personToDelete.lastName} (${personToDelete.personId}).`);
      setPersonToDelete(null);
      setDeletePhrase('');
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this person');
    } finally {
      setIsDeleting(false);
    }
  }

  const deleteEnabled = deletePhrase === 'DELETE USER' && !isDeleting;
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const gradeOptions = useMemo(() => {
    const grades = Array.from(new Set(people.map((person) => (person.grade || '').trim()).filter(Boolean)));
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return grades.sort((a, b) => collator.compare(a, b));
  }, [people]);
  const filteredPeople = useMemo(() => people.filter((person) => {
    const firstName = person.firstName.toLowerCase();
    const lastName = person.lastName.toLowerCase();
    const fullName = `${firstName} ${lastName}`.trim();
    const personId = person.personId.toLowerCase();
    const associatedNames = (person.associatedNamesSummary || '').toLowerCase();
    const matchesSearch = normalizedSearch.length === 0
      || firstName.includes(normalizedSearch)
      || lastName.includes(normalizedSearch)
      || fullName.includes(normalizedSearch)
      || personId.includes(normalizedSearch)
      || associatedNames.includes(normalizedSearch);
    const gradeValue = (person.grade || '').trim();
    const matchesGrade = isCampMeeting ? true : (gradeFilter === 'ALL' || gradeValue === gradeFilter);
    return matchesSearch && matchesGrade;
  }), [people, normalizedSearch, gradeFilter, isCampMeeting]);
  const hasAnyGrade = useMemo(
    () => people.some((person) => Boolean((person.grade || '').trim())),
    [people],
  );
  const noResultsColSpan = 3 + (hasAnyGrade ? 1 : 0) + (isCampMeeting ? 12 : 4) + 1;
  const personDisplayName = (person: PersonRecord) => {
    if (isCampMeeting && person.associatedNamesSummary) return person.associatedNamesSummary;
    return `${person.firstName} ${person.lastName}`.trim() || person.personId;
  };

  return <div className="card stack"><h2>People</h2><p className="muted">Active mode: <strong>{modeLabel(settings?.mealTrackingMode || 'camp_meeting')}</strong>. {isTally ? 'Tally counters are editable in this mode.' : isCountdown ? 'Remaining balances are editable in this mode.' : 'Camp Meeting entitlement status is shown from imported CSV data. Today B/L/D are based on the current local day-of-week.'}</p>{message && <p>{message}</p>}{error && <p className="error">{error}</p>}<form className="grid-form grid-form-people" onSubmit={(e) => void addPerson(e)}>{['firstName', 'lastName', 'personId', 'codeValue', 'grade', 'group', 'campus'].map((k) => <input key={k} placeholder={k} value={String(form[k] || '')} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />)}<button className="primary add-person-btn">Add</button></form><div className="filters-row people-filters"><label>Search people<input type="search" placeholder="Search by first name, last name, full name, or ID" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></label>{!isCampMeeting && <label>Grade<select value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}><option value="ALL">All Grades</option>{gradeOptions.map((grade) => <option key={grade} value={grade}>{grade}</option>)}</select></label>}<button type="button" className="secondary" onClick={() => { setSearchTerm(''); setGradeFilter('ALL'); }} disabled={searchTerm.trim().length === 0 && (isCampMeeting || gradeFilter === 'ALL')}>Clear</button></div><div className="table-scroll"><table className="people-table"><thead><tr><th>Name</th><th>Person ID</th>{hasAnyGrade && <th>Grade</th>}{isCampMeeting ? <><th>B</th><th>L</th><th>D</th><th>B Av</th><th>L Av</th><th>D Av</th><th>B Rd</th><th>L Rd</th><th>D Rd</th><th>Today B</th><th>Today L</th><th>Today D</th></> : isCountdown ? <><th>Breakfast Remaining</th><th>Lunch Remaining</th><th>Dinner Remaining</th></> : <><th>Breakfast Count</th><th>Lunch Count</th><th>Dinner Count</th><th>Total Count</th></>}<th>Actions</th></tr></thead><tbody>{filteredPeople.length > 0 ? filteredPeople.map((p) => <tr key={p.id}><td>{personDisplayName(p)}</td><td>{p.personId}</td>{hasAnyGrade && <td>{(p.grade || '').trim() || null}</td>}{isCampMeeting ? <><td>{p.breakfastTotal ?? 0}</td><td>{p.lunchTotal ?? 0}</td><td>{p.dinnerTotal ?? 0}</td><td>{p.breakfastAvailable ?? 0}</td><td>{p.lunchAvailable ?? 0}</td><td>{p.dinnerAvailable ?? 0}</td><td>{p.breakfastRedeemed ?? 0}</td><td>{p.lunchRedeemed ?? 0}</td><td>{p.dinnerRedeemed ?? 0}</td><td>{p.todayBreakfastAvailable ?? 0}</td><td>{p.todayLunchAvailable ?? 0}</td><td>{p.todayDinnerAvailable ?? 0}</td></> : isCountdown ? <><td><input className="people-number-input" type="number" min={0} value={p.breakfastRemaining} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, breakfastRemaining: Number(e.target.value) } : row))} /></td><td><input className="people-number-input" type="number" min={0} value={p.lunchRemaining} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, lunchRemaining: Number(e.target.value) } : row))} /></td><td><input className="people-number-input" type="number" min={0} value={p.dinnerRemaining} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, dinnerRemaining: Number(e.target.value) } : row))} /></td></> : <><td><input className="people-number-input" type="number" min={0} value={p.breakfastCount} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, breakfastCount: Number(e.target.value) } : row))} /></td><td><input className="people-number-input" type="number" min={0} value={p.lunchCount} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, lunchCount: Number(e.target.value) } : row))} /></td><td><input className="people-number-input" type="number" min={0} value={p.dinnerCount} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, dinnerCount: Number(e.target.value) } : row))} /></td><td><input className="people-number-input" type="number" min={0} value={p.totalMealsCount} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, totalMealsCount: Number(e.target.value) } : row))} /></td></>}<td><div className="people-actions">{!isCampMeeting && <button className="small" type="button" onClick={() => void savePerson(p)}>Save</button>}{isTally && <button className="small secondary" type="button" onClick={() => void api(`/people/reset-tallies/${p.id}`, { method: 'POST' }).then(load)}>Reset</button>}<button className="small danger" type="button" onClick={() => { setPersonToDelete(p); setDeletePhrase(''); setError(''); setMessage(''); }}>Delete</button></div></td></tr>) : <tr><td className="muted" colSpan={noResultsColSpan}>No people match your current {isCampMeeting ? 'search' : 'search and grade filters'}.</td></tr>}</tbody></table></div>{personToDelete && <div className="confirm-overlay" role="dialog" aria-modal="true"><div className="confirm-modal stack"><h4>Confirm Person Deletion</h4><p>You are deleting <strong>{personDisplayName(personToDelete)}</strong>.</p><p>Person ID: <strong>{personToDelete.personId}</strong></p><p className="error">Warning: This permanently removes this person and their related scan transaction history. This cannot be easily undone.</p><p>Type <code>DELETE USER</code> to enable deletion.</p><input value={deletePhrase} onChange={(e) => setDeletePhrase(e.target.value)} placeholder="DELETE USER" /><div className="button-row"><button className="secondary" type="button" onClick={() => { setPersonToDelete(null); setDeletePhrase(''); }}>Cancel</button><button className="danger" type="button" disabled={!deleteEnabled} onClick={() => void deletePerson()}>{isDeleting ? 'Deleting…' : 'Delete Person'}</button></div></div></div>}</div>;
}

function ImportPage() {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<any>();
  const [result, setResult] = useState<any>();
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [settings, setSettings] = useState<{ mealTrackingMode: MealTrackingMode } | null>(null);

  useEffect(() => {
    void api<{ mealTrackingMode: MealTrackingMode }>('/settings').then(setSettings);
  }, []);

  const isCampMeeting = settings?.mealTrackingMode === 'camp_meeting';

  async function parseJsonOrThrow(res: Response) {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : 'Import request failed';
      throw new Error(message);
    }

    return payload;
  }

  async function previewFile() {
    if (!file) return;

    setError('');
    setResult(undefined);

    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/import/preview`, { method: 'POST', credentials: 'include', body: form });
      setPreview(await parseJsonOrThrow(res));
    } catch (previewError) {
      setPreview(undefined);
      setError(previewError instanceof Error ? previewError.message : 'Unable to preview import file.');
    }
  }

  async function commit() {
    if (!file || isSubmitting) return;

    const form = new FormData();
    form.append('file', file);
    if (isCampMeeting) {
      const confirmed = window.confirm('Replace existing Camp Meeting entitlements with this upload?');
      if (!confirmed) return;
      form.append('replaceExisting', 'true');
    } else {
      form.append('generateMissingCodes', 'true');
    }

    setIsSubmitting(true);
    setError('');
    setResult(undefined);

    try {
      const res = await fetch(`${API_BASE}/import/commit`, { method: 'POST', credentials: 'include', body: form });
      setResult(await parseJsonOrThrow(res));
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : 'Unable to import CSV.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return <div className="card stack"><h2>{isCampMeeting ? 'Camp Meeting Import' : 'CSV Import'}</h2><div className="button-row"><ButtonLink href={`${API_BASE}/import/template`} className="btn-secondary" target="_blank" rel="noreferrer">Download Template</ButtonLink></div><input type="file" accept=".csv" onChange={(e)=>setFile(e.target.files?.[0])}/><div className="button-row"><button className="secondary" onClick={previewFile} disabled={!file || isSubmitting}>Preview</button><button className="primary" onClick={commit} disabled={!file || isSubmitting}>{isSubmitting ? 'Importing…' : (isCampMeeting ? 'Upload Camp Meeting CSV' : 'Commit Partial Import')}</button></div>{error && <p className="error">{error}</p>}{preview && <pre>{JSON.stringify(preview, null, 2)}</pre>}{result && <pre>{JSON.stringify(result, null, 2)}</pre>}</div>;
}

function BadgesPage() { const [people, setPeople] = useState<any[]>([]); useEffect(() => { void api<any[]>('/people?showInactive=true').then(setPeople); }, []); return <div className="card"><h2>Printable Badges</h2><button className="secondary" onClick={() => window.print()}>Print Sheet</button><div className="badge-grid">{people.map((p)=><div className="badge" key={p.id}><QRCodeSVG value={p.personId} size={90}/><p>{p.firstName} {p.lastName}</p><small>{p.personId}</small></div>)}</div></div>; }
function TransactionsPage() { const [rows, setRows] = useState<any[]>([]); useEffect(() => { void api<any[]>('/transactions').then(setRows); }, []); return <div className="card stack"><h2>Transactions</h2><div className="button-row"><ButtonLink href={`${API_BASE}/transactions/export.csv`} className="btn-secondary" target="_blank" rel="noreferrer">Export CSV</ButtonLink></div><table><thead><tr><th>Time</th><th>Value</th><th>Meal</th><th>Result</th><th>Reason</th><th>Person</th><th>Station</th></tr></thead><tbody>{rows.map((r)=><tr key={r.id}><td>{new Date(r.timestamp).toLocaleString()}</td><td>{r.scannedValue}</td><td>{r.mealType}</td><td>{r.result}</td><td>{r.failureReason||'-'}</td><td>{r.entitlementPersonName || (r.person?`${r.person.firstName} ${r.person.lastName}`:'-')}</td><td>{r.stationName||'-'}</td></tr>)}</tbody></table></div>; }

function ReportsPage() {
  const todayRange = useMemo(() => getRangeForPreset('today'), []);
  const [fromDate, setFromDate] = useState(todayRange.from);
  const [toDate, setToDate] = useState(todayRange.to);
  const [appliedFromDate, setAppliedFromDate] = useState(todayRange.from);
  const [appliedToDate, setAppliedToDate] = useState(todayRange.to);
  const [activePreset, setActivePreset] = useState<'custom' | 'today' | 'last7' | 'week' | 'month' | 'year'>('today');
  const [report, setReport] = useState<ReportsSummaryResponse | null>(null);
  const [error, setError] = useState('');

  async function loadReport(range?: { from: string; to: string }) {
    const selectedRange = range ?? { from: fromDate, to: toDate };
    try {
      const query = new URLSearchParams({
        from: selectedRange.from,
        to: selectedRange.to,
        startDate: selectedRange.from,
        endDate: selectedRange.to
      });
      const data = await api<ReportsSummaryResponse>(`/reports/summary?${query.toString()}`);
      setReport(data);
      setAppliedFromDate(selectedRange.from);
      setAppliedToDate(selectedRange.to);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load report');
    }
  }

  function applyPreset(preset: 'today' | 'last7' | 'week' | 'month' | 'year') {
    const range = getRangeForPreset(preset);
    setFromDate(range.from);
    setToDate(range.to);
    setActivePreset(preset);
  }

  useEffect(() => { void loadReport(); }, []);

  const mealTotals = report?.mealTotalsByPerson ?? report?.perPersonUsage ?? [];
  const exportQuery = new URLSearchParams({
    from: appliedFromDate,
    to: appliedToDate,
    startDate: appliedFromDate,
    endDate: appliedToDate
  }).toString();

  return <div className="card stack"><h2>Reports</h2><div className="stack report-controls"><div className="button-row"><button type="button" className={activePreset === 'today' ? 'primary' : 'secondary'} onClick={() => applyPreset('today')}>Today</button><button type="button" className={activePreset === 'last7' ? 'primary' : 'secondary'} onClick={() => applyPreset('last7')}>Last 7 Days</button><button type="button" className={activePreset === 'week' ? 'primary' : 'secondary'} onClick={() => applyPreset('week')}>Current Week</button><button type="button" className={activePreset === 'month' ? 'primary' : 'secondary'} onClick={() => applyPreset('month')}>Current Month</button><button type="button" className={activePreset === 'year' ? 'primary' : 'secondary'} onClick={() => applyPreset('year')}>Current Year</button><button type="button" className="secondary" onClick={() => setActivePreset('custom')} disabled={activePreset === 'custom'}>Custom Range</button></div><div className="filters-row"><label>From <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setActivePreset('custom'); }} /></label><label>To <input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setActivePreset('custom'); }} /></label><button className="primary" type="button" onClick={() => void loadReport()}>Apply Filter</button><ButtonLink className="btn-secondary" href={`${API_BASE}/reports/export.csv?${exportQuery}`} target="_blank" rel="noreferrer">Export Transactions CSV</ButtonLink><ButtonLink className="btn-secondary" href={`${API_BASE}/reports/meal-totals.csv?${exportQuery}`} target="_blank" rel="noreferrer">Export Meal Totals CSV</ButtonLink></div></div>{error && <p className="error">{error}</p>}{report && <><p className="muted">Active mode: <strong>{modeLabel(report.mealTrackingMode)}</strong></p><div className="stats-grid"><div className="stat-card"><p className="muted">Scans</p><p className="value">{report.stats.scans}</p></div><div className="stat-card"><p className="muted">Failed Scans</p><p className="value">{report.stats.failedScans}</p></div>{report.mealTrackingMode === 'camp_meeting' ? <><div className="stat-card"><p className="muted">Total Entitlements</p><p className="value">{report.entitlementSummary.totalEntitlements}</p></div><div className="stat-card"><p className="muted">Total Redeemed</p><p className="value">{report.entitlementSummary.totalRedeemed}</p></div><div className="stat-card"><p className="muted">Unused Entitlements</p><p className="value">{report.entitlementSummary.totalRemaining}</p></div></> : report.mealTrackingMode === 'countdown' ? <><div className="stat-card"><p className="muted">Breakfast Remaining</p><p className="value">{report.remainingBalanceSummary.breakfastRemaining}</p></div><div className="stat-card"><p className="muted">Lunch Remaining</p><p className="value">{report.remainingBalanceSummary.lunchRemaining}</p></div><div className="stat-card"><p className="muted">Dinner Remaining</p><p className="value">{report.remainingBalanceSummary.dinnerRemaining}</p></div></> : <><div className="stat-card"><p className="muted">Breakfast Tally</p><p className="value">{report.tallySummary.breakfastCount}</p></div><div className="stat-card"><p className="muted">Lunch Tally</p><p className="value">{report.tallySummary.lunchCount}</p></div><div className="stat-card"><p className="muted">Dinner Tally</p><p className="value">{report.tallySummary.dinnerCount}</p></div><div className="stat-card"><p className="muted">Total Meals Tallied</p><p className="value">{report.tallySummary.totalMealsCount}</p></div></>}</div><section className="stack"><h3>Meal Totals by Person</h3>{mealTotals.length === 0 ? <p className="muted">No meals found for the selected date range.</p> : <table><thead><tr><th>Name</th><th>Person ID</th><th>Total Meals</th><th>Breakfast</th><th>Lunch</th><th>Dinner</th></tr></thead><tbody>{mealTotals.map((row) => <tr key={row.personId}><td>{row.firstName} {row.lastName}</td><td>{row.personId}</td><td>{row.total}</td><td>{row.breakfasts}</td><td>{row.lunches}</td><td>{row.dinners}</td></tr>)}</tbody></table>}</section></>}</div>;
}

function SettingsPage() {
  const [settings, setSettings] = useState<Settings>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [clearPhrase, setClearPhrase] = useState('');
  const [showClearModal, setShowClearModal] = useState(false);
  const [isClearingDatabase, setIsClearingDatabase] = useState(false);
  const [showModeConfirm, setShowModeConfirm] = useState(false);
  const [modePhrase, setModePhrase] = useState('');
  const [pendingMode, setPendingMode] = useState<MealTrackingMode | null>(null);

  const load = async () => {
    const loaded = await api<Settings>('/settings');
    setSettings(loaded);
  };

  useEffect(() => { void load(); }, []);
  if (!settings) return <p>Loading...</p>;

  const clearEnabled = clearPhrase === 'CLEAR DATABASE' && !isClearingDatabase;
  const modeEnabled = modePhrase === 'SWITCH MODE';

  async function saveSettings() {
    if (!settings) return;
    setError('');
    const payload = Object.fromEntries(Object.entries(settings).filter(([key]) => !['id', 'updatedAt', 'mealTrackingMode'].includes(key)));
    await api('/settings', { method: 'PUT', body: JSON.stringify(payload) });
    setMessage('Settings saved.');
    await load();
  }

  async function clearDatabase() {
    if (!clearEnabled) return;

    setIsClearingDatabase(true);
    setError('');
    setMessage('');
    try {
      await api('/system/clear-database', { method: 'POST' });
      setMessage('Database cleared successfully.');
      setShowClearModal(false);
      setClearPhrase('');
      await load();
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Unable to clear database.');
    } finally {
      setIsClearingDatabase(false);
    }
  }

  return <div className="card stack"><h2>Settings</h2><div className="card stack"><h3>Meal Tracking Mode</h3><p className="muted">Current active mode: <strong>{modeLabel(settings.mealTrackingMode)}</strong></p><label>Meal tracking mode<select value={settings.mealTrackingMode} onChange={(e) => { const selected = e.target.value as MealTrackingMode; if (selected === settings.mealTrackingMode) return; setPendingMode(selected); setShowModeConfirm(true); setModePhrase(''); }}><option value="camp_meeting">Camp Meeting (redeem imported meal entitlements)</option><option value="countdown">Count Down (deduct from remaining balances)</option><option value="tally">Tally Up (count each served meal)</option></select></label><p className="error">Warning: Switching mode is destructive and will clear all people, transaction history, import history, and meal entitlements.</p>{showModeConfirm && pendingMode && <div className="confirm-overlay" role="dialog" aria-modal="true"><div className="confirm-modal stack"><h4>Confirm Mode Switch</h4><p>You are switching from <strong>{modeLabel(settings.mealTrackingMode)}</strong> to <strong>{modeLabel(pendingMode)}</strong>.</p><p className="error">This will permanently clear operational data (people, scans, imports). Accounts and settings will be preserved.</p><p>Type <code>SWITCH MODE</code> to continue.</p><input value={modePhrase} onChange={(e) => setModePhrase(e.target.value)} placeholder="SWITCH MODE" /><div className="button-row"><button className="secondary" type="button" onClick={() => { setShowModeConfirm(false); setPendingMode(null); setModePhrase(''); }}>Cancel</button><button className="danger" type="button" disabled={!modeEnabled} onClick={() => void api('/settings/meal-tracking-mode', { method: 'PUT', body: JSON.stringify({ mealTrackingMode: pendingMode, confirmationPhrase: modePhrase }) }).then(async () => { setMessage(`Meal tracking mode switched to ${modeLabel(pendingMode)}. Operational data was cleared.`); setError(''); setShowModeConfirm(false); setPendingMode(null); setModePhrase(''); await load(); })}>Switch Mode + Clear Data</button></div></div></div>}</div><div className="card stack"><h3>Scanner</h3><label>Scan cooldown<input type="number" min={0.5} max={10} step={0.1} value={settings.scannerCooldownSeconds} onChange={(e) => setSettings({ ...settings, scannerCooldownSeconds: Math.min(10, Math.max(0.5, Number(e.target.value) || 1)) })} /></label><p className="muted">Seconds between duplicate scans of the same ID.</p><label><input type="checkbox" checked={settings.scannerDiagnosticsEnabled} onChange={(e) => setSettings({ ...settings, scannerDiagnosticsEnabled: e.target.checked })} /> Enable scanner diagnostics</label><p className="muted">Shows technical camera/scanner information for troubleshooting.</p></div><div className="grid-form">{Object.keys(settings).filter((k)=>!['id','updatedAt','mealTrackingMode','scannerCooldownSeconds','scannerDiagnosticsEnabled'].includes(k)).map((k)=><label key={k}>{k}<input value={String(settings[k as keyof Settings])} onChange={(e)=>setSettings({...settings,[k]:typeof settings[k as keyof Settings]==='boolean'?e.target.value==='true':typeof settings[k as keyof Settings]==='number'?Number(e.target.value):e.target.value})}/></label>)}</div><div className="button-row"><button className="primary" onClick={() => void saveSettings()}>Save</button></div>{message && <p>{message}</p>}{error && <p className="error">{error}</p>}<hr /><div className="stack"><h3>System: Clear Database</h3><p className="error">Warning: This permanently deletes all people, scan transactions, and import history. Admin/scanner login accounts and system settings are preserved.</p><button className="danger" type="button" onClick={() => { setShowClearModal(true); setMessage(''); setError(''); setClearPhrase(''); }}>Clear Database</button>{showClearModal && <div className="confirm-overlay" role="dialog" aria-modal="true"><div className="confirm-modal stack"><h4>Clear Database</h4><p className="error"><strong>Warning:</strong> This action removes all operational data, including people, transactions, and import history. Accounts and settings are preserved.</p><p>Type <code>CLEAR DATABASE</code> to continue.</p><input value={clearPhrase} onChange={(e) => setClearPhrase(e.target.value)} placeholder="CLEAR DATABASE" /><div className="button-row"><button className="secondary" onClick={() => { setShowClearModal(false); setClearPhrase(''); }} disabled={isClearingDatabase}>Cancel</button><button className="danger" disabled={!clearEnabled} onClick={() => void clearDatabase()}>{isClearingDatabase ? 'Clearing…' : 'Confirm Clear Database'}</button></div></div></div>}</div></div>;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <p>Loading...</p>;
  if (!user) return <Login />;

  return <Layout><Routes><Route path="/" element={<Navigate to={user.role === 'ADMIN' ? '/dashboard' : '/scan'} />} /><Route path="/scan" element={<ScanPage />} /><Route path="/dashboard" element={<AdminOnly><Dashboard /></AdminOnly>} /><Route path="/people" element={<AdminOnly><PeoplePage /></AdminOnly>} /><Route path="/import" element={<AdminOnly><ImportPage /></AdminOnly>} /><Route path="/badges" element={<AdminOnly><BadgesPage /></AdminOnly>} /><Route path="/transactions" element={<AdminOnly><TransactionsPage /></AdminOnly>} /><Route path="/reports" element={<AdminOnly><ReportsPage /></AdminOnly>} /><Route path="/settings" element={<AdminOnly><SettingsPage /></AdminOnly>} /></Routes></Layout>;
}
