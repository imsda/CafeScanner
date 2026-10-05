import { useEffect, useState } from "react";
import { api, API_BASE, errorMessage } from "../api/client";
import type { TransactionMealType } from "../api/types";
import { ButtonLink } from "../components/ButtonLink";
import { useSchoolMeta } from "../hooks/useSchoolMeta";
import { formatDateTime, formatMealLabel, formatPersonType, humanizeCode } from "../lib/format";

type TransactionRow = {
  id: number;
  timestamp: string;
  scannedValue: string;
  mealType: TransactionMealType;
  result: "SUCCESS" | "FAILURE";
  failureReason: string | null;
  stationName: string | null;
  entitlementPersonName: string | null;
  person: { firstName: string; lastName: string; personType: string } | null;
};

export function TransactionsPage() {
  const [rows, setRows] = useState<TransactionRow[] | null>(null);
  const [error, setError] = useState("");
  const { meta } = useSchoolMeta();
  useEffect(() => {
    api<TransactionRow[]>("/transactions")
      .then(setRows)
      .catch((loadError) => setError(errorMessage(loadError, "Unable to load transactions.")));
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
      {error && <p className="error" role="alert">{error}</p>}
      {!rows && !error && <p className="muted">Loading transactions…</p>}
      {rows && rows.length === 0 && <p className="muted">No transactions yet.</p>}
      {rows && rows.length > 0 && (
        <div className="table-scroll">
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
                  <td>{formatDateTime(r.timestamp, meta?.timezone)}</td>
                  <td>{r.scannedValue}</td>
                  <td>{r.mealType === "NONE" ? "-" : formatMealLabel(r.mealType)}</td>
                  <td>{r.result === "SUCCESS" ? "Success" : "Failed"}</td>
                  <td>{r.failureReason ? humanizeCode(r.failureReason) : "-"}</td>
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
      )}
      {rows && rows.length >= 1000 && <p className="muted">Showing the 1,000 most recent transactions. Use Export CSV for the full history.</p>}
    </div>
  );
}
