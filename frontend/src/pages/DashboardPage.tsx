import { useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";

type DashboardSummary = {
  totalPeople: number;
  activePeople: number;
  scansToday: number;
  failedScansToday: number;
  breakfastsServedToday: number;
  lunchesServedToday: number;
  dinnersServedToday: number;
};

const STAT_LABELS: Array<[keyof DashboardSummary, string]> = [
  ["breakfastsServedToday", "Breakfasts served"],
  ["lunchesServedToday", "Lunches served"],
  ["dinnersServedToday", "Dinners served"],
  ["scansToday", "Scans today"],
  ["failedScansToday", "Failed scans today"],
  ["activePeople", "Active people"],
  ["totalPeople", "Total people"],
];

export function Dashboard() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<DashboardSummary>("/dashboard/summary")
      .then(setData)
      .catch((loadError) => setError(errorMessage(loadError, "Unable to load the dashboard.")));
  }, []);
  if (error) return <div className="card"><h2>Today at a glance</h2><p className="error" role="alert">{error}</p></div>;
  if (!data) return <p className="muted">Loading dashboard…</p>;
  return (
    <div className="card">
      <h2>Today at a glance</h2>
      <div className="stats-grid">
        {STAT_LABELS.map(([key, label]) => (
          <div className="stat-card" key={key}>
            <p className="muted">{label}</p>
            <p className="value">{data[key]}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
