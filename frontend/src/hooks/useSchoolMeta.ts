import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { MealTrackingMode } from "../api/types";

export type SchoolMeta = { schoolName: string; timezone: string; mealTrackingMode: MealTrackingMode };

// One shared request per page load; available to every signed-in user (unlike /settings).
let cached: Promise<SchoolMeta> | null = null;

export function loadSchoolMeta(): Promise<SchoolMeta> {
  if (!cached) {
    cached = api<SchoolMeta>("/meta").catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** Call after changing the meal tracking mode, timezone or school name. */
export function invalidateSchoolMeta() {
  cached = null;
}

export function useSchoolMeta() {
  const [meta, setMeta] = useState<SchoolMeta | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    loadSchoolMeta()
      .then((loaded) => { if (active) setMeta(loaded); })
      .catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load school settings."); });
    return () => { active = false; };
  }, []);
  return { meta, error };
}
