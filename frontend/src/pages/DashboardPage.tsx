import { useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useSchoolMeta } from "../hooks/useSchoolMeta";
import type { SheetSyncMeta } from "../hooks/useSchoolMeta";
import { formatDateTime } from "../lib/format";

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

// Shown while the last recorded sync error is newer than the last successful sync.
function SheetSyncWarning({ sync, timezone }: { sync?: SheetSyncMeta | null; timezone?: string }) {
  if (!sync?.enabled || !sync.lastError) return null;
  const errorTime = sync.lastErrorAt ? Date.parse(sync.lastErrorAt) : NaN;
  const successTime = sync.lastSuccessAt ? Date.parse(sync.lastSuccessAt) : NaN;
  if (!Number.isNaN(errorTime) && !Number.isNaN(successTime) && errorTime <= successTime) return null;
  return (
    <div className="sync-warning-banner" role="alert">
      Google Sheets sync is failing: {sync.lastError}
      {sync.lastErrorAt ? ` (since ${formatDateTime(sync.lastErrorAt, timezone)})` : ""}. Check Settings → Google Sheets Sync.
    </div>
  );
}

export function Dashboard() {
  const { meta } = useSchoolMeta();
  const syncWarning = <SheetSyncWarning sync={meta?.sheetSync} timezone={meta?.timezone} />;
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<DashboardSummary>("/dashboard/summary")
      .then(setData)
      .catch((loadError) => setError(errorMessage(loadError, "Unable to load the dashboard.")));
  }, []);
  if (error) return <>{syncWarning}<div className="card"><h2>Today at a glance</h2><p className="error" role="alert">{error}</p></div></>;
  if (!data) return <p className="muted">Loading dashboard…</p>;
  return (
    <>
    {syncWarning}
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
    </>
  );
}
