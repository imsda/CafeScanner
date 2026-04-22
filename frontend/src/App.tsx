import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useState } from 'react';
import { api, API_BASE } from './api/client';
import QrScanner from './components/QrScanner';
import { QRCodeSVG } from 'qrcode.react';

function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return <div className="center-card"><h1>CafeScanner Login</h1><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username"/><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password"/><button onClick={() => login(username, password).catch((e) => setError(e.message))}>Login</button><p className="error">{error}</p></div>;
}

function Layout({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth();
  const links = ['dashboard', 'scan', 'people', 'import', 'badges', 'transactions', 'reports', 'settings'];
  return <div><header><h2>CafeScanner</h2><nav>{links.map((l) => <NavLink key={l} to={`/${l}`}>{l}</NavLink>)}<button onClick={() => logout()}>Logout</button></nav></header><main>{children}</main></div>;
}

function Dashboard() {
  const [data, setData] = useState<any>();
  useState(() => { api('/dashboard/summary').then(setData); });
  if (!data) return <p>Loading...</p>;
  return <div className="grid">{Object.entries(data).map(([k, v]) => <div className="tile" key={k}><h3>{k}</h3><p>{String(v)}</p></div>)}</div>;
}

function ScanPage() {
  const [result, setResult] = useState<any>(null);
  const [manual, setManual] = useState('');
  const [settings, setSettings] = useState<any>(null);
  useState(() => { api('/settings').then(setSettings); });

  async function submit(code: string) {
    try {
      const res = await api('/scan', { method: 'POST', body: JSON.stringify({ scannedValue: code }) });
      setResult({ ok: true, ...res });
      if (settings?.enableSounds) new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA').play().catch(() => {});
    } catch (e: any) {
      setResult({ ok: false, error: e.message });
    }
  }

  return <div className="scan-wrap"><div><QrScanner onResult={submit} onError={(m) => setResult({ ok: false, error: m })}/><div className="manual"><input placeholder="Manual code" value={manual} onChange={(e)=>setManual(e.target.value)}/><button onClick={()=>submit(manual)}>Submit</button></div></div><div className={result?.ok ? 'scan-success' : 'scan-fail'}>{result ? (result.ok ? <><h1>SUCCESS</h1><p>{result.person.firstName} {result.person.lastName}</p><p>Meal: {result.mealType}</p><p>Remaining: {result.mealType==='BREAKFAST'?result.person.breakfastRemaining:result.mealType==='LUNCH'?result.person.lunchRemaining:result.person.dinnerRemaining}</p></> : <><h1>FAILED</h1><p>{result.error}</p></>) : <p>Ready to scan</p>}</div></div>;
}

function PeoplePage() {
  const [people, setPeople] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ firstName: '', lastName: '', personId: '', breakfastRemaining: 0, lunchRemaining: 0, dinnerRemaining: 0, active: true });
  const load = () => api<any[]>('/people?showInactive=true').then(setPeople);
  useState(() => { load(); });
  return <div><h2>People</h2><form className="grid-form" onSubmit={(e)=>{e.preventDefault();api('/people',{method:'POST',body:JSON.stringify(form)}).then(load);}}>{['firstName','lastName','personId','codeValue','grade','group','campus'].map((k)=><input key={k} placeholder={k} value={form[k]||''} onChange={(e)=>setForm({...form,[k]:e.target.value})}/>)}<button>Add</button></form><table><thead><tr><th>Name</th><th>ID</th><th>Code</th><th>B/L/D</th><th>Active</th></tr></thead><tbody>{people.map((p)=><tr key={p.id}><td>{p.firstName} {p.lastName}</td><td>{p.personId}</td><td>{p.codeValue}</td><td>{p.breakfastRemaining}/{p.lunchRemaining}/{p.dinnerRemaining}</td><td>{String(p.active)}</td></tr>)}</tbody></table></div>;
}

function ImportPage() {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<any>();
  const [result, setResult] = useState<any>();

  async function previewFile() {
    const form = new FormData(); form.append('file', file!);
    const res = await fetch(`${API_BASE}/import/preview`, { method: 'POST', credentials: 'include', body: form });
    setPreview(await res.json());
  }
  async function commit() {
    const form = new FormData(); form.append('file', file!); form.append('generateMissingCodes', 'true');
    const res = await fetch(`${API_BASE}/import/commit`, { method: 'POST', credentials: 'include', body: form });
    setResult(await res.json());
  }
  return <div><h2>CSV Import</h2><a href={`${API_BASE}/import/template`} target="_blank">Download Template</a><input type="file" accept=".csv" onChange={(e)=>setFile(e.target.files?.[0])}/><button onClick={previewFile} disabled={!file}>Preview</button><button onClick={commit} disabled={!file}>Commit Partial Import</button>{preview && <pre>{JSON.stringify(preview, null, 2)}</pre>}{result && <pre>{JSON.stringify(result, null, 2)}</pre>}</div>;
}

function BadgesPage() {
  const [people, setPeople] = useState<any[]>([]);
  useState(() => { api<any[]>('/people?showInactive=true').then(setPeople); });
  return <div><h2>Printable QR Badges</h2><button onClick={() => window.print()}>Print Sheet</button><div className="badge-grid">{people.map((p)=><div className="badge" key={p.id}><QRCodeSVG value={p.codeValue} size={90}/><p>{p.firstName} {p.lastName}</p><small>{p.personId}</small></div>)}</div></div>;
}

function TransactionsPage() {
  const [rows, setRows] = useState<any[]>([]);
  useState(() => { api<any[]>('/transactions').then(setRows); });
  return <div><h2>Transactions</h2><a href={`${API_BASE}/transactions/export.csv`} target="_blank">Export CSV</a><table><thead><tr><th>Time</th><th>Value</th><th>Meal</th><th>Result</th><th>Reason</th><th>Person</th><th>Station</th></tr></thead><tbody>{rows.map((r)=><tr key={r.id}><td>{new Date(r.timestamp).toLocaleString()}</td><td>{r.scannedValue}</td><td>{r.mealType}</td><td>{r.result}</td><td>{r.failureReason||'-'}</td><td>{r.person?`${r.person.firstName} ${r.person.lastName}`:'-'}</td><td>{r.stationName||'-'}</td></tr>)}</tbody></table></div>;
}

function ReportsPage() {
  const [report, setReport] = useState<any>();
  useState(() => { api('/reports/meal-usage').then(setReport); });
  return <div><h2>Reports</h2><pre>{JSON.stringify(report, null, 2)}</pre></div>;
}

function SettingsPage() {
  const [settings, setSettings] = useState<any>();
  useState(() => { api('/settings').then(setSettings); });
  if (!settings) return <p>Loading...</p>;
  return <div><h2>Settings</h2><div className="grid-form">{Object.keys(settings).filter((k)=>k!=='id'&&k!=='updatedAt').map((k)=><label key={k}>{k}<input value={String(settings[k])} onChange={(e)=>setSettings({...settings,[k]:typeof settings[k]==='boolean'?e.target.value==='true':typeof settings[k]==='number'?Number(e.target.value):e.target.value})}/></label>)}</div><button onClick={()=>api('/settings',{method:'PUT',body:JSON.stringify(settings)})}>Save</button></div>;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <p>Loading...</p>;
  if (!user) return <Login />;
  return <Layout><Routes><Route path="/" element={<Navigate to="/dashboard"/>}/><Route path="/dashboard" element={<Dashboard/>}/><Route path="/scan" element={<ScanPage/>}/><Route path="/people" element={<PeoplePage/>}/><Route path="/import" element={<ImportPage/>}/><Route path="/badges" element={<BadgesPage/>}/><Route path="/transactions" element={<TransactionsPage/>}/><Route path="/reports" element={<ReportsPage/>}/><Route path="/settings" element={<SettingsPage/>}/></Routes></Layout>;
}
