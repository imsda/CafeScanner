import { useEffect, useState } from "react";
import { api, apiUpload, API_BASE, errorMessage } from "../api/client";
import type { MealTrackingMode } from "../api/types";
import { ButtonLink } from "../components/ButtonLink";
import { useConfirm } from "../components/useConfirm";

type PreviewResponse = {
  total: number;
  mode: MealTrackingMode;
  preview: Array<{ valid: boolean; errors: string[] }>;
};

// Camp Meeting and people imports return different summaries; show whichever fields are present.
type ImportResult = {
  totalRows?: number;
  successRows?: number;
  failedRows?: number;
  validRows?: number;
  skippedRows?: number;
  peopleCreated?: number;
  peopleUpdated?: number;
  entitlementsCreated?: number;
  entitlementsUpdated?: number;
  duplicateTicketIdCount?: number;
  errors?: Array<string | { row: number; error: string }>;
  skippedRowReasons?: Array<{ row: number; reason: string }>;
};

const RESULT_LABELS: Array<[keyof ImportResult, string]> = [
  ["totalRows", "Rows in file"],
  ["successRows", "Imported"],
  ["validRows", "Valid rows"],
  ["failedRows", "Failed"],
  ["skippedRows", "Skipped"],
  ["peopleCreated", "People created"],
  ["peopleUpdated", "People updated"],
  ["entitlementsCreated", "Entitlements created"],
  ["entitlementsUpdated", "Entitlements updated"],
  ["duplicateTicketIdCount", "Duplicate ticket IDs"],
];

const MAX_LISTED_PROBLEMS = 20;

export function ImportPage() {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<PreviewResponse>();
  const [result, setResult] = useState<ImportResult>();
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mealTrackingMode, setMealTrackingMode] = useState<MealTrackingMode | null>(null);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    api<{ mealTrackingMode: MealTrackingMode }>("/meta")
      .then((meta) => setMealTrackingMode(meta.mealTrackingMode))
      .catch((loadError) => setError(errorMessage(loadError, "Unable to load the meal tracking mode.")));
  }, []);

  const isCampMeeting = mealTrackingMode === "camp_meeting";

  function buildForm() {
    const form = new FormData();
    if (file) form.append("file", file);
    return form;
  }

  async function previewFile() {
    if (!file) return;
    setError("");
    setResult(undefined);
    try {
      setPreview(await apiUpload<PreviewResponse>("/import/preview", buildForm()));
    } catch (previewError) {
      setPreview(undefined);
      setError(errorMessage(previewError, "Unable to preview import file."));
    }
  }

  async function commit() {
    if (!file || isSubmitting) return;

    const form = buildForm();
    if (isCampMeeting) {
      const confirmed = await confirm({
        title: "Replace Camp Meeting entitlements?",
        message: "This upload replaces all existing Camp Meeting entitlements.",
        confirmLabel: "Replace and import",
        danger: true,
      });
      if (confirmed === null) return;
      form.append("replaceExisting", "true");
    } else {
      form.append("generateMissingCodes", "true");
    }

    setIsSubmitting(true);
    setError("");
    setResult(undefined);
    try {
      setResult(await apiUpload<ImportResult>("/import/commit", form));
    } catch (commitError) {
      setError(errorMessage(commitError, "Unable to import CSV."));
    } finally {
      setIsSubmitting(false);
    }
  }

  const invalidPreviewRows = preview?.preview
    .map((row, index) => ({ ...row, rowNumber: index + 2 }))
    .filter((row) => !row.valid) ?? [];
  const resultProblems = [
    ...(result?.errors ?? []).map((entry) => (typeof entry === "string" ? entry : `Row ${entry.row}: ${entry.error}`)),
    ...(result?.skippedRowReasons ?? []).map((entry) => `Row ${entry.row}: ${entry.reason}`),
  ];

  return (
    <div className="card stack">
      <h2>{isCampMeeting ? "Camp Meeting Import" : "CSV Import"}</h2>
      <div className="button-row">
        <ButtonLink
          href={`${API_BASE}/import/template`}
          className="btn-secondary"
          target="_blank"
          rel="noreferrer"
        >
          Download Template
        </ButtonLink>
      </div>
      <label>
        CSV file
        <input
          type="file"
          accept=".csv"
          onChange={(e) => { setFile(e.target.files?.[0]); setPreview(undefined); setResult(undefined); }}
        />
      </label>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          onClick={() => void previewFile()}
          disabled={!file || isSubmitting}
        >
          Preview
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void commit()}
          disabled={!file || isSubmitting}
        >
          {isSubmitting
            ? "Importing…"
            : isCampMeeting
              ? "Upload Camp Meeting CSV"
              : "Import Valid Rows"}
        </button>
      </div>
      {!isCampMeeting && (
        <p className="muted">Rows with problems are skipped; every valid row is imported.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {preview && (
        <section className="stack" aria-live="polite">
          <h3>Preview</h3>
          <p>
            {preview.total} row{preview.total === 1 ? "" : "s"} found:{" "}
            <strong>{preview.total - invalidPreviewRows.length} valid</strong>
            {invalidPreviewRows.length > 0 && <>, <span className="error">{invalidPreviewRows.length} with problems</span></>}.
          </p>
          {invalidPreviewRows.length > 0 && (
            <ul>
              {invalidPreviewRows.slice(0, MAX_LISTED_PROBLEMS).map((row) => (
                <li key={row.rowNumber}>Row {row.rowNumber}: {row.errors.join("; ")}</li>
              ))}
              {invalidPreviewRows.length > MAX_LISTED_PROBLEMS && <li>…and {invalidPreviewRows.length - MAX_LISTED_PROBLEMS} more</li>}
            </ul>
          )}
        </section>
      )}
      {result && (
        <section className="stack" aria-live="polite">
          <h3>Import complete</h3>
          <dl className="summary-list">
            {RESULT_LABELS.filter(([key]) => typeof result[key] === "number").map(([key, label]) => (
              <div key={key}><dt>{label}</dt><dd>{result[key] as number}</dd></div>
            ))}
          </dl>
          {resultProblems.length > 0 && (
            <ul>
              {resultProblems.slice(0, MAX_LISTED_PROBLEMS).map((problem) => <li key={problem}>{problem}</li>)}
              {resultProblems.length > MAX_LISTED_PROBLEMS && <li>…and {resultProblems.length - MAX_LISTED_PROBLEMS} more</li>}
            </ul>
          )}
        </section>
      )}
      {dialog}
    </div>
  );
}
