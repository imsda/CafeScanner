import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../api/client";

export function ScannerPreferencesPage() {
  const [delay, setDelay] = useState("1");
  const [useDefault, setUseDefault] = useState(true);
  const [defaultDelay, setDefaultDelay] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ personalScanDelay: number | null; defaultScanDelay: number; scannerCooldownSeconds: number }>("/scan/settings")
      .then((settings) => { setDelay(String(settings.scannerCooldownSeconds)); setUseDefault(settings.personalScanDelay === null); setDefaultDelay(settings.defaultScanDelay); setLoaded(true); })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load settings."));
  }, []);
  return <section className="card stack">
    <h2>My Scanner Settings</h2>
    <p>Choose how long to wait before scanning the same ID again. This applies to your account on both USB and camera scanners.</p>
    <p>Student meal limits still apply.</p>
    <form className="stack" onSubmit={async (event) => {
      event.preventDefault(); setSaving(true); setMessage(""); setError("");
      try {
        await api("/scan/settings", { method: "PUT", body: JSON.stringify({ scannerCooldownSeconds: useDefault ? null : Number(delay) }) });
        setMessage("Saved. Your delay will apply when you return to Scan Station.");
      } catch (err) { setError(err instanceof Error ? err.message : "Unable to save settings."); }
      finally { setSaving(false); }
    }}>
      <label><input type="checkbox" checked={useDefault} disabled={!loaded || saving} onChange={(e) => setUseDefault(e.target.checked)} /> Use school default ({defaultDelay} seconds)</label>
      <label>Scan delay (seconds)
        <input type="number" min="0.5" max="10" step="0.1" required value={useDefault ? defaultDelay : delay}
          disabled={!loaded || saving || useDefault} onChange={(e) => setDelay(e.target.value)} />
      </label>
      <button type="submit" className="primary" disabled={!loaded || saving}>{saving ? "Saving…" : "Save my scan delay"}</button>
    </form>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <NavLink to="/scan">Back to Scan Station</NavLink>
  </section>;
}
