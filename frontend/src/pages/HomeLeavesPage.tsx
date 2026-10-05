import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";

export type HomeLeave = {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
};

export function HomeLeavesPage() {
  const [homeLeaves, setHomeLeaves] = useState<HomeLeave[]>([]);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function loadHomeLeaves() {
    try {
      setHomeLeaves(await api<HomeLeave[]>("/home-leaves"));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load home leaves");
    }
  }

  useEffect(() => { void loadHomeLeaves(); }, []);

  function resetForm() {
    setName("");
    setStartDate("");
    setEndDate("");
    setEditingId(null);
  }

  async function saveHomeLeave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !startDate || !endDate) {
      setError("Name, start date, and end date are required.");
      return;
    }
    if (endDate < startDate) {
      setError("End date must be on or after start date.");
      return;
    }
    try {
      await api(editingId ? `/home-leaves/${editingId}` : "/home-leaves", {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify({ name: name.trim(), startDate, endDate }),
      });
      setMessage(editingId ? "Home leave updated." : "Home leave added.");
      setError("");
      resetForm();
      await loadHomeLeaves();
    } catch (saveError) {
      setMessage("");
      setError(saveError instanceof Error ? saveError.message : "Unable to save home leave");
    }
  }

  async function deleteHomeLeave(homeLeave: HomeLeave) {
    if (!window.confirm(`Delete “${homeLeave.name}”?`)) return;
    try {
      await api(`/home-leaves/${homeLeave.id}`, { method: "DELETE" });
      if (editingId === homeLeave.id) resetForm();
      setMessage("Home leave deleted.");
      setError("");
      await loadHomeLeaves();
    } catch (deleteError) {
      setMessage("");
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete home leave");
    }
  }

  return (
    <section className="card stack">
      <div>
        <h1>Home Leaves</h1>
        <p className="muted">Add academy-wide leave periods. Inclusive leave dates do not count as missed meal days for students.</p>
      </div>
      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}
      <form className="stack" onSubmit={saveHomeLeave}>
        <div className="form-grid">
          <label>
            Leave name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Christmas Break" maxLength={100} required />
          </label>
          <label>
            Start date
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
          </label>
          <label>
            End date
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required />
          </label>
        </div>
        <div className="actions">
          <button type="submit">{editingId ? "Save Changes" : "Add Home Leave"}</button>
          {editingId && <button type="button" className="secondary" onClick={resetForm}>Cancel</button>}
        </div>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Start Date</th><th>End Date</th><th>Actions</th></tr></thead>
          <tbody>
            {homeLeaves.length === 0 ? (
              <tr><td colSpan={4}>No home leaves have been added.</td></tr>
            ) : homeLeaves.map((homeLeave) => (
              <tr key={homeLeave.id}>
                <td>{homeLeave.name}</td><td>{homeLeave.startDate}</td><td>{homeLeave.endDate}</td>
                <td className="actions">
                  <button type="button" className="secondary" onClick={() => {
                    setEditingId(homeLeave.id); setName(homeLeave.name); setStartDate(homeLeave.startDate); setEndDate(homeLeave.endDate);
                    setError(""); setMessage("");
                  }}>Edit</button>
                  <button type="button" className="danger" onClick={() => void deleteHomeLeave(homeLeave)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
