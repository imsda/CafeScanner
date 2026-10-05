import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { StudentsNotEatingResponse } from "../api/types";
import { formatPersonType } from "../lib/format";
import { useAuth } from "../context/AuthContext";

export function StudentsNotEatingPanel() {
  const [data, setData] = useState<StudentsNotEatingResponse | null>(null);
  const [error, setError] = useState("");
  const [clearingId, setClearingId] = useState<number | null>(null);
  const [savingVillageSetting, setSavingVillageSetting] = useState(false);
  const { user } = useAuth();
  const isAdmin = user?.role === "OWNER" || user?.role === "ADMIN";

  const setVillageWarnings = async (enabled: boolean) => {
    setSavingVillageSetting(true);
    try {
      setData(await api<StudentsNotEatingResponse>("/reports/students-not-eating/settings", {
        method: "PUT",
        body: JSON.stringify({ villageStudentMealWarningsEnabled: enabled }),
      }));
      setError("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to update village student warnings.");
    } finally {
      setSavingVillageSetting(false);
    }
  };

  const load = async () => {
    try {
      setData(await api<StudentsNotEatingResponse>("/reports/students-not-eating"));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load students not eating.");
    }
  };

  useEffect(() => { void load(); }, []);

  return <section className="stack">
    <div>
      <h3>Students Not Eating</h3>
      <p className="muted">Students with no successful meal scan for at least the configured number of complete days.</p>
    </div>
    {error && <p className="error">{error}</p>}
    {data?.mealTrackingMode !== "tally" && data && (
      <p className="muted">This report is available when Meal Tracking is set to Tally Up.</p>
    )}
    {data?.mealTrackingMode === "tally" && (
      <>
        <p className="muted">Current warning threshold: <strong>{data.warningDays} complete day{data.warningDays === 1 ? "" : "s"}</strong></p>
        {isAdmin ? (
          <label>
            <input
              type="checkbox"
              checked={data.villageStudentMealWarningsEnabled}
              disabled={savingVillageSetting}
              onChange={(event) => void setVillageWarnings(event.target.checked)}
            />
            Include village students in meal warnings
          </label>
        ) : !data.villageStudentMealWarningsEnabled && (
          <p className="muted">Village students are excluded from meal warnings.</p>
        )}
        {data.students.length === 0 ? <p>No students currently meet the warning threshold.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Person ID</th><th>Type</th><th>Complete Days Missed</th><th>Last Recorded Meal</th><th>Action</th></tr></thead>
            <tbody>{data.students.map((student) => <tr key={student.id}>
              <td>{student.firstName} {student.lastName}</td>
              <td>{student.personId}</td>
              <td>{formatPersonType(student.personType)}</td>
              <td>{student.missedDays}</td>
              <td>{student.lastMealAt ? new Date(student.lastMealAt).toLocaleString() : "No recorded meal"}</td>
              <td><button type="button" className="secondary" disabled={clearingId === student.id} onClick={() => {
                setClearingId(student.id);
                void api(`/reports/students-not-eating/${student.id}/clear`, { method: "POST" })
                  .then(load)
                  .catch((clearError) => setError(clearError instanceof Error ? clearError.message : "Unable to clear warning."))
                  .finally(() => setClearingId(null));
              }}>{clearingId === student.id ? "Clearing…" : "Clear Warning"}</button></td>
            </tr>)}</tbody>
          </table>
        )}
      </>
    )}
  </section>;
}
