import { useEffect, useState } from "react";
import { ApiNetworkError, api, apiUpload, API_BASE, errorMessage } from "../api/client";
import { useConfirm } from "../components/useConfirm";
import { invalidateSchoolMeta } from "../hooks/useSchoolMeta";
import type { MealTrackingMode, Settings, GoogleSheetsSchedulerStatus, SystemUpdateResult, SystemUpdateStatus } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { formatDateTime, renderStoredTimeValue, modeLabel } from "../lib/format";
import { TIMEZONE_OPTIONS, normalizeSettingsForTimeAndTimezone } from "../lib/settings";
import { Modal } from "../components/Modal";

export function SettingsPage() {
  const { user } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [settings, setSettings] = useState<Settings>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [clearPhrase, setClearPhrase] = useState("");
  const [clearAction, setClearAction] = useState<
    "clear-meal-data" | "clear-people-import-data" | "reset-meal-tracking-data"
  >("reset-meal-tracking-data");
  const [showClearModal, setShowClearModal] = useState(false);
  const [isClearingDatabase, setIsClearingDatabase] = useState(false);
  const [showModeConfirm, setShowModeConfirm] = useState(false);
  const [modePhrase, setModePhrase] = useState("");
  const [pendingMode, setPendingMode] = useState<MealTrackingMode | null>(null);
  const [showFullWipeConfirm, setShowFullWipeConfirm] = useState(false);
  const [fullWipePhrase, setFullWipePhrase] = useState("");
  const [fullWipeResult, setFullWipeResult] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);
  const [isSyncingSheet, setIsSyncingSheet] = useState(false);
  const [isWritingBackSheet, setIsWritingBackSheet] = useState(false);
  const [isSavingGoogleSheetsSettings, setIsSavingGoogleSheetsSettings] = useState(false);
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [isRestoringBackup, setIsRestoringBackup] = useState(false);
  const [isRunningScheduledCheckNow, setIsRunningScheduledCheckNow] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState<GoogleSheetsSchedulerStatus | null>(null);
  const [savedGoogleSheetsSettings, setSavedGoogleSheetsSettings] = useState<{
    googleSheetsEnabled: boolean;
    googleSheetId: string;
    googleSheetTabName: string;
    googleSyncIntervalMinutes: number;
    googleAutoImportEnabled: boolean;
    tallyWriteBackMode: 'lifetime' | 'weekly' | 'both';
    tallyWeeklyRawTabName: string;
    tallyWeeklyViewTabName?: string | null;
    tallyWeekStartsOn: 'SUNDAY' | 'MONDAY';
  } | null>(null);
  const [activeSettingsSection, setActiveSettingsSection] = useState<
    "general" | "meal-tracking" | "scanner" | "google-sheets-sync" | "updates" | "data-reset-tools" | "danger-zone"
  >("general");
  const [updateStatus, setUpdateStatus] = useState<SystemUpdateStatus | null>(null);
  const [updateOutput, setUpdateOutput] = useState("");
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [resetSuccessMessage, setResetSuccessMessage] = useState("");
  const [showResetSuccessModal, setShowResetSuccessModal] = useState(false);
  const [resetErrorMessage, setResetErrorMessage] = useState('');
  const [showResetErrorModal, setShowResetErrorModal] = useState(false);
  const formatDateTimeSafe = (value?: string | null, fallback = "Never") =>
    value ? formatDateTime(value, settings?.timezone) : fallback;

  const [loadError, setLoadError] = useState("");

  const load = async () => {
    let loaded: Settings;
    try {
      loaded = await api<Settings>("/settings");
      setLoadError("");
    } catch (settingsError) {
      setLoadError(errorMessage(settingsError, "Unable to load settings."));
      return;
    }
    // Mode, timezone and school name are cached for other pages; refresh them after any change.
    invalidateSchoolMeta();
    setSettings(normalizeSettingsForTimeAndTimezone(loaded));
    setSavedGoogleSheetsSettings({
      googleSheetsEnabled: loaded.googleSheetsEnabled,
      googleSheetId: loaded.googleSheetId ?? "",
      googleSheetTabName: loaded.googleSheetTabName,
      googleSyncIntervalMinutes: loaded.googleSyncIntervalMinutes,
      googleAutoImportEnabled: loaded.googleAutoImportEnabled ?? true,
      tallyWriteBackMode: loaded.tallyWriteBackMode ?? 'lifetime',
      tallyWeeklyRawTabName: loaded.tallyWeeklyRawTabName ?? 'Weekly Tally Raw',
      tallyWeeklyViewTabName: loaded.tallyWeeklyViewTabName ?? '',
      tallyWeekStartsOn: loaded.tallyWeekStartsOn ?? 'MONDAY',
    });
    if (user?.role === "OWNER" || user?.role === "ADMIN") {
      // Secondary panels: a failure here (e.g. no network for the update check) must not block Settings.
      void api<GoogleSheetsSchedulerStatus>("/settings/google-sheets/scheduler-status")
        .then(setSchedulerStatus)
        .catch((statusError) => setError(errorMessage(statusError, "Unable to load Google Sheets sync status.")));
      void api<SystemUpdateStatus>("/system/update-status")
        .then(setUpdateStatus)
        .catch(() => setUpdateStatus(null));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const clearEnabled =
    clearPhrase === "RESET MEAL TRACKING DATA" && !isClearingDatabase;
  const modeEnabled = modePhrase === "SWITCH MODE";
  const fullWipeEnabled = fullWipePhrase === "ARM FULL WIPE";
  const isOwner = user?.role === "OWNER";
  const canManageGoogleSheets = user?.role === "OWNER" || user?.role === "ADMIN";
  const canManageBackups = user?.role === "OWNER" || user?.role === "ADMIN";
  const canManageUpdates = user?.role === "OWNER" || user?.role === "ADMIN";
  const canManageData = user?.role === "OWNER" || user?.role === "ADMIN";
  const isCampMeetingMode = settings?.mealTrackingMode === "camp_meeting";
  const isGoogleSheetsSyncEnabled = Boolean(settings?.googleSheetsEnabled);
  const hasGoogleSheetId = Boolean(settings?.googleSheetId?.trim());
  const hasUnsavedGoogleSheetsChanges =
    !!savedGoogleSheetsSettings &&
    (settings?.googleSheetsEnabled !== savedGoogleSheetsSettings.googleSheetsEnabled ||
      (settings?.googleSheetId ?? "") !== savedGoogleSheetsSettings.googleSheetId ||
      settings?.googleSheetTabName !== savedGoogleSheetsSettings.googleSheetTabName ||
      settings?.googleSyncIntervalMinutes !== savedGoogleSheetsSettings.googleSyncIntervalMinutes ||
      (settings?.googleAutoImportEnabled ?? true) !== savedGoogleSheetsSettings.googleAutoImportEnabled ||
      (settings?.tallyWriteBackMode ?? 'lifetime') !== savedGoogleSheetsSettings.tallyWriteBackMode ||
      (settings?.tallyWeeklyRawTabName ?? 'Weekly Tally Raw') !== savedGoogleSheetsSettings.tallyWeeklyRawTabName ||
      (settings?.tallyWeeklyViewTabName ?? '') !== (savedGoogleSheetsSettings.tallyWeeklyViewTabName ?? '') ||
      (settings?.tallyWeekStartsOn ?? 'MONDAY') !== savedGoogleSheetsSettings.tallyWeekStartsOn);

  async function saveSettings(settingsOverride?: Settings, successMessage = "Settings saved.") {
    const sourceSettings = settingsOverride ?? settings;
    if (!sourceSettings) return null;
    const normalized = normalizeSettingsForTimeAndTimezone(sourceSettings);
    setError("");
    const payload = Object.fromEntries(
      Object.entries(normalized).filter(
        ([key]) =>
          ![
            "id",
            "updatedAt",
            "mealTrackingMode",
            "fullWipeTokenHash",
            "fullWipeTokenExpiresAt",
            "fullWipeTokenUsedAt",
            "fullWipeArmedByUserId",
          ].includes(key),
      ),
    );
    const saved = normalizeSettingsForTimeAndTimezone(
      await api<Settings>("/settings", { method: "PUT", body: JSON.stringify(payload) }),
    );
    setMessage(successMessage);
    setSettings(saved);
    setSavedGoogleSheetsSettings({
      googleSheetsEnabled: saved.googleSheetsEnabled,
      googleSheetId: saved.googleSheetId ?? "",
      googleSheetTabName: saved.googleSheetTabName,
      googleSyncIntervalMinutes: saved.googleSyncIntervalMinutes,
      googleAutoImportEnabled: saved.googleAutoImportEnabled ?? true,
      tallyWriteBackMode: saved.tallyWriteBackMode ?? 'lifetime',
      tallyWeeklyRawTabName: saved.tallyWeeklyRawTabName ?? 'Weekly Tally Raw',
      tallyWeeklyViewTabName: saved.tallyWeeklyViewTabName ?? '',
      tallyWeekStartsOn: saved.tallyWeekStartsOn ?? 'MONDAY',
    });
    return saved;
  }

  async function saveGoogleSheetsSettings(settingsOverride?: Settings) {
    setIsSavingGoogleSheetsSettings(true);
    try {
      return await saveSettings(settingsOverride, "Google Sheets settings saved.");
    } finally {
      setIsSavingGoogleSheetsSettings(false);
    }
  }

  if (!settings) {
    return loadError
      ? <div className="card stack"><h2>Settings</h2><p className="error" role="alert">{loadError}</p></div>
      : <p className="muted">Loading settings…</p>;
  }

  async function clearOperationalData() {
    if (!clearEnabled) return;
    setIsClearingDatabase(true);
    setError("");
    setMessage("");
    try {
      await api(`/system/${clearAction}`, { method: "POST" });
      const resetSummaryByAction: Record<typeof clearAction, string> = {
        "clear-meal-data": "Meal data was cleared.",
        "clear-people-import-data": "People and import data were cleared.",
        "reset-meal-tracking-data": "All meal tracking data was reset.",
      };
      setMessage("Operation completed successfully.");
      setResetSuccessMessage(resetSummaryByAction[clearAction]);
      setShowResetSuccessModal(true);
      setShowClearModal(false);
      setClearPhrase("");
      await load();
    } catch (clearError) {
      const message = clearError instanceof Error ? clearError.message : 'Unable to clear data.';
      setError(message);
      setResetErrorMessage(message);
      setShowResetErrorModal(true);
    } finally {
      setIsClearingDatabase(false);
    }
  }

  async function armFullWipe() {
    if (!fullWipeEnabled) return;
    setError("");
    setMessage("");
    const response = await api<{ token: string; expiresAt: string }>(
      "/settings/full-wipe/arm",
      {
        method: "POST",
        body: JSON.stringify({ confirmationPhrase: fullWipePhrase }),
      },
    );
    setFullWipeResult(response);
    setShowFullWipeConfirm(false);
    setFullWipePhrase("");
  }

  async function checkForUpdates() {
    if (!canManageUpdates) return;
    setIsCheckingUpdates(true);
    setError("");
    try {
      const status = await api<SystemUpdateStatus>("/system/update-status");
      setUpdateStatus(status);
      setMessage("Update status refreshed.");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Unable to check for updates.");
    } finally {
      setIsCheckingUpdates(false);
    }
  }

  async function installUpdate() {
    if (!isOwner) return;
    setIsInstallingUpdate(true);
    setError("");
    setMessage("");
    try {
      const result = await api<SystemUpdateResult>("/system/update", { method: "POST" });
      setUpdateOutput(result.output || "No update output returned.");
      setMessage(result.ok ? "Update completed successfully." : "Update failed.");
      await checkForUpdates();
    } catch (updateError) {
      const fallbackMessage = updateError instanceof Error ? updateError.message : "Unable to install update.";
      const diagnostics = updateStatus?.updateScriptDiagnostics;
      const scriptCheckPassed = Boolean(diagnostics?.exists && diagnostics?.executable);
      if (scriptCheckPassed && fallbackMessage.toLowerCase().includes("missing or not executable")) {
        setError("Unable to install update. The script exists and is executable; review diagnostics/output for the root cause.");
      } else {
        setError(fallbackMessage);
      }
    } finally {
      setIsInstallingUpdate(false);
    }
  }

  function downloadBackup() {
    setMessage("");
    setError("");
    window.open(`${API_BASE}/system/backups/download`, "_blank");
  }

  async function restoreBackup() {
    if (!backupFile) return;
    if (!backupFile.name.toLowerCase().endsWith(".db")) {
      setError("Please select a valid .db backup file.");
      return;
    }
    const confirmed = await confirm({
      title: "Restore backup?",
      message: "Restoring a backup replaces the current database. A snapshot of the current data is saved first.",
      confirmLabel: "Restore Backup",
      danger: true,
    });
    if (confirmed === null) return;

    setMessage("");
    setError("");
    setIsRestoringBackup(true);
    const formData = new FormData();
    formData.append("backup", backupFile);
    try {
      const payload = await apiUpload<{ message?: string }>("/system/backups/restore", formData);
      setMessage(`${payload?.message || "Backup restored successfully."} Please reload if data looks stale.`);
      setBackupFile(null);
      await load();
    } catch (restoreError) {
      setError(errorMessage(restoreError, "Backup restore failed."));
    } finally {
      setIsRestoringBackup(false);
    }
  }

  return (
    <div className="card stack">
      <h2>Settings</h2>
      {message && <p>{message}</p>}
      {error && <p className="error">{error}</p>}
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" role="tab" aria-selected={activeSettingsSection === "general"} className={activeSettingsSection === "general" ? "primary" : "secondary"} onClick={() => setActiveSettingsSection("general")}>General</button>
        <button type="button" role="tab" aria-selected={activeSettingsSection === "meal-tracking"} className={activeSettingsSection === "meal-tracking" ? "primary" : "secondary"} onClick={() => setActiveSettingsSection("meal-tracking")}>Meal Tracking</button>
        <button type="button" role="tab" aria-selected={activeSettingsSection === "scanner"} className={activeSettingsSection === "scanner" ? "primary" : "secondary"} onClick={() => setActiveSettingsSection("scanner")}>Scanner</button>
        <button type="button" role="tab" aria-selected={activeSettingsSection === "google-sheets-sync"} className={activeSettingsSection === "google-sheets-sync" ? "primary" : "secondary"} onClick={() => setActiveSettingsSection("google-sheets-sync")}>Google Sheets Sync</button>
        {canManageUpdates && <button type="button" role="tab" aria-selected={activeSettingsSection === "updates"} className={activeSettingsSection === "updates" ? "primary" : "secondary"} onClick={() => setActiveSettingsSection("updates")}>Updates</button>}
        {canManageData && <button type="button" role="tab" aria-selected={activeSettingsSection === "data-reset-tools"} className={activeSettingsSection === "data-reset-tools" ? "primary" : "secondary"} onClick={() => setActiveSettingsSection("data-reset-tools")}>Data Reset Tools</button>}
        {canManageData && <button type="button" role="tab" aria-selected={activeSettingsSection === "danger-zone"} className={activeSettingsSection === "danger-zone" ? "primary" : "secondary"} onClick={() => setActiveSettingsSection("danger-zone")}>Danger Zone</button>}
      </div>

      {activeSettingsSection === "general" && (
      <section className="card stack compact-card">
        <h3>General</h3>
        <label>
          School name
          <input
            value={settings.schoolName}
            onChange={(e) => setSettings({ ...settings, schoolName: e.target.value })}
          />
        </label>
        <label>
          Timezone
          <select
            value={settings.timezone}
            onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.hideInactiveByDefault}
            onChange={(e) =>
              setSettings({ ...settings, hideInactiveByDefault: e.target.checked })
            }
          />
          Hide inactive people by default
        </label>
        <button type="button" className="primary" onClick={() => void saveSettings()}>
          Save General Settings
        </button>
      </section>)}

      {activeSettingsSection === "meal-tracking" && (<section className="card stack compact-card">
        <h3>Meal Tracking</h3>
        <p className="muted">
          Current active mode: <strong>{modeLabel(settings.mealTrackingMode)}</strong>
        </p>
        <label>
          Meal tracking mode
          <select
            value={settings.mealTrackingMode}
            disabled={!canManageData}
            onChange={(e) => {
              const selected = e.target.value as MealTrackingMode;
              if (selected === settings.mealTrackingMode) return;
              setPendingMode(selected);
              setShowModeConfirm(true);
              setModePhrase("");
            }}
          >
            <option value="camp_meeting">
              Camp Meeting (redeem imported meal entitlements)
            </option>
            <option value="countdown">
              Count Down (deduct from remaining balances)
            </option>
            <option value="tally">Tally Up (count each served meal)</option>
          </select>
        </label>
        <p className="error">
          Warning: Switching mode is destructive and will clear all people,
          transaction history, import history, and meal entitlements.
        </p>
        <p className="muted">
          Your browser may display AM/PM, but values are saved as 24-hour HH:mm.
        </p>
        <label>Breakfast start<input type="time" value={settings.breakfastStart} onChange={(e) => setSettings({ ...settings, breakfastStart: e.target.value })} /><small className="muted">Stored value: {renderStoredTimeValue(settings.breakfastStart)}</small></label>
        <label>Breakfast end<input type="time" value={settings.breakfastEnd} onChange={(e) => setSettings({ ...settings, breakfastEnd: e.target.value })} /><small className="muted">Stored value: {renderStoredTimeValue(settings.breakfastEnd)}</small></label>
        <label>Lunch start<input type="time" value={settings.lunchStart} onChange={(e) => setSettings({ ...settings, lunchStart: e.target.value })} /><small className="muted">Stored value: {renderStoredTimeValue(settings.lunchStart)}</small></label>
        <label>Lunch end<input type="time" value={settings.lunchEnd} onChange={(e) => setSettings({ ...settings, lunchEnd: e.target.value })} /><small className="muted">Stored value: {renderStoredTimeValue(settings.lunchEnd)}</small></label>
        <label>Dinner start<input type="time" value={settings.dinnerStart} onChange={(e) => setSettings({ ...settings, dinnerStart: e.target.value })} /><small className="muted">Stored value: {renderStoredTimeValue(settings.dinnerStart)}</small></label>
        <label>Dinner end<input type="time" value={settings.dinnerEnd} onChange={(e) => setSettings({ ...settings, dinnerEnd: e.target.value })} /><small className="muted">Stored value: {renderStoredTimeValue(settings.dinnerEnd)}</small></label>
        <label>
          Complete days without a meal before warning
          <input type="number" min={1} max={365} step={1} value={settings.studentMealWarningDays}
            onChange={(e) => setSettings({ ...settings, studentMealWarningDays: Math.max(1, Number(e.target.value) || 1) })} />
          <small className="muted">Only applies to students in Tally Up mode. Clearing a warning starts the count over.</small>
        </label>
        <button type="button" className="primary" onClick={() => void saveSettings()}>Save Meal Tracking Settings</button>
      </section>)}

      {activeSettingsSection === "scanner" && (<section className="card stack compact-card">
        <h3>Scanner</h3>
        <label>
          Scanner cooldown (seconds)
          <input
            type="number"
            min={0.5}
            max={10}
            step={0.5}
            value={settings.scannerCooldownSeconds}
            onChange={(e) =>
              setSettings({ ...settings, scannerCooldownSeconds: Number(e.target.value) })
            }
          />
        </label>
        <label>
          Station name
          <input
            value={settings.stationName}
            onChange={(e) => setSettings({ ...settings, stationName: e.target.value })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.scannerDiagnosticsEnabled}
            onChange={(e) =>
              setSettings({ ...settings, scannerDiagnosticsEnabled: e.target.checked })
            }
          />
          Enable scanner diagnostics
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.enableSounds}
            onChange={(e) => setSettings({ ...settings, enableSounds: e.target.checked })}
          />
          Enable scan sounds
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.allowManualMealOverride}
            onChange={(e) =>
              setSettings({ ...settings, allowManualMealOverride: e.target.checked })
            }
          />
          Allow manual meal override
        </label>
        <button type="button" className="primary" onClick={() => void saveSettings()}>Save Scanner Settings</button>
      </section>)}

      {canManageGoogleSheets && activeSettingsSection === "google-sheets-sync" ? (
        <section className="card stack compact-card">
          <h3>Google Sheets Sync</h3>
          <>
              <label>
                <input
                  type="checkbox"
                  checked={settings.googleSheetsEnabled}
                  onChange={(e) =>
                    setSettings({ ...settings, googleSheetsEnabled: e.target.checked })
                  }
                />
                Enable Google Sheets Sync
              </label>
              <label>
                Google Sheet URL or Sheet ID
                <input
                  value={settings.googleSheetId ?? ""}
                  onChange={(e) => setSettings({ ...settings, googleSheetId: e.target.value })}
                />
              </label>
              <p className="muted">
                Share your Google Sheet with the service account email, then paste the sheet URL here.
              </p>
              <p className="muted">
                Expected columns: {isCampMeetingMode ? "ticket_id, reg_id, guest_name, meal_type, meal_day, meal_date, ticket_type, price, redeemed, redeemed_at, redeemed_by, notes" : "ID, Name, Breakfast, Lunch, Dinner, Total"}
              </p>
              <label>
                Worksheet / Tab Name
                <input
                  value={settings.googleSheetTabName}
                  onChange={(e) =>
                    setSettings({ ...settings, googleSheetTabName: e.target.value || "Sheet1" })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.googleAutoImportEnabled ?? true}
                  onChange={(e) =>
                    setSettings({ ...settings, googleAutoImportEnabled: e.target.checked })
                  }
                />
                Automatically pull new rows from Google Sheet
              </label>
              <label>
                Sync interval (minutes)
                <input
                  type="number"
                  min={1}
                  value={settings.googleSyncIntervalMinutes}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      googleSyncIntervalMinutes: Math.max(1, Number(e.target.value) || 5),
                    })
                  }
                />
              </label>
              {settings.mealTrackingMode === "tally" && (
                <>
                  <label>
                    Tally write-back mode
                    <select
                      value={settings.tallyWriteBackMode ?? "lifetime"}
                      onChange={(e) => setSettings({ ...settings, tallyWriteBackMode: e.target.value as "lifetime" | "weekly" | "both" })}
                    >
                      <option value="lifetime">Lifetime</option>
                      <option value="weekly">Weekly</option>
                      <option value="both">Both</option>
                    </select>
                  </label>
                  <label>
                    Weekly tally raw tab name
                    <input
                      value={settings.tallyWeeklyRawTabName ?? "Weekly Tally Raw"}
                      onChange={(e) => setSettings({ ...settings, tallyWeeklyRawTabName: e.target.value || "Weekly Tally Raw" })}
                    />
                  </label>
                  <label>
                    Weekly tally view tab name (optional)
                    <input
                      value={settings.tallyWeeklyViewTabName ?? ""}
                      onChange={(e) => setSettings({ ...settings, tallyWeeklyViewTabName: e.target.value })}
                    />
                  </label>
                  <p className="muted">
                    Do not convert the write-back tab to a Google Sheets table. Use a separate view/pivot/filter tab for sorting.
                  </p>
                  <label>
                    Week starts on
                    <select
                      value={settings.tallyWeekStartsOn ?? "MONDAY"}
                      onChange={(e) => setSettings({ ...settings, tallyWeekStartsOn: e.target.value as "SUNDAY" | "MONDAY" })}
                    >
                      <option value="MONDAY">Monday</option>
                      <option value="SUNDAY">Sunday</option>
                    </select>
                  </label>
                </>
              )}
              <button
                type="button"
                className="primary"
                disabled={isSavingGoogleSheetsSettings}
                onClick={() => {
                  setMessage("");
                  setError("");
                  void saveGoogleSheetsSettings();
                }}
              >
                {isSavingGoogleSheetsSettings
                  ? "Saving Google Sheets Settings…"
                  : "Save Google Sheets Settings"}
              </button>
              {!hasGoogleSheetId ? (
                <p className="muted">Enter and save a Google Sheet URL or Sheet ID first.</p>
              ) : null}
          </>
          {settings.mealTrackingMode === "tally" && <p className="muted">
            Add a User Type column to your sheet: 1 or Dorm Student (or Student), 2 or Staff, 3 or Guest, 4 or Village Student.
            Blank cells preserve existing types; new people with a blank type default to Guest.
            Import the sheet to apply type changes. Google Sheets owns the user roster. Write-back updates meal counts only for users already in the sheet.
          </p>}
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => window.open("/api/import/template", "_blank")}>
              Download Template
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                !isGoogleSheetsSyncEnabled ||
                isSyncingSheet ||
                isSavingGoogleSheetsSettings ||
                !hasGoogleSheetId
              }
              onClick={() => {
                setMessage("");
                setError("");
                setIsSyncingSheet(true);
                const settingsToSave = settings;
                const savePromise = hasUnsavedGoogleSheetsChanges
                  ? saveGoogleSheetsSettings(settingsToSave)
                  : Promise.resolve(settingsToSave);
                void savePromise
                  .then(async (saved) => {
                    if (!saved) return;
                    if (!saved.googleSheetId?.trim()) {
                      throw new Error("Save Google Sheets settings before importing.");
                    }
                    const result = await api<{
                      peopleCreated: number; peopleUpdated: number; rowsImported: number; rowsSkipped: number; writeBackRowsUpdated: number; errors: string[];
                    }>(
                      "/import/google-sheet/import",
                      { method: "POST" },
                    );
                    const importedCount = result.peopleCreated + result.peopleUpdated;
                    const errorSuffix = result.errors.length
                      ? ` Reason: ${result.errors.join(" | ")}`
                      : "";
                    if (importedCount === 0) {
                      setError(`Imported 0 rows (${result.rowsSkipped} skipped).${errorSuffix || " Reason: no valid rows"}`);
                    } else {
                      setMessage(`Imported ${importedCount} rows (${result.rowsSkipped} skipped).${errorSuffix}`);
                    }
                  })
                  .catch((syncError) => {
                    if (syncError instanceof ApiNetworkError) {
                      setError(`Google Sheet import failed: could not reach backend (${syncError.message}).`);
                      return;
                    }
                    setError(syncError instanceof Error ? syncError.message : "Google Sheet import failed.");
                  })
                  .finally(() => setIsSyncingSheet(false));
              }}
            >
              Import from Google Sheet
            </button>
            <button
              type="button"
              className="secondary"
              disabled={
                !isGoogleSheetsSyncEnabled ||
                isWritingBackSheet ||
                isSavingGoogleSheetsSettings ||
                !hasGoogleSheetId
              }
              onClick={() => {
                setMessage("");
                setError("");
                setIsWritingBackSheet(true);
                const settingsToSave = settings;
                const savePromise = hasUnsavedGoogleSheetsChanges
                  ? saveGoogleSheetsSettings(settingsToSave)
                  : Promise.resolve(settingsToSave);
                void savePromise
                  .then(() =>
                    api("/import/google-sheet/write-back-now", { method: "POST" }),
                  )
                  .then(() => setMessage("Wrote back current mode data to Google Sheet."))
                  .catch((syncError) =>
                    setError(syncError instanceof Error ? syncError.message : "Google Sheet write-back failed."),
                  )
                  .finally(() => setIsWritingBackSheet(false));
              }}
            >
              Write Back to Google Sheet
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!isGoogleSheetsSyncEnabled || isSavingGoogleSheetsSettings || !hasGoogleSheetId}
              onClick={() => {
                setMessage("");
                setError("");
                const settingsToSave = settings;
                const savePromise = hasUnsavedGoogleSheetsChanges
                  ? saveGoogleSheetsSettings(settingsToSave)
                  : Promise.resolve(settingsToSave);
                void savePromise
                  .then(() => api<{ ok: boolean; tabName: string; rowsAppended: number; transactionsSynced: number; totalTransactions: number; logRowCount: number; missingTransactionsFound: number; rowsRecreated: number; duplicatesSkipped: number }>("/import/google-sheet/write-log-now", { method: "POST" }))
                  .then((result) => setMessage(`Synced LOG tab "${result.tabName}" (local=${result.totalTransactions}, log=${result.logRowCount}, missing=${result.missingTransactionsFound}, recreated=${result.rowsRecreated}, duplicates skipped=${result.duplicatesSkipped}).`))
                  .catch((syncError) => setError(syncError instanceof Error ? syncError.message : "Google Sheet LOG sync failed."));
              }}
            >
              Sync LOG now
            </button>
            <button
              type="button"
              className="secondary danger"
              disabled={!isGoogleSheetsSyncEnabled || isSavingGoogleSheetsSettings || !hasGoogleSheetId}
              onClick={() => {
                setMessage("");
                setError("");
                const settingsToSave = settings;
                const savePromise = hasUnsavedGoogleSheetsChanges
                  ? saveGoogleSheetsSettings(settingsToSave)
                  : Promise.resolve(settingsToSave);
                void savePromise
                  .then(() => api<{ ok: boolean; tabName: string; rowsRebuilt: number; totalTransactions: number }>("/import/google-sheet/rebuild-log-now", { method: "POST" }))
                  .then((result) => setMessage(`Rebuilt LOG tab "${result.tabName}" from database (${result.rowsRebuilt}/${result.totalTransactions} rows written).`))
                  .catch((syncError) => setError(syncError instanceof Error ? syncError.message : "Google Sheet LOG rebuild failed."));
              }}
            >
              Rebuild LOG from Database
            </button>
            {settings.mealTrackingMode === "tally" && (
              <button
                type="button"
                className="secondary"
                disabled={!isGoogleSheetsSyncEnabled || isSavingGoogleSheetsSettings || !hasGoogleSheetId}
                onClick={() => {
                  setMessage("");
                  setError("");
                  if (!isGoogleSheetsSyncEnabled) {
                    setError("Enable Google Sheets Sync before writing weekly tally data.");
                    return;
                  }
                  if (!hasGoogleSheetId) {
                    setError("Save a Google Sheet URL or Sheet ID before writing weekly tally data.");
                    return;
                  }
                  const weeklyTabName = (settings.tallyWeeklyRawTabName ?? '').trim() || 'Weekly Tally Raw';
                  const settingsToSave = {
                    ...settings,
                    tallyWeeklyRawTabName: weeklyTabName,
                  };
                  const savePromise = hasUnsavedGoogleSheetsChanges
                    ? saveGoogleSheetsSettings(settingsToSave)
                    : Promise.resolve(settingsToSave);
                  void savePromise
                    .then(() => api<{ ok: boolean; tabName: string; rowsUpdated: number; rowsAppended: number; rowsWritten?: number; totalRows?: number }>("/import/google-sheet/write-weekly-tally-now", { method: "POST" }))
                    .then((result) => {
                      if (!result.ok) {
                        setError('Weekly tally write-back failed.');
                        return;
                      }
                      const tabName = (result.tabName ?? '').trim() || 'Weekly Tally Raw';
                      const rowsUpdated = Number.isFinite(result.rowsUpdated) ? result.rowsUpdated : 0;
                      const rowsAppended = Number.isFinite(result.rowsAppended) ? result.rowsAppended : 0;
                      const rowsWritten = Number.isFinite(result.rowsWritten)
                        ? result.rowsWritten
                        : (rowsUpdated + rowsAppended);
                      const totalsSuffix = Number.isFinite(result.totalRows)
                        ? `, ${result.totalRows} total rows`
                        : '';
                      setMessage(`Weekly tally written to "${tabName}" (${rowsUpdated} updated, ${rowsAppended} appended, ${rowsWritten} written${totalsSuffix}).`);
                    })
                    .catch((syncError) => {
                      const message = syncError instanceof Error ? syncError.message : "Weekly tally write-back failed.";
                      setError(message || "Weekly tally write-back failed.");
                    });
                }}
              >
                Write Weekly Tally Now
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={
                !isGoogleSheetsSyncEnabled ||
                isRunningScheduledCheckNow ||
                isSavingGoogleSheetsSettings ||
                !hasGoogleSheetId
              }
              onClick={() => {
                setMessage("");
                setError("");
                setIsRunningScheduledCheckNow(true);
                void api<{ ran: boolean; rowsUpdated?: number; reason?: string }>("/settings/google-sheets/run-scheduled-check-now", { method: "POST" })
                  .then((result) => {
                    if (!result.ran) {
                      setMessage(`Scheduled check skipped: ${result.reason ?? "unknown reason"}.`);
                    } else {
                      setMessage(`Scheduled check completed: ${result.rowsUpdated ?? 0} rows updated.`);
                    }
                    return api<GoogleSheetsSchedulerStatus>("/settings/google-sheets/scheduler-status");
                  })
                  .then((status) => setSchedulerStatus(status))
                  .catch((syncError) =>
                    setError(syncError instanceof Error ? syncError.message : "Scheduled check failed."),
                  )
                  .finally(() => setIsRunningScheduledCheckNow(false));
              }}
            >
              Run Scheduled Check Now
            </button>
          </div>
          <section className="card stack">
            <h4>Google Sheets Sync Status</h4>
            <p><strong>Scheduler:</strong> {schedulerStatus?.schedulerEnabled ? "Enabled" : "Disabled"}</p>
            <p><strong>Last automatic check:</strong> {formatDateTimeSafe(schedulerStatus?.lastAutomaticCheckTime, "Never")}</p>
            <p><strong>Last automatic write-back:</strong> {formatDateTimeSafe(schedulerStatus?.lastAutomaticWriteBackTime, "Never")}</p>
            <p><strong>Last LOG export:</strong> {formatDateTimeSafe(schedulerStatus?.lastLogSyncTime, "Never")}</p>
            <p className="muted">Transactions are stored in the database. LOG is a secondary export, checked every 15 minutes during scheduled sync or when you click Sync LOG.</p>
            <p><strong>Last auto-import:</strong> {formatDateTimeSafe(schedulerStatus?.lastAutomaticImportTime, "Never")}</p>
            <p><strong>Last scheduled cycle order:</strong> {schedulerStatus?.lastScheduledCycleOrder ?? "Unknown"}</p>
            <p><strong>Last auto-import summary:</strong> {schedulerStatus?.lastAutomaticImportSummary ?? "None"}</p>
            <p><strong>Last skip reason:</strong> {schedulerStatus?.lastSkipReason ?? "None"}</p>
            <p><strong>Last tally/balance rows processed:</strong> {schedulerStatus?.lastRowsUpdated ?? 0}</p>
            <p><strong>Last sync error:</strong> {schedulerStatus?.lastSyncError ?? schedulerStatus?.lastCampMeetingWriteBackError ?? "None"}</p>
            <p><strong>Last cycle duration:</strong> {schedulerStatus?.lastCycleDurationMs == null ? "Unknown" : `${(schedulerStatus.lastCycleDurationMs / 1000).toFixed(1)} seconds`}</p>
            <p><strong>Next expected run:</strong> {formatDateTimeSafe(schedulerStatus?.nextExpectedRunTime, "Unknown")}</p>
          </section>
        </section>
      ) : null}
      {canManageUpdates && activeSettingsSection === "updates" && (
        <section className="card stack compact-card">
          <h3>Updates</h3>
          <p className="muted">Installing updates may restart the application service.</p>
          <p>Branch: <strong>{updateStatus?.branch ?? "Unknown"}</strong></p>
          <p>Local commit: <strong>{updateStatus?.localCommit ?? "Unknown"}</strong></p>
          <p>Remote commit: <strong>{updateStatus?.remoteCommit ?? "Unavailable"}</strong></p>
          <p>Update available: <strong>{updateStatus ? (updateStatus.updatesAvailable ? "Yes" : "No") : "Unknown"}</strong></p>
          <p><strong>Backend cwd:</strong> {updateStatus?.updateScriptDiagnostics.cwd ?? "Unknown"}</p>
          <p><strong>Detected repo root:</strong> {updateStatus?.updateScriptDiagnostics.repoRoot ?? "Unknown"}</p>
          <p><strong>Resolved script path:</strong> {updateStatus?.updateScriptDiagnostics.resolvedScriptPath ?? "Unknown"}</p>
          <p><strong>Script exists:</strong> {updateStatus ? (updateStatus.updateScriptDiagnostics.exists ? "Yes" : "No") : "Unknown"}</p>
          <p><strong>Script executable:</strong> {updateStatus ? (updateStatus.updateScriptDiagnostics.executable ? "Yes" : "No") : "Unknown"}</p>
          <p><strong>Script mode:</strong> {updateStatus?.updateScriptDiagnostics.statMode ?? "Unavailable"}</p>
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => void checkForUpdates()} disabled={isCheckingUpdates || isInstallingUpdate}>
              {isCheckingUpdates ? "Checking..." : "Check for updates"}
            </button>
            {isOwner && (
              <button type="button" className="primary" onClick={() => void installUpdate()} disabled={isInstallingUpdate || isCheckingUpdates || updateStatus?.updateInProgress}>
                {isInstallingUpdate ? "Installing update..." : "Install update"}
              </button>
            )}
          </div>
          {updateOutput && (
            <label>
              Update output
              <textarea value={updateOutput} readOnly rows={8} />
            </label>
          )}
        </section>
      )}

      {canManageData && activeSettingsSection === "data-reset-tools" && (<section className="card stack compact-card">
        <h3>Data Reset Tools</h3>
        <label>
          Reset action
          <select
            value={clearAction}
            onChange={(e) =>
              setClearAction(
                e.target.value as
                  | "clear-meal-data"
                  | "clear-people-import-data"
                  | "reset-meal-tracking-data",
              )
            }
          >
            <option value="clear-meal-data">Clear meal data only</option>
            <option value="clear-people-import-data">Clear people/import data</option>
            <option value="reset-meal-tracking-data">Reset all meal tracking data</option>
          </select>
        </label>
        <button type="button" className="danger" onClick={() => setShowClearModal(true)}>
          Run Reset Tool
        </button>
      </section>)}

      {canManageData && activeSettingsSection === "danger-zone" && (
        <>
      {canManageBackups ? (
        <section className="card stack compact-card">
          <h3>Backups (OWNER/ADMIN)</h3>
          <p className="error">
            Warning: Restoring a backup replaces current database data.
          </p>
          <div className="button-row">
            <button type="button" className="secondary" onClick={downloadBackup}>
              Download Backup
            </button>
          </div>
          <label>
            Restore backup (.db)
            <input type="file" accept=".db,application/x-sqlite3" onChange={(e) => setBackupFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="button-row">
            <button type="button" className="danger" disabled={!backupFile || isRestoringBackup} onClick={() => void restoreBackup()}>
              {isRestoringBackup ? "Restoring..." : "Restore Backup"}
            </button>
          </div>
        </section>
      ) : null}
      {isOwner && (
        <section className="card stack compact-card">
          <h3>Full Application Wipe (OWNER only)</h3>
          <p className="error">
            Arms a one-time wipe token for use by protected backend wipe endpoint.
          </p>
          <button
            type="button"
            className="danger"
            onClick={() => {
              setFullWipeResult(null);
              setShowFullWipeConfirm(true);
            }}
          >
            Arm Full Wipe Token
          </button>
          {fullWipeResult && (
            <div className="stack">
              <p>
                <strong>One-time token:</strong> <code>{fullWipeResult.token}</code>
              </p>
              <p className="muted">
                Expires at: {formatDateTime(fullWipeResult.expiresAt, settings.timezone)}
              </p>
            </div>
          )}
        </section>
      )}</>
      )}

      {showModeConfirm && pendingMode && (
        <Modal title="Confirm Mode Switch" onClose={() => { setShowModeConfirm(false); setPendingMode(null); setModePhrase(""); }}>
          <p>
            You are switching from <strong>{modeLabel(settings.mealTrackingMode)}</strong> to{' '}
            <strong>{modeLabel(pendingMode)}</strong>.
          </p>
          <p className="error">
            This will permanently clear operational data (people, scans, imports).
            Accounts and settings will be preserved.
          </p>
          <p>
            Type <code>SWITCH MODE</code> to continue.
          </p>
          <input
            value={modePhrase}
            onChange={(e) => setModePhrase(e.target.value)}
            placeholder="SWITCH MODE"
          />
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setShowModeConfirm(false);
                setPendingMode(null);
                setModePhrase("");
              }}
            >
              Cancel
            </button>
            <button
              className="danger"
              type="button"
              disabled={!modeEnabled}
              onClick={() => {
                void api("/settings/meal-tracking-mode", {
                  method: "PUT",
                  body: JSON.stringify({
                    mealTrackingMode: pendingMode,
                    confirmationPhrase: modePhrase,
                  }),
                }).then(async () => {
                  setMessage(
                    `Meal tracking mode switched to ${modeLabel(pendingMode)}. Operational data was cleared.`,
                  );
                  setError("");
                  setShowModeConfirm(false);
                  setPendingMode(null);
                  setModePhrase("");
                  await load();
                }).catch((switchError) => {
                  setError(errorMessage(switchError, "Unable to switch meal tracking mode."));
                  setShowModeConfirm(false);
                  setPendingMode(null);
                  setModePhrase("");
                });
              }}
            >
              Switch Mode + Clear Data
            </button>
          </div>
        </Modal>
      )}

      {showClearModal && (
        <Modal title="Confirm Data Reset" onClose={() => { setShowClearModal(false); setClearPhrase(""); }}>
          <p>
            Type <code>RESET MEAL TRACKING DATA</code> to continue.
          </p>
          <input
            value={clearPhrase}
            onChange={(e) => setClearPhrase(e.target.value)}
            placeholder="RESET MEAL TRACKING DATA"
          />
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setShowClearModal(false);
                setClearPhrase("");
              }}
            >
              Cancel
            </button>
            <button
              className="danger"
              type="button"
              disabled={!clearEnabled}
              onClick={() => void clearOperationalData()}
            >
              Confirm Reset
            </button>
          </div>
        </Modal>
      )}

      {showFullWipeConfirm && isOwner && (
        <Modal title="Arm Full Application Wipe" onClose={() => { setShowFullWipeConfirm(false); setFullWipePhrase(""); }}>
          <p>
            Type <code>ARM FULL WIPE</code> to arm a short-lived full wipe token.
          </p>
          <input
            value={fullWipePhrase}
            onChange={(e) => setFullWipePhrase(e.target.value)}
            placeholder="ARM FULL WIPE"
          />
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setShowFullWipeConfirm(false);
                setFullWipePhrase("");
              }}
            >
              Cancel
            </button>
            <button
              className="danger"
              type="button"
              disabled={!fullWipeEnabled}
              onClick={() => void armFullWipe()}
            >
              Arm Token
            </button>
          </div>
        </Modal>
      )}

      {showResetErrorModal && (
        <Modal title="Reset Failed" onClose={() => setShowResetErrorModal(false)}>
          <p className="error">{resetErrorMessage}</p>
          <div className="button-row">
            <button type="button" className="primary" onClick={() => setShowResetErrorModal(false)}>
              OK
            </button>
          </div>
        </Modal>
      )}
      {showResetSuccessModal && (
        <Modal title="Reset Complete" onClose={() => setShowResetSuccessModal(false)}>
          <p>{resetSuccessMessage}</p>
          <div className="button-row">
            <button type="button" className="primary" onClick={() => setShowResetSuccessModal(false)}>
              OK
            </button>
          </div>
        </Modal>
      )}
      {dialog}
    </div>
  );
}
