import { useEffect, useMemo, useState } from "react";
import { api, API_BASE } from "../api/client";
import type { ReportsSummaryResponse } from "../api/types";
import { ButtonLink } from "../components/ButtonLink";
import { StudentsNotEatingPanel } from "../components/StudentsNotEatingPanel";
import { getRangeForPreset } from "../lib/dates";
import { formatPersonType, modeLabel } from "../lib/format";
import {
  matchesPersonTypeFilter,
  mealTotalsByPersonType,
  personTypeSortRank,
  PERSON_TYPE_FILTER_OPTIONS,
  personTypeFilterLabel,
  sumMealTotals,
} from "../lib/personTypeTotals";
import type { PersonTypeFilter } from "../lib/personTypeTotals";

type MealTotalsSortKey = "name" | "personId" | "type" | "total" | "breakfasts" | "lunches" | "dinners";

const SORT_OPTIONS: Array<{ key: MealTotalsSortKey; label: string; defaultDirection: "asc" | "desc" }> = [
  { key: "name", label: "Name", defaultDirection: "asc" },
  { key: "personId", label: "Person ID", defaultDirection: "asc" },
  { key: "type", label: "Type", defaultDirection: "asc" },
  { key: "total", label: "Total Meals", defaultDirection: "desc" },
  { key: "breakfasts", label: "Breakfast", defaultDirection: "desc" },
  { key: "lunches", label: "Lunch", defaultDirection: "desc" },
  { key: "dinners", label: "Dinner", defaultDirection: "desc" },
];

type MealTotalsRow = ReportsSummaryResponse["mealTotalsByPerson"][number];

const byName = (a: MealTotalsRow, b: MealTotalsRow) =>
  `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, undefined, { sensitivity: "base" });

function compareMealTotals(a: MealTotalsRow, b: MealTotalsRow, key: MealTotalsSortKey): number {
  switch (key) {
    case "name": return byName(a, b);
    case "personId": return a.personId.localeCompare(b.personId, undefined, { numeric: true });
    // Group by type, then alphabetical by name within each type.
    case "type": return personTypeSortRank(a.personType) - personTypeSortRank(b.personType) || byName(a, b);
    default: return a[key] - b[key] || byName(a, b);
  }
}

export function ReportsPage() {
  const todayRange = useMemo(() => getRangeForPreset("today"), []);
  const [fromDate, setFromDate] = useState(todayRange.from);
  const [toDate, setToDate] = useState(todayRange.to);
  const [appliedFromDate, setAppliedFromDate] = useState(todayRange.from);
  const [appliedToDate, setAppliedToDate] = useState(todayRange.to);
  const [activePreset, setActivePreset] = useState<
    "custom" | "today" | "last7" | "week" | "month" | "year"
  >("today");
  const [report, setReport] = useState<ReportsSummaryResponse | null>(null);
  const [error, setError] = useState("");
  const [activeReportView, setActiveReportView] = useState<"meal-report" | "students-not-eating">("meal-report");
  const [reportSearch, setReportSearch] = useState("");
  const [sortKey, setSortKey] = useState<MealTotalsSortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [personTypeFilter, setPersonTypeFilter] = useState<PersonTypeFilter>("ALL");

  async function loadReport(range?: { from: string; to: string }) {
    const selectedRange = range ?? { from: fromDate, to: toDate };
    try {
      const query = new URLSearchParams({
        from: selectedRange.from,
        to: selectedRange.to,
        startDate: selectedRange.from,
        endDate: selectedRange.to,
      });
      const data = await api<ReportsSummaryResponse>(
        `/reports/summary?${query.toString()}`,
      );
      setReport(data);
      setAppliedFromDate(selectedRange.from);
      setAppliedToDate(selectedRange.to);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load report",
      );
    }
  }

  function applyPreset(preset: "today" | "last7" | "week" | "month" | "year") {
    const range = getRangeForPreset(preset);
    setFromDate(range.from);
    setToDate(range.to);
    setActivePreset(preset);
    void loadReport(range);
  }

  useEffect(() => {
    void loadReport();
  }, []);

  const mealTotals = report?.mealTotalsByPerson ?? report?.perPersonUsage ?? [];
  const filteredMealTotals = useMemo(() => {
    const query = reportSearch.trim().toLowerCase();
    const direction = sortDirection === "asc" ? 1 : -1;
    return mealTotals.filter((row) => {
      if (!matchesPersonTypeFilter(row.personType, personTypeFilter)) return false;
      if (!query) return true;
      return `${row.firstName} ${row.lastName}`.toLowerCase().includes(query)
        || row.personId.toLowerCase().includes(query);
    }).sort((a, b) => direction * compareMealTotals(a, b, sortKey));
  }, [mealTotals, personTypeFilter, reportSearch, sortKey, sortDirection]);

  // Clicking the active column flips the direction; a new column starts in its natural direction.
  function sortBy(key: MealTotalsSortKey) {
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(SORT_OPTIONS.find((option) => option.key === key)?.defaultDirection ?? "asc");
  }

  const sortHeader = (key: MealTotalsSortKey, label: string) => (
    <th key={key} aria-sort={sortKey === key ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort-button" onClick={() => sortBy(key)}>
        {label}
        <span aria-hidden="true" className="sort-indicator">
          {sortKey === key ? (sortDirection === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
  // Totals for the selected person type over the date range (search does not narrow them).
  const selectedTypeTotals = useMemo(
    () => sumMealTotals(mealTotals.filter((row) => matchesPersonTypeFilter(row.personType, personTypeFilter))),
    [mealTotals, personTypeFilter],
  );
  const typeBreakdown = useMemo(() => mealTotalsByPersonType(mealTotals), [mealTotals]);
  const exportQuery = new URLSearchParams({
    from: appliedFromDate,
    to: appliedToDate,
    startDate: appliedFromDate,
    endDate: appliedToDate,
  }).toString();
  const mealTotalsExportQuery = new URLSearchParams({
    from: appliedFromDate,
    to: appliedToDate,
    startDate: appliedFromDate,
    endDate: appliedToDate,
    ...(personTypeFilter !== "ALL" ? { personType: personTypeFilter } : {}),
  }).toString();

  const reportTabs = <div className="button-row">
    <button type="button" className={activeReportView === "meal-report" ? "primary" : "secondary"}
      onClick={() => setActiveReportView("meal-report")}>Meal Report</button>
    <button type="button" className={activeReportView === "students-not-eating" ? "primary" : "secondary"}
      onClick={() => setActiveReportView("students-not-eating")}>Students Not Eating</button>
  </div>;

  if (activeReportView === "students-not-eating") {
    return <div className="card stack"><h2>Reports</h2>{reportTabs}<StudentsNotEatingPanel /></div>;
  }

  return (
    <div className="card stack">
      <h2>Reports</h2>
      {reportTabs}
      <div className="stack report-controls">
        <div className="button-row">
          <button
            type="button"
            className={activePreset === "today" ? "primary" : "secondary"}
            onClick={() => applyPreset("today")}
          >
            Today
          </button>
          <button
            type="button"
            className={activePreset === "last7" ? "primary" : "secondary"}
            onClick={() => applyPreset("last7")}
          >
            Last 7 Days
          </button>
          <button
            type="button"
            className={activePreset === "week" ? "primary" : "secondary"}
            onClick={() => applyPreset("week")}
          >
            Current Week
          </button>
          <button
            type="button"
            className={activePreset === "month" ? "primary" : "secondary"}
            onClick={() => applyPreset("month")}
          >
            Current Month
          </button>
          <button
            type="button"
            className={activePreset === "year" ? "primary" : "secondary"}
            onClick={() => applyPreset("year")}
          >
            Current Year
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setActivePreset("custom")}
            disabled={activePreset === "custom"}
          >
            Custom Range
          </button>
        </div>
        <div className="filters-row">
          <label>
            From{" "}
            <input
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setActivePreset("custom");
              }}
            />
          </label>
          <label>
            To{" "}
            <input
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setActivePreset("custom");
              }}
            />
          </label>
          <label>
            Person type
            <select value={personTypeFilter}
              onChange={(event) => setPersonTypeFilter(event.target.value as PersonTypeFilter)}>
              {PERSON_TYPE_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            type="button"
            onClick={() => void loadReport()}
          >
            Apply Filter
          </button>
          <ButtonLink
            className="btn-secondary"
            href={`${API_BASE}/reports/export.csv?${exportQuery}`}
            target="_blank"
            rel="noreferrer"
          >
            Export Transactions CSV
          </ButtonLink>
          <ButtonLink
            className="btn-secondary"
            href={`${API_BASE}/reports/meal-totals.csv?${mealTotalsExportQuery}`}
            target="_blank"
            rel="noreferrer"
          >
            Export Meal Totals CSV
          </ButtonLink>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {report && (
        <>
          <p className="muted">
            Active mode: <strong>{modeLabel(report.mealTrackingMode)}</strong>
          </p>
          <section className="stack" aria-live="polite">
            <h3>Meals Served — {personTypeFilterLabel(personTypeFilter)}</h3>
            <div className="stats-grid">
              <div className="stat-card"><p className="muted">People Served</p><p className="value">{selectedTypeTotals.people}</p></div>
              <div className="stat-card"><p className="muted">Breakfasts</p><p className="value">{selectedTypeTotals.breakfasts}</p></div>
              <div className="stat-card"><p className="muted">Lunches</p><p className="value">{selectedTypeTotals.lunches}</p></div>
              <div className="stat-card"><p className="muted">Dinners</p><p className="value">{selectedTypeTotals.dinners}</p></div>
              <div className="stat-card"><p className="muted">Total Meals</p><p className="value">{selectedTypeTotals.total}</p></div>
            </div>
          </section>
          <section className="stack">
            <h3>Meals by Person Type</h3>
            <div className="table-scroll">
              <table className="type-totals">
                <thead>
                  <tr>
                    <th>Person type</th>
                    <th>People served</th>
                    <th>Breakfast</th>
                    <th>Lunch</th>
                    <th>Dinner</th>
                    <th>Total meals</th>
                  </tr>
                </thead>
                <tbody>
                  {typeBreakdown.map((row) => (
                    <tr key={row.filter} className={[row.summary ? "summary-row" : "", row.filter === personTypeFilter ? "selected-row" : ""].join(" ").trim() || undefined}>
                      <th scope="row">
                        <button type="button" className="link-button" onClick={() => setPersonTypeFilter(row.filter)}
                          aria-pressed={row.filter === personTypeFilter}>
                          {row.label}
                        </button>
                      </th>
                      <td>{row.totals.people}</td>
                      <td>{row.totals.breakfasts}</td>
                      <td>{row.totals.lunches}</td>
                      <td>{row.totals.dinners}</td>
                      <td>{row.totals.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <h3>{report.mealTrackingMode === "camp_meeting" ? "Entitlements" : report.mealTrackingMode === "countdown" ? "Balances" : "Tally"} — All types</h3>
          <div className="stats-grid">
            <div className="stat-card">
              <p className="muted">Scans</p>
              <p className="value">{report.stats.scans}</p>
            </div>
            <div className="stat-card">
              <p className="muted">Failed Scans</p>
              <p className="value">{report.stats.failedScans}</p>
            </div>
            {report.mealTrackingMode === "camp_meeting" ? (
              <>
                <div className="stat-card">
                  <p className="muted">Total Entitlements</p>
                  <p className="value">
                    {report.entitlementSummary.totalEntitlements}
                  </p>
                </div>
                <div className="stat-card">
                  <p className="muted">Total Redeemed</p>
                  <p className="value">
                    {report.entitlementSummary.totalRedeemed}
                  </p>
                </div>
                <div className="stat-card">
                  <p className="muted">Unused Entitlements</p>
                  <p className="value">
                    {report.entitlementSummary.totalRemaining}
                  </p>
                </div>
              </>
            ) : report.mealTrackingMode === "countdown" ? (
              <>
                <div className="stat-card">
                  <p className="muted">Breakfast Remaining</p>
                  <p className="value">
                    {report.remainingBalanceSummary.breakfastRemaining}
                  </p>
                </div>
                <div className="stat-card">
                  <p className="muted">Lunch Remaining</p>
                  <p className="value">
                    {report.remainingBalanceSummary.lunchRemaining}
                  </p>
                </div>
                <div className="stat-card">
                  <p className="muted">Dinner Remaining</p>
                  <p className="value">
                    {report.remainingBalanceSummary.dinnerRemaining}
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="stat-card">
                  <p className="muted">Breakfast Tally</p>
                  <p className="value">{report.tallySummary.breakfastCount}</p>
                </div>
                <div className="stat-card">
                  <p className="muted">Lunch Tally</p>
                  <p className="value">{report.tallySummary.lunchCount}</p>
                </div>
                <div className="stat-card">
                  <p className="muted">Dinner Tally</p>
                  <p className="value">{report.tallySummary.dinnerCount}</p>
                </div>
                <div className="stat-card">
                  <p className="muted">Total Meals Tallied</p>
                  <p className="value">{report.tallySummary.totalMealsCount}</p>
                </div>
              </>
            )}
          </div>
          <section className="stack">
            <h3>Meal Totals by Person{personTypeFilter !== "ALL" ? ` — ${personTypeFilterLabel(personTypeFilter)}` : ""}</h3>
            <div className="filters-row">
              <label>
                Search
                <input type="search" value={reportSearch} placeholder="Name or Person ID"
                  onChange={(event) => setReportSearch(event.target.value)} />
              </label>
              <label>
                Type
                <select value={personTypeFilter}
                  onChange={(event) => setPersonTypeFilter(event.target.value as PersonTypeFilter)}>
                  {PERSON_TYPE_FILTER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Sort by
                <select value={sortKey} onChange={(event) => sortBy(event.target.value as MealTotalsSortKey)}>
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Order
                <select value={sortDirection} onChange={(event) => setSortDirection(event.target.value as "asc" | "desc")}>
                  <option value="asc">{sortKey === "name" || sortKey === "personId" || sortKey === "type" ? "A → Z" : "Lowest first"}</option>
                  <option value="desc">{sortKey === "name" || sortKey === "personId" || sortKey === "type" ? "Z → A" : "Highest first"}</option>
                </select>
              </label>
            </div>
            {mealTotals.length === 0 ? (
              <p className="muted">
                No meals found for the selected date range.
              </p>
            ) : filteredMealTotals.length === 0 ? (
              <p className="muted">No people match the current search and type filter.</p>
            ) : (
              <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {SORT_OPTIONS.map((option) => sortHeader(option.key, option.label))}
                  </tr>
                </thead>
                <tbody>
                  {filteredMealTotals.map((row) => (
                    <tr key={row.personId}>
                      <td>
                        {row.firstName} {row.lastName}
                      </td>
                      <td>{row.personId}</td>
                      <td>{formatPersonType(row.personType)}</td>
                      <td>{row.total}</td>
                      <td>{row.breakfasts}</td>
                      <td>{row.lunches}</td>
                      <td>{row.dinners}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
