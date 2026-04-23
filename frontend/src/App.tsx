import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { api, API_BASE } from './api/client';
import type { MealType, ReportsSummaryResponse, ScanPerson, ScanResponse } from './api/types';
import QrScanner from './components/QrScanner';
import { useAuth } from './context/AuthContext';

function formatMealLabel(meal: string): string {
  return meal.charAt(0) + meal.slice(1).toLowerCase();
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

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Cafeteria Scanner</h1>
        <p className="muted">IMSDA Meal Scanner</p>
        <form onSubmit={onSubmit} className="stack">
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <button className="primary" type="submit">Sign in</button>
          {error && <p className="error">{error}</p>}
        </form>
      </div>
    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const { logout, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const links = isAdmin
    ? [
        ['dashboard', 'Dashboard'],
        ['scan', 'Scan Station'],
        ['people', 'People'],
        ['import', 'Import'],
        ['badges', 'Badges'],
        ['transactions', 'Transactions'],
        ['reports', 'Reports'],
        ['settings', 'Settings']
      ]
    : [['scan', 'Scan Station']];

  return (
    <div>
      <header className="topbar">
        <div className="topbar-inner">
          <a href="https://tools.imsda.org" className="back-link" rel="noreferrer">
            ← Back to Tools
          </a>
          <h2>Cafeteria Scanner</h2>
          <div className="right-actions">
            <span className="user-pill">{user?.username} · {user?.role}</span>
            <button type="button" className="secondary" onClick={() => logout()}>Logout</button>
          </div>
        </div>
        <nav>
          {links.map(([path, label]) => (
            <NavLink key={path} to={`/${path}`} className={({ isActive }) => (isActive ? 'active' : '')}>
              {label}
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
  if (user?.role !== 'ADMIN') {
    return <Navigate to="/scan" replace />;
  }
  return <>{children}</>;
}

function Dashboard() {
  const [data, setData] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    void api<Record<string, number>>('/dashboard/summary').then(setData);
  }, []);
  if (!data) return <p>Loading dashboard…</p>;
  return <div className="card"><h2>Today at a glance</h2><div className="stats-grid">{Object.entries(data).map(([key, value]) => <div className="stat-card" key={key}><p className="muted">{key}</p><p className="value">{value}</p></div>)}</div></div>;
}

type ScanResultState =
  | { ok: true; person: ScanPerson; mealType: MealType }
  | { ok: false; error: string }
  | null;

function ScanResultCard({ result }: { result: ScanResultState }) {
  if (!result) return <div className="scan-result info"><h3>Ready</h3><p>Scan a person ID barcode or use USB scanner/manual ID entry.</p></div>;
  if (!result.ok) return <div className="scan-result fail"><h3>Scan Failed</h3><p>{result.error}</p></div>;

  const remaining = result.mealType === 'BREAKFAST' ? result.person.breakfastRemaining : result.mealType === 'LUNCH' ? result.person.lunchRemaining : result.person.dinnerRemaining;

  return (
    <div className="scan-result success">
      <h3>Meal Recorded</h3>
      <p className="scan-person">{result.person.firstName} {result.person.lastName}</p>
      <p>Meal: <strong>{formatMealLabel(result.mealType)}</strong></p>
      <p>Remaining balance: <strong>{remaining}</strong></p>
    </div>
  );
}

function ScanPage() {
  const [result, setResult] = useState<ScanResultState>(null);
  const [manual, setManual] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<'camera' | 'usb'>('camera');
  const usbInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'usb') usbInputRef.current?.focus();
  }, [mode]);

  const submitScan = async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const response = await api<ScanResponse>('/scan', { method: 'POST', body: JSON.stringify({ personId: trimmed }) });
      setResult({ ok: true, person: response.person, mealType: response.mealType });
      setManual('');
      usbInputRef.current?.focus();
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : 'Unable to process this scan right now.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const onManualSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await submitScan(manual);
  };

  return (
    <div className="scan-layout">
      <section className="card stack">
        <h2>Scan Station</h2>
        <div className="button-row">
          <button className={mode === 'camera' ? 'primary' : 'secondary'} type="button" onClick={() => setMode('camera')}>Camera Scan</button>
          <button className={mode === 'usb' ? 'primary' : 'secondary'} type="button" onClick={() => setMode('usb')}>USB Scanner / Manual ID Entry</button>
        </div>

        <p className="muted">Camera mode requires a secure context (HTTPS or localhost). If this URL is insecure, open the HTTPS dev URL from <code>./scripts/dev.sh</code>. If camera access is blocked/unavailable, use USB Scanner / Manual ID Entry.</p>

        {mode === 'camera' ? (
          <QrScanner onResult={(text) => void submitScan(text)} onError={(message) => setResult({ ok: false, error: message })} />
        ) : (
          <form className="stack" onSubmit={onManualSubmit}>
            <label>
              Person ID input
              <input
                ref={usbInputRef}
                className="scan-input"
                placeholder="Scan with USB scanner or type person ID and press Enter"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                aria-label="Person ID input"
                onBlur={() => setTimeout(() => usbInputRef.current?.focus(), 0)}
              />
            </label>
            <button className="primary" type="submit" disabled={isSubmitting || manual.trim().length === 0}>{isSubmitting ? 'Submitting…' : 'Submit ID'}</button>
          </form>
        )}
      </section>

      <ScanResultCard result={result} />
    </div>
  );
}

function PeoplePage() {
  const [people, setPeople] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ firstName: '', lastName: '', personId: '', codeValue: '', breakfastRemaining: 0, lunchRemaining: 0, dinnerRemaining: 0, active: true });

  const load = () => api<any[]>('/people?showInactive=true').then(setPeople);
  useEffect(() => { void load(); }, []);

  return (
    <div className="card stack">
      <h2>People</h2>
      <form className="grid-form" onSubmit={(e) => { e.preventDefault(); void api('/people', { method: 'POST', body: JSON.stringify(form) }).then(load); }}>
        {['firstName', 'lastName', 'personId', 'codeValue', 'grade', 'group', 'campus'].map((k) => <input key={k} placeholder={k} value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />)}
        <button className="primary">Add</button>
      </form>

      <table>
        <thead><tr><th>Name</th><th>Person ID</th><th>Code</th><th>Breakfast</th><th>Lunch</th><th>Dinner</th><th>Actions</th></tr></thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.id}>
              <td>{p.firstName} {p.lastName}</td>
              <td>{p.personId}</td>
              <td>{p.codeValue}</td>
              <td><input type="number" min={0} value={p.breakfastRemaining} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, breakfastRemaining: Number(e.target.value) } : row))} /></td>
              <td><input type="number" min={0} value={p.lunchRemaining} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, lunchRemaining: Number(e.target.value) } : row))} /></td>
              <td><input type="number" min={0} value={p.dinnerRemaining} onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id ? { ...row, dinnerRemaining: Number(e.target.value) } : row))} /></td>
              <td><button className="small" type="button" onClick={() => void api(`/people/${p.id}`, { method: 'PUT', body: JSON.stringify({ breakfastRemaining: p.breakfastRemaining, lunchRemaining: p.lunchRemaining, dinnerRemaining: p.dinnerRemaining }) }).then(load)}>Save Meals</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

  return <div className="card stack"><h2>Reports</h2><div className="filters-row"><label>From <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label><label>To <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label><button className="primary" type="button" onClick={() => void loadReport()}>Apply Filter</button><a className="button-link" href={`${API_BASE}/reports/export.csv?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`} target="_blank" rel="noreferrer">Export Transactions CSV</a></div>{error && <p className="error">{error}</p>}{report && <div className="stats-grid"><div className="stat-card"><p className="muted">Scans</p><p className="value">{report.stats.scans}</p></div></div>}</div>;
}

function SettingsPage() { const [settings, setSettings] = useState<any>(); useEffect(() => { void api('/settings').then(setSettings); }, []); if (!settings) return <p>Loading...</p>; return <div className="card"><h2>Settings</h2><div className="grid-form">{Object.keys(settings).filter((k)=>k!=='id'&&k!=='updatedAt').map((k)=><label key={k}>{k}<input value={String(settings[k])} onChange={(e)=>setSettings({...settings,[k]:typeof settings[k]==='boolean'?e.target.value==='true':typeof settings[k]==='number'?Number(e.target.value):e.target.value})}/></label>)}</div><button className="primary" onClick={()=>api('/settings',{method:'PUT',body:JSON.stringify(settings)})}>Save</button></div>; }

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <p>Loading...</p>;
  if (!user) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to={user.role === 'ADMIN' ? '/dashboard' : '/scan'} />} />
        <Route path="/scan" element={<ScanPage />} />
        <Route path="/dashboard" element={<AdminOnly><Dashboard /></AdminOnly>} />
        <Route path="/people" element={<AdminOnly><PeoplePage /></AdminOnly>} />
        <Route path="/import" element={<AdminOnly><ImportPage /></AdminOnly>} />
        <Route path="/badges" element={<AdminOnly><BadgesPage /></AdminOnly>} />
        <Route path="/transactions" element={<AdminOnly><TransactionsPage /></AdminOnly>} />
        <Route path="/reports" element={<AdminOnly><ReportsPage /></AdminOnly>} />
        <Route path="/settings" element={<AdminOnly><SettingsPage /></AdminOnly>} />
      </Routes>
    </Layout>
  );
}
