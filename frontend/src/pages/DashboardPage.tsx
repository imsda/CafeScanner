import { useEffect, useState } from "react";
import { api } from "../api/client";

export function Dashboard() {
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
