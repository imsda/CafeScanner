import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { api, API_BASE } from './api/client';
import type { MealTrackingMode, MealType, ReportsSummaryResponse, ScanPerson, ScanResponse } from './api/types';
import QrScanner from './components/QrScanner';
import { useAuth } from './context/AuthContext';

function formatMealLabel(meal: string): string {
  return meal.charAt(0) + meal.slice(1).toLowerCase();
}

function modeLabel(mode: MealTrackingMode): string {
  return mode === 'countdown' ? 'Count Down' : 'Tally Up';
}

function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await login(username, password);
      setError('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to sign in');
    }
  }

  return <div className="login-shell"><div className="login-card"><h1>Cafeteria Scanner</h1><p className="muted">IMSDA Meal Scanner</p><form onSubmit={onSubmit} className="stack"><label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label><button className="primary" type="submit">Sign in</button>{error && <p className="error">{error}</p>}</form></div></div>;
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

type ScanResultState = ({ ok: true; person: ScanPerson; mealType: MealType; mealTrackingMode: MealTrackingMode } | { ok: false; error: string }) | null;

function ScanResultCard({ result }: { result: ScanResultState }) {
  if (!result) return <div className="scan-result info"><h3>Ready</h3><p>Scan a person ID barcode or use USB scanner/manual ID entry.</p></div>;
  if (!result.ok) return <div className="scan-result fail"><h3>Scan Failed</h3><p>{result.error}</p></div>;

  const remaining = result.mealType === 'BREAKFAST' ? result.person.breakfastRemaining : result.mealType === 'LUNCH' ? result.person.lunchRemaining : result.person.dinnerRemaining;
  const tally = result.mealType === 'BREAKFAST' ? result.person.breakfastCount : result.mealType === 'LUNCH' ? result.person.lunchCount : result.person.dinnerCount;

  return <div className="scan-result success"><h3>Meal Recorded</h3><p className="scan-person">{result.person.firstName} {result.person.lastName}</p><p>Meal: <strong>{formatMealLabel(result.mealType)}</strong></p><p>Mode: <strong>{modeLabel(result.mealTrackingMode)}</strong></p>{result.mealTrackingMode === 'countdown' ? <p>Remaining balance: <strong>{remaining}</strong></p> : <><p>{formatMealLabel(result.mealType)} tally: <strong>{tally}</strong></p><p>Total meals served: <strong>{result.person.totalMealsCount}</strong></p></>}</div>;
}

function ScanPage() {
  const [result, setResult] = useState<ScanResultState>(null);
  const [manual, setManual] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<'camera' | 'usb'>('camera');
  const [mealTrackingMode, setMealTrackingMode] = useState<MealTrackingMode>('countdown');
  const usbInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (mode === 'usb') usbInputRef.current?.focus(); }, [mode]);
  useEffect(() => { void api<{ mealTrackingMode: MealTrackingMode }>('/settings').then((s) => setMealTrackingMode(s.mealTrackingMode)); }, []);

  const submitScan = async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const response = await api<ScanResponse>('/scan', { method: 'POST', body: JSON.stringify({ personId: trimmed }) });
      setResult({ ok: true, person: response.person, mealType: response.mealType, mealTrackingMode: response.mealTrackingMode });
      setMealTrackingMode(response.mealTrackingMode);
      setManual('');
      usbInputRef.current?.focus();
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : 'Unable to process this scan right now.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const onManualSubmit = async (event: FormEvent) => { event.preventDefault(); await submitScan(manual); };

  return <div className="scan-layout"><section className="card stack"><h2>Scan Station</h2><p className="muted">Active tracking mode: <strong>{modeLabel(mealTrackingMode)}</strong></p><div className="button-row"><button className={mode === 'camera' ? 'primary' : 'secondary'} type="button" onClick={() => setMode('camera')}>Camera Scan</button><button className={mode === 'usb' ? 'primary' : 'secondary'} type="button" onClick={() => setMode('usb')}>USB Scanner / Manual ID Entry</button></div><p className="muted">Camera mode requires a secure context (HTTPS or localhost). If this URL is insecure, open the HTTPS dev URL from <code>./scripts/dev.sh</code>. If camera access is blocked/unavailable, use USB Scanner / Manual ID Entry.</p>{mode === 'camera' ? <QrScanner onResult={(text) => void submitScan(text)} onError={(message) => setResult({ ok: false, error: message })} /> : <form className="stack" onSubmit={onManualSubmit}><label>Person ID input<input ref={usbInputRef} className="scan-input" placeholder="Scan with USB scanner or type person ID and press Enter" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Person ID input" onBlur={() => setTimeout(() => usbInputRef.current?.focus(), 0)} /></label><button className="primary" type="submit" disabled={isSubmitting || manual.trim().length === 0}>{isSubmitting ? 'Submitting…' : 'Submit ID'}</button></form>}</section><ScanResultCard result={result} /></div>;
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
    const matchesSearch = normalizedSearch.length === 0
      || firstName.includes(normalizedSearch)
      || lastName.includes(normalizedSearch)
      || fullName.includes(normalizedSearch)
      || personId.includes(normalizedSearch);
    const gradeValue = (person.grade || '').trim();
    const matchesGrade = gradeFilter === 'ALL' || gradeValue === gradeFilter;
    return matchesSearch && matchesGrade;
  }), [people, normalizedSearch, gradeFilter]);

  return <div className="card stack"><h2>People</h2><p className="muted">Active mode: <strong>{isTally ? 'Tally Up' : 'Count Down'}</strong>. Only {isTally ? 'tally counts' : 'remaining balances'} are editable in this mode.</p>{message && <p>{message}</p>}{error && <p className="error">{error}</p>}<form className="grid-form" onSubmit={(e) => void addPerson(e)}>{['firstName', 'lastName', 'personId', 'codeValue', 'grade', 'group', 'campus'].map((k) => <input key={k} placeholder={k} value={String(form[k] || '')} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />)}<button className="primary">Add</button></form><div className="filters-row people-filters"><label>Search people<input type="search" placeholder="Search by first name, last name, full name, or ID" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></label><label>Grade<select value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}><option value="ALL">All Grades</option>{gradeOptions.map((grade) => <option key={grade} value={grade}>{grade}</option>)}</select></label><button type="button" className="secondary" onClick={() => { setSearchTerm(''); setGradeFilter('ALL'); }} disabled={searchTerm.trim().length === 0 && gradeFilter === 'ALL'}>Clear</button></div><table><thead><tr><th>Name</th><th>Person ID</th><th>Code</th>{isTally ? <><th>Breakfast Count</th><th>Lunch Count</th><th>Dinner Count</th><th>Total Count</th></> : <><th>Breakfast Rem.</th><th>Lunch Rem.</th><th>Dinner Rem.</th></>}<th>Actions</th></tr></thead><tbody>{filteredPeople.length > 0 ? filteredPeople.map((p) => <tr key={p.id}><td>{p.firstName} {p.lastName}</td><td>{p.personId}</td><td>{p.codeValue}</td>{isTally ? <><td><input type="number" min={0} value={p.breakfastCount} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, breakfastCount: Number(e.target.value) } : row))} /></td><td><input type="number" min={0} value={p.lunchCount} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, lunchCount: Number(e.target.value) } : row))} /></td><td><input type="number" min={0} value={p.dinnerCount} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, dinnerCount: Number(e.target.value) } : row))} /></td><td><input type="number" min={0} value={p.totalMealsCount} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, totalMealsCount: Number(e.target.value) } : row))} /></td></> : <><td><input type="number" min={0} value={p.breakfastRemaining} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, breakfastRemaining: Number(e.target.value) } : row))} /></td><td><input type="number" min={0} value={p.lunchRemaining} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, lunchRemaining: Number(e.target.value) } : row))} /></td><td><input type="number" min={0} value={p.dinnerRemaining} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, dinnerRemaining: Number(e.target.value) } : row))} /></td></>}<td><div className="stack"><button className="small" type="button" onClick={() => void savePerson(p)}>{isTally ? 'Save Tallies' : 'Save Meals'}</button>{isTally && <button className="small secondary" type="button" onClick={() => void api(`/people/reset-tallies/${p.id}`, { method: 'POST' }).then(load)}>Reset Tallies</button>}<button className="small danger" type="button" onClick={() => { setPersonToDelete(p); setDeletePhrase(''); setError(''); setMessage(''); }}>Delete Person</button></div></td></tr>) : <tr><td className="muted" colSpan={isTally ? 8 : 7}>No people match your current search and grade filters.</td></tr>}</tbody></table>{personToDelete && <div className="confirm-overlay" role="dialog" aria-modal="true"><div className="confirm-modal stack"><h4>Confirm Person Deletion</h4><p>You are deleting <strong>{personToDelete.firstName} {personToDelete.lastName}</strong>.</p><p>Person ID: <strong>{personToDelete.personId}</strong></p><p className="error">Warning: This permanently removes this person and their related scan transaction history. This cannot be easily undone.</p><p>Type <code>DELETE USER</code> to enable deletion.</p><input value={deletePhrase} onChange={(e) => setDeletePhrase(e.target.value)} placeholder="DELETE USER" /><div className="button-row"><button className="secondary" type="button" onClick={() => { setPersonToDelete(null); setDeletePhrase(''); }}>Cancel</button><button className="danger" type="button" disabled={!deleteEnabled} onClick={() => void deletePerson()}>{isDeleting ? 'Deleting…' : 'Delete Person'}</button></div></div></div>}</div>;
}

function ImportPage() { const [file, setFile] = useState<File>(); const [preview, setPreview] = useState<any>(); const [result, setResult] = useState<any>(); async function previewFile() { if (!file) return; const form = new FormData(); form.append('file', file); const res = await fetch(`${API_BASE}/import/preview`, { method: 'POST', credentials: 'include', body: form }); setPreview(await res.json()); } async function commit() { if (!file) return; const form = new FormData(); form.append('file', file); form.append('generateMissingCodes', 'true'); const res = await fetch(`${API_BASE}/import/commit`, { method: 'POST', credentials: 'include', body: form }); setResult(await res.json()); } return <div className="card"><h2>CSV Import</h2><a href={`${API_BASE}/import/template`} target="_blank" rel="noreferrer">Download Template</a><input type="file" accept=".csv" onChange={(e)=>setFile(e.target.files?.[0])}/><div className="button-row"><button className="secondary" onClick={previewFile} disabled={!file}>Preview</button><button className="primary" onClick={commit} disabled={!file}>Commit Partial Import</button></div>{preview && <pre>{JSON.stringify(preview, null, 2)}</pre>}{result && <pre>{JSON.stringify(result, null, 2)}</pre>}</div>; }
function BadgesPage() { const [people, setPeople] = useState<any[]>([]); useEffect(() => { void api<any[]>('/people?showInactive=true').then(setPeople); }, []); return <div className="card"><h2>Printable Badges</h2><button className="secondary" onClick={() => window.print()}>Print Sheet</button><div className="badge-grid">{people.map((p)=><div className="badge" key={p.id}><QRCodeSVG value={p.personId} size={90}/><p>{p.firstName} {p.lastName}</p><small>{p.personId}</small></div>)}</div></div>; }
function TransactionsPage() { const [rows, setRows] = useState<any[]>([]); useEffect(() => { void api<any[]>('/transactions').then(setRows); }, []); return <div className="card"><h2>Transactions</h2><a href={`${API_BASE}/transactions/export.csv`} target="_blank" rel="noreferrer">Export CSV</a><table><thead><tr><th>Time</th><th>Value</th><th>Meal</th><th>Result</th><th>Reason</th><th>Person</th><th>Station</th></tr></thead><tbody>{rows.map((r)=><tr key={r.id}><td>{new Date(r.timestamp).toLocaleString()}</td><td>{r.scannedValue}</td><td>{r.mealType}</td><td>{r.result}</td><td>{r.failureReason||'-'}</td><td>{r.person?`${r.person.firstName} ${r.person.lastName}`:'-'}</td><td>{r.stationName||'-'}</td></tr>)}</tbody></table></div>; }

function ReportsPage() {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [report, setReport] = useState<ReportsSummaryResponse | null>(null);
  const [error, setError] = useState('');

  async function loadReport() {
    try {
      const query = new URLSearchParams({ from: fromDate, to: toDate });
      const data = await api<ReportsSummaryResponse>(`/reports/summary?${query.toString()}`);
      setReport(data);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load report');
    }
  }

  useEffect(() => { void loadReport(); }, []);

  return <div className="card stack"><h2>Reports</h2><div className="filters-row"><label>From <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label><label>To <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label><button className="primary" type="button" onClick={() => void loadReport()}>Apply Filter</button><a className="button-link" href={`${API_BASE}/reports/export.csv?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`} target="_blank" rel="noreferrer">Export Transactions CSV</a></div>{error && <p className="error">{error}</p>}{report && <><p className="muted">Active mode: <strong>{modeLabel(report.mealTrackingMode)}</strong></p><div className="stats-grid"><div className="stat-card"><p className="muted">Scans</p><p className="value">{report.stats.scans}</p></div><div className="stat-card"><p className="muted">Failed Scans</p><p className="value">{report.stats.failedScans}</p></div>{report.mealTrackingMode === 'countdown' ? <><div className="stat-card"><p className="muted">Breakfast Remaining</p><p className="value">{report.remainingBalanceSummary.breakfastRemaining}</p></div><div className="stat-card"><p className="muted">Lunch Remaining</p><p className="value">{report.remainingBalanceSummary.lunchRemaining}</p></div><div className="stat-card"><p className="muted">Dinner Remaining</p><p className="value">{report.remainingBalanceSummary.dinnerRemaining}</p></div></> : <><div className="stat-card"><p className="muted">Breakfast Tally</p><p className="value">{report.tallySummary.breakfastCount}</p></div><div className="stat-card"><p className="muted">Lunch Tally</p><p className="value">{report.tallySummary.lunchCount}</p></div><div className="stat-card"><p className="muted">Dinner Tally</p><p className="value">{report.tallySummary.dinnerCount}</p></div><div className="stat-card"><p className="muted">Total Meals Tallied</p><p className="value">{report.tallySummary.totalMealsCount}</p></div></>}</div></>}</div>;
}

function SettingsPage() {
  const [settings, setSettings] = useState<any>();
  const [message, setMessage] = useState('');
  const [clearPhrase, setClearPhrase] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showModeConfirm, setShowModeConfirm] = useState(false);
  const [modePhrase, setModePhrase] = useState('');
  const [pendingMode, setPendingMode] = useState<MealTrackingMode | null>(null);

  const load = async () => {
    const loaded = await api('/settings');
    setSettings(loaded);
  };

  useEffect(() => { void load(); }, []);
  if (!settings) return <p>Loading...</p>;

  const clearEnabled = clearPhrase === 'CLEAR DATABASE';
  const modeEnabled = modePhrase === 'SWITCH MODE';

  async function saveSettings() {
    const payload = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'mealTrackingMode'));
    await api('/settings', { method: 'PUT', body: JSON.stringify(payload) });
    setMessage('Settings saved.');
    await load();
  }

  return <div className="card stack"><h2>Settings</h2><div className="card stack"><h3>Meal Tracking Mode</h3><p className="muted">Current active mode: <strong>{modeLabel(settings.mealTrackingMode)}</strong></p><label>Meal tracking mode<select value={settings.mealTrackingMode} onChange={(e) => { const selected = e.target.value as MealTrackingMode; if (selected === settings.mealTrackingMode) return; setPendingMode(selected); setShowModeConfirm(true); setModePhrase(''); }}><option value="countdown">Count Down (subtract from available meals)</option><option value="tally">Tally Up (count each served meal)</option></select></label><p className="error">Warning: Switching mode is destructive and will clear all people, transaction history, and import history.</p>{showModeConfirm && pendingMode && <div className="confirm-overlay" role="dialog" aria-modal="true"><div className="confirm-modal stack"><h4>Confirm Mode Switch</h4><p>You are switching from <strong>{modeLabel(settings.mealTrackingMode)}</strong> to <strong>{modeLabel(pendingMode)}</strong>.</p><p className="error">This will permanently clear operational data (people, scans, imports). Accounts and settings will be preserved.</p><p>Type <code>SWITCH MODE</code> to continue.</p><input value={modePhrase} onChange={(e) => setModePhrase(e.target.value)} placeholder="SWITCH MODE" /><div className="button-row"><button className="secondary" type="button" onClick={() => { setShowModeConfirm(false); setPendingMode(null); setModePhrase(''); }}>Cancel</button><button className="danger" type="button" disabled={!modeEnabled} onClick={() => void api('/settings/meal-tracking-mode', { method: 'PUT', body: JSON.stringify({ mealTrackingMode: pendingMode, confirmationPhrase: modePhrase }) }).then(async () => { setMessage(`Meal tracking mode switched to ${modeLabel(pendingMode)}. Operational data was cleared.`); setShowModeConfirm(false); setPendingMode(null); setModePhrase(''); await load(); })}>Switch Mode + Clear Data</button></div></div></div>}</div><div className="grid-form">{Object.keys(settings).filter((k)=>!['id','updatedAt','mealTrackingMode'].includes(k)).map((k)=><label key={k}>{k}<input value={String(settings[k])} onChange={(e)=>setSettings({...settings,[k]:typeof settings[k]==='boolean'?e.target.value==='true':typeof settings[k]==='number'?Number(e.target.value):e.target.value})}/></label>)}</div><div className="button-row"><button className="primary" onClick={() => void saveSettings()}>Save</button></div>{message && <p>{message}</p>}<hr /><div className="stack"><h3>System: Clear Database</h3><p className="error">Warning: This permanently deletes all people, scan transactions, and import history. Admin/scanner login accounts and system settings are preserved.</p><button className="secondary" type="button" onClick={() => { setShowClearConfirm(true); setMessage(''); }}>Open Clear Database Confirmation</button>{showClearConfirm && <div className="card stack"><p>Type <code>CLEAR DATABASE</code> to enable this destructive action.</p><input value={clearPhrase} onChange={(e) => setClearPhrase(e.target.value)} placeholder="CLEAR DATABASE" /><div className="button-row"><button className="secondary" onClick={() => { setShowClearConfirm(false); setClearPhrase(''); }}>Cancel</button><button className="primary" disabled={!clearEnabled} onClick={() => void api('/system/clear-database', { method: 'POST' }).then(async () => { setMessage('Database cleared successfully.'); setShowClearConfirm(false); setClearPhrase(''); await load(); })}>Clear Database</button></div></div>}</div></div>;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <p>Loading...</p>;
  if (!user) return <Login />;

  return <Layout><Routes><Route path="/" element={<Navigate to={user.role === 'ADMIN' ? '/dashboard' : '/scan'} />} /><Route path="/scan" element={<ScanPage />} /><Route path="/dashboard" element={<AdminOnly><Dashboard /></AdminOnly>} /><Route path="/people" element={<AdminOnly><PeoplePage /></AdminOnly>} /><Route path="/import" element={<AdminOnly><ImportPage /></AdminOnly>} /><Route path="/badges" element={<AdminOnly><BadgesPage /></AdminOnly>} /><Route path="/transactions" element={<AdminOnly><TransactionsPage /></AdminOnly>} /><Route path="/reports" element={<AdminOnly><ReportsPage /></AdminOnly>} /><Route path="/settings" element={<AdminOnly><SettingsPage /></AdminOnly>} /></Routes></Layout>;
}
