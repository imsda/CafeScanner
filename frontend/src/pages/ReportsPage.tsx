import { useEffect, useMemo, useState } from "react";
import { api, API_BASE, errorMessage } from "../api/client";
import type { ReportsSummaryResponse } from "../api/types";
import { ButtonLink } from "../components/ButtonLink";
import { StudentsNotEatingPanel } from "../components/StudentsNotEatingPanel";
import { getRangeForPreset } from "../lib/dates";
import { formatDateOnly, formatPersonType, modeLabel } from "../lib/format";
import {
  matchesPersonTypeFilter,
  mealTotalsByPersonType,
  personTypeSortRank,
  PERSON_TYPE_FILTER_OPTIONS,
  personTypeFilterLabel,
  sumMealTotals,
} from "../lib/personTypeTotals";
import type { PersonTypeFilter } from "../lib/personTypeTotals";

type Preset = "today" | "last7" | "week" | "month" | "year";

const PRESETS: Array<{ value: Preset | "custom"; label: string }> = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "year", label: "This year" },
  { value: "custom", label: "Custom" },
];

type MealTotalsSortKey = "name" | "personId" | "type" | "total" | "breakfasts" | "lunches" | "dinners";
type SortDirection = "asc" | "desc";

const COLUMNS: Array<{ key: MealTotalsSortKey; label: string; numeric?: boolean; defaultDirection: SortDirection }> = [
  { key: "name", label: "Name", defaultDirection: "asc" },
  { key: "personId", label: "Person ID", defaultDirection: "asc" },
  { key: "type", label: "Type", defaultDirection: "asc" },
  { key: "breakfasts", label: "Breakfast", numeric: true, defaultDirection: "desc" },
  { key: "lunches", label: "Lunch", numeric: true, defaultDirection: "desc" },
  { key: "dinners", label: "Dinner", numeric: true, defaultDirection: "desc" },
  { key: "total", label: "Total", numeric: true, defaultDirection: "desc" },
];

// Common orderings for the "Sort by" menu; column headers can produce any other combination.
const SORT_CHOICES: Array<{ key: MealTotalsSortKey; direction: SortDirection; label: string }> = [
  { key: "name", direction: "asc", label: "Name (A–Z)" },
  { key: "name", direction: "desc", label: "Name (Z–A)" },
  { key: "type", direction: "asc", label: "Type (dorm, village, staff, guest)" },
  { key: "type", direction: "desc", label: "Type (guest, staff, village, dorm)" },
  { key: "total", direction: "desc", label: "Most meals" },
  { key: "total", direction: "asc", label: "Fewest meals" },
  { key: "personId", direction: "asc", label: "Person ID" },
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

function describeRange(from: string, to: string): string {
  return from === to ? formatDateOnly(from) : `${formatDateOnly(from)} – ${formatDateOnly(to)}`;
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

export function ReportsPage() {
  const todayRange = useMemo(() => getRangeForPreset("today"), []);
  const [fromDate, setFromDate] = useState(todayRange.from);
  const [toDate, setToDate] = useState(todayRange.to);
  const [appliedFromDate, setAppliedFromDate] = useState(todayRange.from);
  const [appliedToDate, setAppliedToDate] = useState(todayRange.to);
  const [activePreset, setActivePreset] = useState<Preset | "custom">("today");
  const [report, setReport] = useState<ReportsSummaryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeReportView, setActiveReportView] = useState<"meal-report" | "students-not-eating">("meal-report");
  const [reportSearch, setReportSearch] = useState("");
  const [sortKey, setSortKey] = useState<MealTotalsSortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [personTypeFilter, setPersonTypeFilter] = useState<PersonTypeFilter>("ALL");

  async function loadReport(range: { from: string; to: string } = { from: fromDate, to: toDate }) {
    setIsLoading(true);
    try {
      const query = new URLSearchParams({ from: range.from, to: range.to, startDate: range.from, endDate: range.to });
      setReport(await api<ReportsSummaryResponse>(`/reports/summary?${query.toString()}`));
      setAppliedFromDate(range.from);
      setAppliedToDate(range.to);
      setError("");
    } catch (loadError) {
      setError(errorMessage(loadError, "Unable to load report"));
    } finally {
      setIsLoading(false);
    }
  }

  function choosePreset(preset: Preset | "custom") {
    setActivePreset(preset);
    if (preset === "custom") return;
    const range = getRangeForPreset(preset);
    setFromDate(range.from);
    setToDate(range.to);
    void loadReport(range);
  }

  useEffect(() => {
    void loadReport();
  }, []);

  const mealTotals = report?.mealTotalsByPerson ?? report?.perPersonUsage ?? [];
  const typeRows = useMemo(
    () => mealTotals.filter((row) => matchesPersonTypeFilter(row.personType, personTypeFilter)),
    [mealTotals, personTypeFilter],
  );
  // Totals for the selected person type over the date range (the people search does not narrow them).
  const selectedTypeTotals = useMemo(() => sumMealTotals(typeRows), [typeRows]);
  const typeBreakdown = useMemo(() => mealTotalsByPersonType(mealTotals), [mealTotals]);
  const grandTotalMeals = typeBreakdown.find((row) => row.filter === "ALL")?.totals.total ?? 0;
  const visiblePeople = useMemo(() => {
    const query = reportSearch.trim().toLowerCase();
    const direction = sortDirection === "asc" ? 1 : -1;
    return typeRows
      .filter((row) => !query
        || `${row.firstName} ${row.lastName}`.toLowerCase().includes(query)
        || row.personId.toLowerCase().includes(query))
      .sort((a, b) => direction * compareMealTotals(a, b, sortKey));
  }, [typeRows, reportSearch, sortKey, sortDirection]);

  // Clicking the active column flips the direction; a new column starts in its natural direction.
  function sortByColumn(key: MealTotalsSortKey) {
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(COLUMNS.find((column) => column.key === key)?.defaultDirection ?? "asc");
  }

  const sortChoiceValue = `${sortKey}:${sortDirection}`;
  const sortChoiceIsPreset = SORT_CHOICES.some((choice) => `${choice.key}:${choice.direction}` === sortChoiceValue);

  const rangeQuery = { from: appliedFromDate, to: appliedToDate, startDate: appliedFromDate, endDate: appliedToDate };
  const transactionsExportHref = `${API_BASE}/reports/export.csv?${new URLSearchParams(rangeQuery)}`;
  const mealTotalsExportHref = `${API_BASE}/reports/meal-totals.csv?${new URLSearchParams({
    ...rangeQuery,
    ...(personTypeFilter !== "ALL" ? { personType: personTypeFilter } : {}),
  })}`;
  const filterLabel = personTypeFilterLabel(personTypeFilter);

  const header = (
    <div className="reports-header">
      <h2>Reports</h2>
      <div className="segmented" role="tablist" aria-label="Report">
        <button type="button" role="tab" aria-selected={activeReportView === "meal-report"}
          onClick={() => setActiveReportView("meal-report")}>Meal Report</button>
        <button type="button" role="tab" aria-selected={activeReportView === "students-not-eating"}
          onClick={() => setActiveReportView("students-not-eating")}>Students Not Eating</button>
      </div>
    </div>
  );

  if (activeReportView === "students-not-eating") {
    return <div className="card stack">{header}<StudentsNotEatingPanel /></div>;
  }

  return (
    <div className="card stack reports">
      {header}

      <section className="report-filters" aria-label="Report filters">
        <div className="report-filters-row">
          <div className="segmented" role="group" aria-label="Date range">
            {PRESETS.map((preset) => (
              <button key={preset.value} type="button" aria-pressed={activePreset === preset.value}
                onClick={() => choosePreset(preset.value)}>
                {preset.label}
              </button>
            ))}
          </div>
          <label className="inline-field">
            Person type
            <select value={personTypeFilter} onChange={(event) => setPersonTypeFilter(event.target.value as PersonTypeFilter)}>
              {PERSON_TYPE_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        {activePreset === "custom" && (
          <form className="report-filters-row" onSubmit={(event) => { event.preventDefault(); void loadReport(); }}>
            <label className="inline-field">From<input type="date" value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} /></label>
            <label className="inline-field">To<input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} /></label>
            <button type="submit" className="primary">Show report</button>
          </form>
        )}
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      {report && (
        <>
          <div className="report-context">
            <p>
              <strong>{describeRange(appliedFromDate, appliedToDate)}</strong>
              <span className="muted"> · {filterLabel} · {modeLabel(report.mealTrackingMode)}</span>
              {isLoading && <span className="muted"> · Updating…</span>}
            </p>
            <div className="report-downloads">
              <ButtonLink className="btn-secondary small" href={mealTotalsExportHref} target="_blank" rel="noreferrer">
                Download meal totals
              </ButtonLink>
              <ButtonLink className="btn-secondary small" href={transactionsExportHref} target="_blank" rel="noreferrer">
                Download scans
              </ButtonLink>
            </div>
          </div>

          <section aria-live="polite" aria-label={`Meals served — ${filterLabel}`}>
            <div className="kpi-grid">
              <div className="kpi kpi-primary">
                <p className="kpi-label">Meals served</p>
                <p className="kpi-value">{selectedTypeTotals.total}</p>
                <p className="kpi-note">{selectedTypeTotals.people} {selectedTypeTotals.people === 1 ? "person" : "people"}</p>
              </div>
              <div className="kpi"><p className="kpi-label">Breakfast</p><p className="kpi-value">{selectedTypeTotals.breakfasts}</p></div>
              <div className="kpi"><p className="kpi-label">Lunch</p><p className="kpi-value">{selectedTypeTotals.lunches}</p></div>
              <div className="kpi"><p className="kpi-label">Dinner</p><p className="kpi-value">{selectedTypeTotals.dinners}</p></div>
            </div>
            <p className="muted report-footnote">
              Scans recorded (all types): {report.stats.scans}
              {report.stats.failedScans > 0 && <> · <span className="error">{report.stats.failedScans} failed</span></>}
              {report.mealTrackingMode === "camp_meeting" && (
                <> · Entitlements: {report.entitlementSummary.totalRedeemed} redeemed of {report.entitlementSummary.totalEntitlements} ({report.entitlementSummary.totalRemaining} unused)</>
              )}
              {report.mealTrackingMode === "countdown" && (
                <> · Meals remaining on balances: {report.remainingBalanceSummary.breakfastRemaining} breakfast, {report.remainingBalanceSummary.lunchRemaining} lunch, {report.remainingBalanceSummary.dinnerRemaining} dinner</>
              )}
            </p>
          </section>

          <section className="stack-tight">
            <h3>By person type</h3>
            <div className="table-scroll">
              <table className="report-table type-totals">
                <thead>
                  <tr>
                    <th scope="col">Person type</th>
                    <th scope="col" className="num">People</th>
                    <th scope="col" className="num">Breakfast</th>
                    <th scope="col" className="num">Lunch</th>
                    <th scope="col" className="num">Dinner</th>
                    <th scope="col" className="num">Total</th>
                    <th scope="col" className="share-col">Share of meals</th>
                  </tr>
                </thead>
                <tbody>
                  {typeBreakdown.map((row) => {
                    const share = percent(row.totals.total, grandTotalMeals);
                    const selected = row.filter === personTypeFilter;
                    return (
                      <tr key={row.filter} className={[row.summary ? "summary-row" : "", selected ? "selected-row" : ""].join(" ").trim() || undefined}>
                        <th scope="row">
                          <button type="button" className="link-button" aria-pressed={selected}
                            title={`Show ${row.label.toLowerCase()}`} onClick={() => setPersonTypeFilter(row.filter)}>
                            {row.label}
                          </button>
                        </th>
                        <td className="num">{row.totals.people}</td>
                        <td className="num">{row.totals.breakfasts}</td>
                        <td className="num">{row.totals.lunches}</td>
                        <td className="num">{row.totals.dinners}</td>
                        <td className="num"><strong>{row.totals.total}</strong></td>
                        <td className="share-col">
                          {row.filter !== "ALL" && (
                            <span className="share">
                              <span className="share-bar" aria-hidden="true"><span style={{ width: `${share}%` }} /></span>
                              <span className="share-value">{share}%</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stack-tight">
            <div className="section-heading">
              <h3>
                People
                <span className="count-badge">{visiblePeople.length}</span>
              </h3>
              {personTypeFilter !== "ALL" && (
                <button type="button" className="filter-chip" onClick={() => setPersonTypeFilter("ALL")}
                  aria-label={`Clear person type filter (${filterLabel})`}>
                  {filterLabel} <span aria-hidden="true">✕</span>
                </button>
              )}
            </div>
            <div className="table-toolbar">
              <label className="inline-field grow">
                Search
                <input type="search" value={reportSearch} placeholder="Name or Person ID"
                  onChange={(event) => setReportSearch(event.target.value)} />
              </label>
              <label className="inline-field">
                Sort by
                <select value={sortChoiceValue} onChange={(event) => {
                  const [key, direction] = event.target.value.split(":") as [MealTotalsSortKey, SortDirection];
                  setSortKey(key);
                  setSortDirection(direction);
                }}>
                  {!sortChoiceIsPreset && (
                    <option value={sortChoiceValue}>
                      {COLUMNS.find((column) => column.key === sortKey)?.label} ({sortDirection === "asc" ? "low → high" : "high → low"})
                    </option>
                  )}
                  {SORT_CHOICES.map((choice) => (
                    <option key={`${choice.key}:${choice.direction}`} value={`${choice.key}:${choice.direction}`}>{choice.label}</option>
                  ))}
                </select>
              </label>
            </div>
            {mealTotals.length === 0 ? (
              <p className="empty-state">No meals were recorded in this date range.</p>
            ) : visiblePeople.length === 0 ? (
              <p className="empty-state">No people match {reportSearch.trim() ? `“${reportSearch.trim()}”` : "this filter"}.</p>
            ) : (
              <div className="table-scroll">
                <table className="report-table">
                  <thead>
                    <tr>
                      {COLUMNS.map((column) => (
                        <th key={column.key} scope="col" className={column.numeric ? "num" : undefined}
                          aria-sort={sortKey === column.key ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
                          <button type="button" className="sort-button" onClick={() => sortByColumn(column.key)}>
                            {column.label}
                            <span aria-hidden="true" className={sortKey === column.key ? "sort-indicator active" : "sort-indicator"}>
                              {sortKey === column.key ? (sortDirection === "asc" ? "▲" : "▼") : "↕"}
                            </span>
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePeople.map((row) => (
                      <tr key={row.personId}>
                        <td>{row.firstName} {row.lastName}</td>
                        <td className="mono">{row.personId}</td>
                        <td><span className={`type-pill type-${row.personType.toLowerCase()}`}>{formatPersonType(row.personType)}</span></td>
                        <td className="num">{row.breakfasts}</td>
                        <td className="num">{row.lunches}</td>
                        <td className="num">{row.dinners}</td>
                        <td className="num"><strong>{row.total}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {!report && !error && <p className="muted">Loading report…</p>}
    </div>
  );
}
