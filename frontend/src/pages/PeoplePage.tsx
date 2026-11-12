import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage } from "../api/client";
import { useSchoolMeta } from "../hooks/useSchoolMeta";
import type { PersonType } from "../api/types";
import { PersonTypeOptions } from "../components/PersonTypeOptions";
import { modeLabel } from "../lib/format";
import { Modal } from "../components/Modal";
import { useConfirm } from "../components/useConfirm";
import { useAuth } from "../context/AuthContext";

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

// Fields edited inline in the table, per mode. Only the ones the operator actually
// changed are sent on Save, so counts/balances written by scans since the page was
// loaded are never overwritten with stale values.
const TALLY_INLINE_FIELDS = ["personType", "breakfastCount", "lunchCount", "dinnerCount"] as const;
const COUNTDOWN_INLINE_FIELDS = ["breakfastRemaining", "lunchRemaining", "dinnerRemaining"] as const;
type InlineField = (typeof TALLY_INLINE_FIELDS)[number] | (typeof COUNTDOWN_INLINE_FIELDS)[number];

// Fields edited in the per-person "Edit" dialog.
type EditValues = {
  firstName: string;
  lastName: string;
  personId: string;
  codeValue: string;
  active: boolean;
  grade: string;
  group: string;
  campus: string;
  notes: string;
};
const EDIT_TEXT_FIELDS: Array<[Exclude<keyof EditValues, "active" | "notes">, string, boolean]> = [
  ["firstName", "First name", true],
  ["lastName", "Last name", true],
  ["personId", "Person ID", true],
  ["codeValue", "Badge code", true],
  ["grade", "Grade (optional)", false],
  ["group", "Group (optional)", false],
  ["campus", "Campus (optional)", false],
];
const editValuesOf = (person: PersonRecord): EditValues => ({
  firstName: person.firstName,
  lastName: person.lastName,
  personId: person.personId,
  codeValue: person.codeValue,
  active: person.active !== false,
  grade: person.grade || "",
  group: person.group || "",
  campus: person.campus || "",
  notes: person.notes || "",
});

const SHOW_INACTIVE_STORAGE_KEY = "cafescanner.people.showInactive";
function readShowInactive(): boolean {
  try {
    return window.localStorage.getItem(SHOW_INACTIVE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const sortByLastName = (rows: PersonRecord[]) =>
  [...rows].sort((a, b) => a.lastName.localeCompare(b.lastName));

export function PeoplePage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "OWNER" || user?.role === "ADMIN";
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [people, setPeople] = useState<PersonRecord[]>([]);
  // Rows as last received from the server, by id. `people` holds the operator's
  // in-progress edits; a row is dirty when it differs from its original.
  const originalsRef = useRef<Record<number, PersonRecord>>({});
  const [savingIds, setSavingIds] = useState<number[]>([]);
  const [showInactive, setShowInactive] = useState(readShowInactive);
  const [editing, setEditing] = useState<{ id: number; values: EditValues } | null>(null);
  const [editError, setEditError] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
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
      .then((rows) => {
        originalsRef.current = Object.fromEntries(rows.map((row) => [row.id, row]));
        setPeople(rows);
      })
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
  const inlineFields: readonly InlineField[] = isTally
    ? TALLY_INLINE_FIELDS
    : isCountdown
      ? COUNTDOWN_INLINE_FIELDS
      : [];

  const dirtyFieldsOf = (person: PersonRecord): InlineField[] => {
    const original = originalsRef.current[person.id];
    if (!original) return [];
    return inlineFields.filter((field) => person[field] !== original[field]);
  };

  // Merges one person's fresh server data into the list without reloading it, so
  // unsaved edits on other rows (and on this row's fields that were not sent) survive.
  function applyServerPerson(server: PersonRecord, sentFields: readonly string[]) {
    const original = originalsRef.current[server.id];
    originalsRef.current = {
      ...originalsRef.current,
      [server.id]: { ...original, ...server },
    };
    setPeople((curr) =>
      curr.map((row) => {
        if (row.id !== server.id) return row;
        const merged: PersonRecord = { ...row, ...server };
        if (original) {
          const unsent = merged as Record<InlineField, unknown>;
          for (const field of [...TALLY_INLINE_FIELDS, ...COUNTDOWN_INLINE_FIELDS]) {
            if (!sentFields.includes(field) && row[field] !== original[field])
              unsent[field] = row[field];
          }
        }
        // People without imported entitlement names are listed under their own name.
        const previousName = `${row.firstName} ${row.lastName}`.trim();
        if (!row.associatedNamesSummary || row.associatedNamesSummary === previousName) {
          const name = `${merged.firstName} ${merged.lastName}`.trim();
          merged.associatedNames = [name];
          merged.associatedNamesSummary = name;
        }
        return merged;
      }),
    );
  }

  function toggleShowInactive(next: boolean) {
    setShowInactive(next);
    try {
      window.localStorage.setItem(SHOW_INACTIVE_STORAGE_KEY, String(next));
    } catch {
      // Storage unavailable (private mode): the choice just is not remembered.
    }
  }

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
      const created = await api<PersonRecord>("/people", { method: "POST", body: JSON.stringify(payload) });
      setMessage("Person added.");
      // Add the new row in place; a full reload would discard unsaved edits on other rows.
      originalsRef.current = { ...originalsRef.current, [created.id]: created };
      setPeople((curr) => sortByLastName([...curr.filter((row) => row.id !== created.id), created]));
    } catch (addError) {
      setError(errorMessage(addError, "Unable to add person."));
    }
  }

  async function savePerson(person: PersonRecord) {
    setError("");
    setMessage("");
    // Send only what the operator changed on this row.
    const dirty = dirtyFieldsOf(person);
    if (dirty.length === 0) return;
    const payload: Partial<Record<InlineField, string | number>> = {};
    for (const field of dirty) payload[field] = person[field];
    setSavingIds((curr) => [...curr, person.id]);
    try {
      const saved = await api<PersonRecord>(`/people/${person.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      applyServerPerson(saved, dirty);
      setMessage(`Saved ${personDisplayName(person)}.`);
    } catch (saveError) {
      setError(errorMessage(saveError, "Unable to save person."));
    } finally {
      setSavingIds((curr) => curr.filter((id) => id !== person.id));
    }
  }

  async function resetTallies(person: PersonRecord) {
    const confirmed = await confirm({
      title: "Reset meal counts",
      message: `Reset the breakfast, lunch and dinner counts for ${personDisplayName(person)} (${person.personId}) to zero? This cannot be undone.`,
      confirmLabel: "Reset counts",
      danger: true,
    });
    if (confirmed === null) return;
    setError("");
    setMessage("");
    try {
      const updated = await api<PersonRecord>(`/people/reset-tallies/${person.id}`, {
        method: "POST",
      });
      applyServerPerson(updated, ["breakfastCount", "lunchCount", "dinnerCount"]);
      setMessage(`Reset meal counts for ${personDisplayName(person)}.`);
    } catch (resetError) {
      setError(errorMessage(resetError, "Unable to reset meal counts."));
    }
  }

  function openEdit(person: PersonRecord) {
    setEditing({ id: person.id, values: editValuesOf(originalsRef.current[person.id] ?? person) });
    setEditError("");
    setError("");
    setMessage("");
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const original = originalsRef.current[editing.id];
    if (!original) return;
    const before = editValuesOf(original);
    const payload: Record<string, string | boolean | null> = {};
    for (const [field] of EDIT_TEXT_FIELDS) {
      const value = editing.values[field].trim();
      if (value === before[field].trim()) continue;
      // Optional fields are cleared with null; the required ones are never empty here.
      payload[field] = value || (field === "grade" || field === "group" || field === "campus" ? null : value);
    }
    const notes = editing.values.notes.trim();
    if (notes !== before.notes.trim()) payload.notes = notes || null;
    if (editing.values.active !== before.active) payload.active = editing.values.active;
    if (Object.keys(payload).length === 0) {
      setEditing(null);
      return;
    }
    setIsSavingEdit(true);
    setEditError("");
    try {
      const saved = await api<PersonRecord>(`/people/${editing.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      applyServerPerson(saved, Object.keys(payload));
      setMessage(
        `Saved ${`${saved.firstName} ${saved.lastName}`.trim() || saved.personId}.` +
          (saved.active === false && !showInactive
            ? ' They are now inactive; tick "Show inactive" to see them.'
            : ""),
      );
      setEditing(null);
    } catch (saveError) {
      const text = errorMessage(saveError, "Unable to save person.");
      setEditError(
        /already exists/i.test(text)
          ? "Another person already uses that Person ID or badge code."
          : text,
      );
    } finally {
      setIsSavingEdit(false);
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
      const deletedId = personToDelete.id;
      setPersonToDelete(null);
      setDeletePhrase("");
      // Remove just this row so unsaved edits on other rows are kept.
      const remaining = { ...originalsRef.current };
      delete remaining[deletedId];
      originalsRef.current = remaining;
      setPeople((curr) => curr.filter((row) => row.id !== deletedId));
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
        if (!showInactive && person.active === false) return false;
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
    [people, normalizedSearch, gradeFilter, isCampMeeting, showInactive],
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
        <label>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => toggleShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
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
              filteredPeople.map((p) => {
                const isDirty = dirtyFieldsOf(p).length > 0;
                const isSaving = savingIds.includes(p.id);
                return (
                <tr key={p.id} className={p.active === false ? "person-inactive" : undefined}>
                  <td>
                    {personDisplayName(p)}
                    {p.active === false && <span className="person-inactive-label">Inactive</span>}
                  </td>
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
                          disabled={!isDirty || isSaving}
                          title={isDirty ? "Save the changes on this row" : "No unsaved changes on this row"}
                          onClick={() => void savePerson(p)}
                        >
                          {isSaving ? "Saving…" : "Save"}
                        </button>
                      )}
                      <button
                        className="small secondary"
                        type="button"
                        onClick={() => openEdit(p)}
                      >
                        Edit
                      </button>
                      {isTally && (
                        <button
                          className="small secondary"
                          type="button"
                          onClick={() => void resetTallies(p)}
                        >
                          Reset
                        </button>
                      )}
                      {isAdmin && (
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
                      )}
                      {isDirty && <span className="person-unsaved">Unsaved</span>}
                    </div>
                  </td>
                </tr>
                );
              })
            ) : (
              <tr>
                <td className="muted" colSpan={noResultsColSpan + (isTally ? 1 : 0)}>
                  No people match your current{" "}
                  {isCampMeeting ? "search" : "search and grade filters"}.
                  {!showInactive && people.some((person) => person.active === false)
                    ? " Inactive people are hidden."
                    : ""}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {confirmDialog}
      {editing && (
        <Modal title="Edit Person" onClose={() => { if (!isSavingEdit) setEditing(null); }}>
          <form className="stack" onSubmit={(e) => void saveEdit(e)}>
            {EDIT_TEXT_FIELDS.map(([field, label, required]) => (
              <label key={field}>
                {label}
                <input
                  value={editing.values[field]}
                  required={required}
                  onChange={(e) =>
                    setEditing({ ...editing, values: { ...editing.values, [field]: e.target.value } })
                  }
                />
              </label>
            ))}
            <label>
              Notes (optional)
              <textarea
                rows={2}
                value={editing.values.notes}
                onChange={(e) =>
                  setEditing({ ...editing, values: { ...editing.values, notes: e.target.value } })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={editing.values.active}
                onChange={(e) =>
                  setEditing({ ...editing, values: { ...editing.values, active: e.target.checked } })
                }
              />
              Active (inactive people cannot scan for meals)
            </label>
            {editError && <p className="error">{editError}</p>}
            <div className="button-row">
              <button
                className="secondary"
                type="button"
                disabled={isSavingEdit}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="primary" type="submit" disabled={isSavingEdit}>
                {isSavingEdit ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </Modal>
      )}
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
