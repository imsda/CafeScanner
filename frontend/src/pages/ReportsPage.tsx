import { useEffect, useMemo, useState } from "react";
import { api, API_BASE } from "../api/client";
import type { PersonType, ReportsSummaryResponse } from "../api/types";
import { ButtonLink } from "../components/ButtonLink";
import { StudentsNotEatingPanel } from "../components/StudentsNotEatingPanel";
import { getRangeForPreset } from "../lib/dates";
import { formatPersonType, modeLabel } from "../lib/format";

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
  const [personTypeFilter, setPersonTypeFilter] = useState<"ALL" | "ALL_STUDENTS" | PersonType>("ALL");

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
    return mealTotals.filter((row) => {
      if (personTypeFilter === "ALL_STUDENTS") {
        if (row.personType !== "STUDENT" && row.personType !== "VILLAGE_STUDENT") return false;
      } else if (personTypeFilter !== "ALL" && row.personType !== personTypeFilter) return false;
      if (!query) return true;
      return `${row.firstName} ${row.lastName}`.toLowerCase().includes(query)
        || row.personId.toLowerCase().includes(query);
    });
  }, [mealTotals, personTypeFilter, reportSearch]);
  const exportQuery = new URLSearchParams({
    from: appliedFromDate,
    to: appliedToDate,
    startDate: appliedFromDate,
    endDate: appliedToDate,
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
            href={`${API_BASE}/reports/meal-totals.csv?${exportQuery}`}
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
            <h3>Meal Totals by Person</h3>
            <div className="filters-row">
              <label>
                Search
                <input type="search" value={reportSearch} placeholder="Name or Person ID"
                  onChange={(event) => setReportSearch(event.target.value)} />
              </label>
              <label>
                Type
                <select value={personTypeFilter}
                  onChange={(event) => setPersonTypeFilter(event.target.value as "ALL" | "ALL_STUDENTS" | PersonType)}>
                  <option value="ALL">All types</option>
                  <option value="ALL_STUDENTS">All students</option>
                  <option value="STUDENT">Dorm students</option>
                  <option value="VILLAGE_STUDENT">Village students</option>
                  <option value="STAFF">Staff</option>
                  <option value="GUEST">Guests</option>
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
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Person ID</th>
                    <th>Type</th>
                    <th>Total Meals</th>
                    <th>Breakfast</th>
                    <th>Lunch</th>
                    <th>Dinner</th>
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
            )}
          </section>
        </>
      )}
    </div>
  );
}
