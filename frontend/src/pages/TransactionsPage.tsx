import { useEffect, useState } from "react";
import { api, API_BASE } from "../api/client";
import { ButtonLink } from "../components/ButtonLink";
import { formatPersonType } from "../lib/format";

export function TransactionsPage() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    void api<any[]>("/transactions").then(setRows);
  }, []);
  return (
    <div className="card stack">
      <h2>Transactions</h2>
      <div className="button-row">
        <ButtonLink
          href={`${API_BASE}/transactions/export.csv`}
          className="btn-secondary"
          target="_blank"
          rel="noreferrer"
        >
          Export CSV
        </ButtonLink>
      </div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Value</th>
            <th>Meal</th>
            <th>Result</th>
            <th>Reason</th>
            <th>Person</th>
            <th>Type</th>
            <th>Station</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.timestamp).toLocaleString()}</td>
              <td>{r.scannedValue}</td>
              <td>{r.mealType}</td>
              <td>{r.result}</td>
              <td>{r.failureReason || "-"}</td>
              <td>
                {r.entitlementPersonName ||
                  (r.person
                    ? `${r.person.firstName} ${r.person.lastName}`
                    : "-")}
              </td>
              <td>{r.person?.personType ? formatPersonType(r.person.personType) : "-"}</td>
              <td>{r.stationName || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
