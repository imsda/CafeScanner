import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage } from "../api/client";
import { useSchoolMeta } from "../hooks/useSchoolMeta";
import type { PersonType } from "../api/types";
import { PersonTypeOptions } from "../components/PersonTypeOptions";
import { modeLabel } from "../lib/format";
import { Modal } from "../components/Modal";

export type PersonRecord = {
  personType: PersonType;
  id: number;
  firstName: string;
  lastName: string;
  personId: string;
  codeValue: string;
  breakfastRemaining: number;
  lunchRemaining: number;
  dinnerRemaining: number;
  breakfastCount: number;
  lunchCount: number;
  dinnerCount: number;
  totalMealsCount: number;
  active?: boolean;
  grade?: string | null;
  group?: string | null;
  campus?: string | null;
  notes?: string | null;
  campMeetingEntitlements?: number;
  campMeetingRedeemed?: number;
  campMeetingRemaining?: number;
  breakfastTotal?: number;
  lunchTotal?: number;
  dinnerTotal?: number;
  breakfastAvailable?: number;
  lunchAvailable?: number;
  dinnerAvailable?: number;
  breakfastRedeemed?: number;
  lunchRedeemed?: number;
  dinnerRedeemed?: number;
  todayBreakfastAvailable?: number;
  todayLunchAvailable?: number;
  todayDinnerAvailable?: number;
  associatedNames?: string[];
  associatedNamesSummary?: string;
};

export function PeoplePage() {
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [gradeFilter, setGradeFilter] = useState("ALL");
  // Mode comes from /meta so People works without Settings page access.
  const { meta: settings, error: metaError } = useSchoolMeta();
  const [form, setForm] = useState<Record<string, string | number | boolean>>({
    personType: "STUDENT",
    firstName: "",
    lastName: "",
    personId: "",
    codeValue: "",
    breakfastRemaining: 0,
    lunchRemaining: 0,
    dinnerRemaining: 0,
    breakfastCount: 0,
    lunchCount: 0,
    dinnerCount: 0,
    totalMealsCount: 0,
    active: true,
  });
  const [personToDelete, setPersonToDelete] = useState<PersonRecord | null>(
    null,
  );
  const [deletePhrase, setDeletePhrase] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = () =>
    api<PersonRecord[]>("/people?showInactive=true")
      .then(setPeople)
      .catch((loadError) => setError(errorMessage(loadError, "Unable to load people.")));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (metaError) setError(metaError);
  }, [metaError]);

  const isTally = settings?.mealTrackingMode === "tally";
  const isCampMeeting = settings?.mealTrackingMode === "camp_meeting";
  const isCountdown = settings?.mealTrackingMode === "countdown";

  async function addPerson(e: FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    const payload = isTally
      ? {
          ...form,
          breakfastRemaining: 0,
          lunchRemaining: 0,
          dinnerRemaining: 0,
        }
      : {
          ...form,
          personType: "GUEST",
          breakfastCount: 0,
          lunchCount: 0,
          dinnerCount: 0,
          totalMealsCount: 0,
        };
    try {
      await api("/people", { method: "POST", body: JSON.stringify(payload) });
      setMessage("Person added.");
      await load();
    } catch (addError) {
      setError(errorMessage(addError, "Unable to add person."));
    }
  }

  async function savePerson(person: PersonRecord) {
    setError("");
    setMessage("");
    const payload = isTally
      ? {
          personType: person.personType,
          breakfastCount: person.breakfastCount,
          lunchCount: person.lunchCount,
          dinnerCount: person.dinnerCount,
          totalMealsCount:
            person.breakfastCount + person.lunchCount + person.dinnerCount,
        }
      : {
          breakfastRemaining: person.breakfastRemaining,
          lunchRemaining: person.lunchRemaining,
          dinnerRemaining: person.dinnerRemaining,
        };
    try {
      await api(`/people/${person.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setMessage(`Saved ${personDisplayName(person)}.`);
      await load();
    } catch (saveError) {
      setError(errorMessage(saveError, "Unable to save person."));
    }
  }

  async function deletePerson() {
    if (!personToDelete || deletePhrase !== "DELETE PERSON") return;
    setIsDeleting(true);
    setError("");
    setMessage("");

    try {
      await api(`/people/${personToDelete.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmationPhrase: deletePhrase }),
      });
      setMessage(
        `Deleted ${personToDelete.firstName} ${personToDelete.lastName} (${personToDelete.personId}).`,
      );
      setPersonToDelete(null);
      setDeletePhrase("");
      await load();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete this person",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  const deleteEnabled = deletePhrase === "DELETE PERSON" && !isDeleting;
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const gradeOptions = useMemo(() => {
    const grades = Array.from(
      new Set(
        people.map((person) => (person.grade || "").trim()).filter(Boolean),
      ),
    );
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return grades.sort((a, b) => collator.compare(a, b));
  }, [people]);
  const filteredPeople = useMemo(
    () =>
      people.filter((person) => {
        const firstName = person.firstName.toLowerCase();
        const lastName = person.lastName.toLowerCase();
        const fullName = `${firstName} ${lastName}`.trim();
        const personId = person.personId.toLowerCase();
        const associatedNames = (
          person.associatedNamesSummary || ""
        ).toLowerCase();
        const matchesSearch =
          normalizedSearch.length === 0 ||
          firstName.includes(normalizedSearch) ||
          lastName.includes(normalizedSearch) ||
          fullName.includes(normalizedSearch) ||
          personId.includes(normalizedSearch) ||
          associatedNames.includes(normalizedSearch);
        const gradeValue = (person.grade || "").trim();
        const matchesGrade = isCampMeeting
          ? true
          : gradeFilter === "ALL" || gradeValue === gradeFilter;
        return matchesSearch && matchesGrade;
      }),
    [people, normalizedSearch, gradeFilter, isCampMeeting],
  );
  const hasAnyGrade = useMemo(
    () => people.some((person) => Boolean((person.grade || "").trim())),
    [people],
  );
  const noResultsColSpan =
    3 + (hasAnyGrade ? 1 : 0) + (isCampMeeting ? 12 : 4) + 1;
  const personDisplayName = (person: PersonRecord) => {
    if (isCampMeeting && person.associatedNamesSummary)
      return person.associatedNamesSummary;
    return `${person.firstName} ${person.lastName}`.trim() || person.personId;
  };

  return (
    <div className="card stack">
      <h2>People</h2>
      <p className="muted">
        Active mode:{" "}
        <strong>
          {modeLabel(settings?.mealTrackingMode || "camp_meeting")}
        </strong>
        .{" "}
        {isTally
          ? "Students can scan once per meal each day. Staff and guests can scan multiple times. Select a user type and click Save. Tally counters are editable in this mode."
          : isCountdown
            ? "Remaining balances are editable in this mode."
            : "Camp Meeting entitlement status is shown from imported CSV data. Today B/L/D are based on the current local day-of-week."}
      </p>
      {message && <p>{message}</p>}
      {error && <p className="error">{error}</p>}
      <form
        className="grid-form grid-form-people"
        onSubmit={(e) => void addPerson(e)}
      >
        {[
          ["firstName", "First name"],
          ["lastName", "Last name"],
          ["personId", "Person ID"],
          ["codeValue", "Badge code (optional)"],
          ["grade", "Grade (optional)"],
          ["group", "Group (optional)"],
          ["campus", "Campus (optional)"],
        ].map(([k, label]) => (
          <label key={k}>
            {label}
            <input
              value={String(form[k] || "")}
              required={k === "firstName" || k === "lastName" || k === "personId"}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            />
          </label>
        ))}
        {isTally && <label>User type
          <select value={String(form.personType)} onChange={(e) => setForm({ ...form, personType: e.target.value })}>
            <PersonTypeOptions />
          </select>
        </label>}
        <button className="primary add-person-btn">Add</button>
      </form>
      <div className="filters-row people-filters">
        <label>
          Search people
          <input
            type="search"
            placeholder="Search by first name, last name, full name, or ID"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </label>
        {!isCampMeeting && (
          <label>
            Grade
            <select
              value={gradeFilter}
              onChange={(e) => setGradeFilter(e.target.value)}
            >
              <option value="ALL">All Grades</option>
              {gradeOptions.map((grade) => (
                <option key={grade} value={grade}>
                  {grade}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setSearchTerm("");
            setGradeFilter("ALL");
          }}
          disabled={
            searchTerm.trim().length === 0 &&
            (isCampMeeting || gradeFilter === "ALL")
          }
        >
          Clear
        </button>
      </div>
      <div className="table-scroll">
        <table className="people-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Person ID</th>
              {isTally && <th>User type</th>}
              {hasAnyGrade && <th>Grade</th>}
              {isCampMeeting ? (
                <>
                  <th>B</th>
                  <th>L</th>
                  <th>D</th>
                  <th>B Av</th>
                  <th>L Av</th>
                  <th>D Av</th>
                  <th>B Rd</th>
                  <th>L Rd</th>
                  <th>D Rd</th>
                  <th>Today B</th>
                  <th>Today L</th>
                  <th>Today D</th>
                </>
              ) : isCountdown ? (
                <>
                  <th>Breakfast Remaining</th>
                  <th>Lunch Remaining</th>
                  <th>Dinner Remaining</th>
                </>
              ) : (
                <>
                  <th>Breakfast Count</th>
                  <th>Lunch Count</th>
                  <th>Dinner Count</th>
                  <th>Total</th>
                </>
              )}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredPeople.length > 0 ? (
              filteredPeople.map((p) => (
                <tr key={p.id}>
                  <td>{personDisplayName(p)}</td>
                  <td>{p.personId}</td>
                  {isTally && <td>
                    <select aria-label={`User type for ${personDisplayName(p)}`} value={p.personType}
                      onChange={(e) => setPeople((curr) => curr.map((row) => row.id === p.id
                        ? { ...row, personType: e.target.value as PersonRecord['personType'] } : row))}>
                      <PersonTypeOptions />
                    </select>
                  </td>}
                  {hasAnyGrade && <td>{(p.grade || "").trim() || null}</td>}
                  {isCampMeeting ? (
                    <>
                      <td>{p.breakfastTotal ?? 0}</td>
                      <td>{p.lunchTotal ?? 0}</td>
                      <td>{p.dinnerTotal ?? 0}</td>
                      <td>{p.breakfastAvailable ?? 0}</td>
                      <td>{p.lunchAvailable ?? 0}</td>
                      <td>{p.dinnerAvailable ?? 0}</td>
                      <td>{p.breakfastRedeemed ?? 0}</td>
                      <td>{p.lunchRedeemed ?? 0}</td>
                      <td>{p.dinnerRedeemed ?? 0}</td>
                      <td>{p.todayBreakfastAvailable ?? 0}</td>
                      <td>{p.todayLunchAvailable ?? 0}</td>
                      <td>{p.todayDinnerAvailable ?? 0}</td>
                    </>
                  ) : isCountdown ? (
                    <>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.breakfastRemaining}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      breakfastRemaining: Number(
                                        e.target.value,
                                      ),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.lunchRemaining}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      lunchRemaining: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.dinnerRemaining}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      dinnerRemaining: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.breakfastCount}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      breakfastCount: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.lunchCount}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      lunchCount: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="people-number-input"
                          type="number"
                          min={0}
                          value={p.dinnerCount}
                          onChange={(e) =>
                            setPeople((curr) =>
                              curr.map((row) =>
                                row.id === p.id
                                  ? {
                                      ...row,
                                      dinnerCount: Number(e.target.value),
                                    }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>{p.breakfastCount + p.lunchCount + p.dinnerCount}</td>
                    </>
                  )}
                  <td>
                    <div className="people-actions">
                      {!isCampMeeting && (
                        <button
                          className="small"
                          type="button"
                          onClick={() => void savePerson(p)}
                        >
                          Save
                        </button>
                      )}
                      {isTally && (
                        <button
                          className="small secondary"
                          type="button"
                          onClick={() =>
                            void api(`/people/reset-tallies/${p.id}`, {
                              method: "POST",
                            }).then(load)
                          }
                        >
                          Reset
                        </button>
                      )}
                      <button
                        className="small danger"
                        type="button"
                        onClick={() => {
                          setPersonToDelete(p);
                          setDeletePhrase("");
                          setError("");
                          setMessage("");
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="muted" colSpan={noResultsColSpan + (isTally ? 1 : 0)}>
                  No people match your current{" "}
                  {isCampMeeting ? "search" : "search and grade filters"}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {personToDelete && (
        <Modal title="Confirm Person Deletion" onClose={() => { setPersonToDelete(null); setDeletePhrase(""); }}>
          <p>
            You are deleting{" "}
            <strong>{personDisplayName(personToDelete)}</strong>.
          </p>
          <p>
            Person ID: <strong>{personToDelete.personId}</strong>
          </p>
          <p className="error">
            Warning: This permanently removes this person and their related
            scan transaction history. This cannot be easily undone.
          </p>
          <p>
            Type <code>DELETE PERSON</code> to enable deletion.
          </p>
          <input
            value={deletePhrase}
            onChange={(e) => setDeletePhrase(e.target.value)}
            placeholder="DELETE PERSON"
          />
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setPersonToDelete(null);
                setDeletePhrase("");
              }}
            >
              Cancel
            </button>
            <button
              className="danger"
              type="button"
              disabled={!deleteEnabled}
              onClick={() => void deletePerson()}
            >
              {isDeleting ? "Deleting…" : "Delete Person"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
