import { useEffect, useState } from "react";
import { api, API_BASE } from "../api/client";
import type { MealTrackingMode } from "../api/types";
import { ButtonLink } from "../components/ButtonLink";

export function ImportPage() {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<any>();
  const [result, setResult] = useState<any>();
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [settings, setSettings] = useState<{
    mealTrackingMode: MealTrackingMode;
  } | null>(null);

  useEffect(() => {
    void api<{ mealTrackingMode: MealTrackingMode }>("/settings").then(
      setSettings,
    );
  }, []);

  const isCampMeeting = settings?.mealTrackingMode === "camp_meeting";

  async function parseJsonOrThrow(res: Response) {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : "Import request failed";
      throw new Error(message);
    }

    return payload;
  }

  async function previewFile() {
    if (!file) return;

    setError("");
    setResult(undefined);

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_BASE}/import/preview`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      setPreview(await parseJsonOrThrow(res));
    } catch (previewError) {
      setPreview(undefined);
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Unable to preview import file.",
      );
    }
  }

  async function commit() {
    if (!file || isSubmitting) return;

    const form = new FormData();
    form.append("file", file);
    if (isCampMeeting) {
      const confirmed = window.confirm(
        "Replace existing Camp Meeting entitlements with this upload?",
      );
      if (!confirmed) return;
      form.append("replaceExisting", "true");
    } else {
      form.append("generateMissingCodes", "true");
    }

    setIsSubmitting(true);
    setError("");
    setResult(undefined);

    try {
      const res = await fetch(`${API_BASE}/import/commit`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      setResult(await parseJsonOrThrow(res));
    } catch (commitError) {
      setError(
        commitError instanceof Error
          ? commitError.message
          : "Unable to import CSV.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

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
      <input
        type="file"
        accept=".csv"
        onChange={(e) => setFile(e.target.files?.[0])}
      />
      <div className="button-row">
        <button
          className="secondary"
          onClick={previewFile}
          disabled={!file || isSubmitting}
        >
          Preview
        </button>
        <button
          className="primary"
          onClick={commit}
          disabled={!file || isSubmitting}
        >
          {isSubmitting
            ? "Importing…"
            : isCampMeeting
              ? "Upload Camp Meeting CSV"
              : "Commit Partial Import"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {preview && <pre>{JSON.stringify(preview, null, 2)}</pre>}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
