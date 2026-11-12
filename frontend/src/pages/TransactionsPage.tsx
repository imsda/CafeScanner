import { useEffect, useMemo, useRef, useState } from "react";
import { api, API_BASE, ApiNetworkError, errorMessage } from "../api/client";
import type { TransactionMealType } from "../api/types";
import { ButtonLink } from "../components/ButtonLink";
import { useSchoolMeta } from "../hooks/useSchoolMeta";
import { getRangeForPreset } from "../lib/dates";
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
  person: { firstName: string; lastName: string; personId: string; personType: string } | null;
};

type Preset = "today" | "last7" | "week" | "month";
type ResultFilter = "ALL" | "SUCCESS" | "FAILURE";
type MealFilter = "ALL" | "BREAKFAST" | "LUNCH" | "DINNER";

const PRESETS: Array<{ value: Preset | "custom"; label: string }> = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom" },
];

const RESULT_OPTIONS: Array<{ value: ResultFilter; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "SUCCESS", label: "Success" },
  { value: "FAILURE", label: "Failed" },
];

const MEAL_OPTIONS: Array<{ value: MealFilter; label: string }> = [
  { value: "ALL", label: "All meals" },
  { value: "BREAKFAST", label: "Breakfast" },
  { value: "LUNCH", label: "Lunch" },
  { value: "DINNER", label: "Dinner" },
];

const PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 300;

// The row total travels in a response header, which api() does not expose. Failed
// responses are replayed through api() so errors and expired sessions are handled as usual.
async function fetchTransactions(path: string): Promise<{ rows: TransactionRow[]; total: number }> {
  const requestUrl = `${API_BASE}${path}`;
  let response: Response;
  try {
    response = await fetch(requestUrl, { credentials: "include" });
  } catch (networkError) {
    throw new ApiNetworkError(requestUrl, networkError);
  }
  if (!response.ok) {
    const rows = await api<TransactionRow[]>(path);
    return { rows, total: rows.length };
  }
  const rows = (await response.json()) as TransactionRow[];
  const total = Number(response.headers.get("X-Total-Count"));
  return { rows, total: Number.isFinite(total) && total >= rows.length ? total : rows.length };
}

export function TransactionsPage() {
  const todayRange = useMemo(() => getRangeForPreset("today"), []);
  const [activePreset, setActivePreset] = useState<Preset | "custom">("today");
  // Draft dates are edited in the Custom form; the applied range is what the table shows.
  const [fromDate, setFromDate] = useState(todayRange.from);
  const [toDate, setToDate] = useState(todayRange.to);
  const [appliedRange, setAppliedRange] = useState(todayRange);
  const [resultFilter, setResultFilter] = useState<ResultFilter>("ALL");
  const [mealFilter, setMealFilter] = useState<MealFilter>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [refreshCount, setRefreshCount] = useState(0);

  const [rows, setRows] = useState<TransactionRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const latestRequest = useRef(0);
  const { meta } = useSchoolMeta();

  // Apply the search a moment after typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchInput.trim();
      setSearch((current) => {
        if (current !== next) setOffset(0);
        return next;
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Shared by the table request and the Export CSV link.
  const filterParams = useMemo(() => {
    const params: Record<string, string> = { from: appliedRange.from, to: appliedRange.to };
    if (resultFilter !== "ALL") params.result = resultFilter;
    if (mealFilter !== "ALL") params.mealType = mealFilter;
    if (search) params.q = search;
    return params;
  }, [appliedRange, resultFilter, mealFilter, search]);

  useEffect(() => {
    const requestId = ++latestRequest.current;
    setIsLoading(true);
    const query = new URLSearchParams({ ...filterParams, limit: String(PAGE_SIZE), offset: String(offset) });
    fetchTransactions(`/transactions?${query}`)
      .then((loaded) => {
        if (requestId !== latestRequest.current) return;
        // The last page can empty out when rows are filtered away; step back to the new last page.
        if (loaded.rows.length === 0 && loaded.total > 0 && offset > 0) {
          setOffset(Math.floor((loaded.total - 1) / PAGE_SIZE) * PAGE_SIZE);
          return;
        }
        setRows(loaded.rows);
        setTotal(loaded.total);
        setError("");
        setIsLoading(false);
      })
      .catch((loadError) => {
        if (requestId !== latestRequest.current) return;
        setError(errorMessage(loadError, "Unable to load transactions."));
        setIsLoading(false);
      });
  }, [filterParams, offset, refreshCount]);

  function choosePreset(preset: Preset | "custom") {
    setActivePreset(preset);
    if (preset === "custom") return;
    const range = getRangeForPreset(preset);
    setFromDate(range.from);
    setToDate(range.to);
    setAppliedRange(range);
    setOffset(0);
  }

  function applyCustomRange() {
    if (!fromDate || !toDate) return;
    setAppliedRange({ from: fromDate, to: toDate });
    setOffset(0);
  }

  function clearFilters() {
    setResultFilter("ALL");
    setMealFilter("ALL");
    setSearchInput("");
    setSearch("");
    setOffset(0);
  }

  const exportHref = `${API_BASE}/transactions/export.csv?${new URLSearchParams(filterParams)}`;
  const hasExtraFilters = resultFilter !== "ALL" || mealFilter !== "ALL" || search !== "";
  const firstRow = total === 0 ? 0 : offset + 1;
  const lastRow = offset + (rows?.length ?? 0);
  const hasPrevious = offset > 0;
  const hasNext = lastRow < total;

  return (
    <div className="card stack">
      <div className="reports-header">
        <h2>
          Transactions
          {rows && <span className="count-badge">{total.toLocaleString()}</span>}
        </h2>
        <div className="report-downloads">
          <button type="button" className="small" disabled={isLoading} onClick={() => setRefreshCount((count) => count + 1)}>
            {isLoading ? "Loading…" : "Refresh"}
          </button>
          <ButtonLink href={exportHref} className="btn-secondary small" target="_blank" rel="noreferrer">
            Export CSV
          </ButtonLink>
        </div>
      </div>

      <section className="report-filters" aria-label="Transaction filters">
        <div className="report-filters-row">
          <div className="segmented" role="group" aria-label="Date range">
            {PRESETS.map((preset) => (
              <button key={preset.value} type="button" aria-pressed={activePreset === preset.value}
                onClick={() => choosePreset(preset.value)}>
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        {activePreset === "custom" && (
          <form className="report-filters-row" onSubmit={(event) => { event.preventDefault(); applyCustomRange(); }}>
            <label className="inline-field">From<input type="date" required value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} /></label>
            <label className="inline-field">To<input type="date" required value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} /></label>
            <button type="submit" className="primary">Show transactions</button>
          </form>
        )}
        <div className="report-filters-row">
          <div className="inline-field">
            <span id="transactions-result-label">Result</span>
            <div className="segmented" role="group" aria-labelledby="transactions-result-label">
              {RESULT_OPTIONS.map((option) => (
                <button key={option.value} type="button" aria-pressed={resultFilter === option.value}
                  onClick={() => { setResultFilter(option.value); setOffset(0); }}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label className="inline-field">
            Meal
            <select value={mealFilter} onChange={(event) => { setMealFilter(event.target.value as MealFilter); setOffset(0); }}>
              {MEAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="inline-field grow">
            Search
            <input type="search" value={searchInput} placeholder="Name, Person ID or scanned value"
              onChange={(event) => setSearchInput(event.target.value)} />
          </label>
        </div>
      </section>

      {error && <p className="error" role="alert">{error}</p>}
      {!rows && !error && <p className="muted">Loading transactions…</p>}

      {rows && (
        <>
          <div className="report-context" aria-live="polite">
            <p className="muted">
              {total === 0
                ? "No matching transactions"
                : `Showing ${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${total.toLocaleString()}`}
              {isLoading && " · Updating…"}
            </p>
            {(hasPrevious || hasNext) && (
              <div className="report-downloads">
                <button type="button" className="small" disabled={!hasPrevious || isLoading}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  Previous
                </button>
                <button type="button" className="small" disabled={!hasNext || isLoading}
                  onClick={() => setOffset(offset + PAGE_SIZE)}>
                  Next
                </button>
              </div>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="empty-state">
              No transactions match these filters.
              {hasExtraFilters && (
                <> <button type="button" className="link-button" onClick={clearFilters}>Clear filters</button></>
              )}
            </p>
          ) : (
            <div className="table-scroll">
              <table className="report-table transactions-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Person</th>
                    <th scope="col" className="num">Person ID</th>
                    <th scope="col">Type</th>
                    <th scope="col">Meal</th>
                    <th scope="col">Result</th>
                    <th scope="col">Reason</th>
                    <th scope="col" className="num">Scanned value</th>
                    <th scope="col">Station</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const personName = row.entitlementPersonName
                      || (row.person ? `${row.person.firstName} ${row.person.lastName}`.trim() : "");
                    return (
                      <tr key={row.id}>
                        <td className="nowrap">{formatDateTime(row.timestamp, meta?.timezone)}</td>
                        <td>{personName || <span className="muted">Unknown</span>}</td>
                        <td className="num mono">{row.person?.personId ?? "-"}</td>
                        <td>
                          {row.person?.personType
                            ? <span className={`type-pill type-${row.person.personType.toLowerCase()}`}>{formatPersonType(row.person.personType)}</span>
                            : "-"}
                        </td>
                        <td>{row.mealType === "NONE" ? "-" : formatMealLabel(row.mealType)}</td>
                        <td>
                          <span className={`type-pill result-${row.result.toLowerCase()}`}>
                            {row.result === "SUCCESS" ? "Success" : "Failed"}
                          </span>
                        </td>
                        <td>{row.failureReason ? humanizeCode(row.failureReason) : "-"}</td>
                        <td className="num mono">{row.scannedValue}</td>
                        <td>{row.stationName || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
