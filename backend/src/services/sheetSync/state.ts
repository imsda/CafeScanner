type SchedulerStatus = {
  schedulerEnabled: boolean;
  lastAutomaticCheckTime: string | null;
  lastAutomaticWriteBackTime: string | null;
  lastAutomaticImportTime: string | null;
  lastAutomaticImportSummary: string | null;
  lastSkipReason: string | null;
  lastSyncError: string | null;
  lastCycleDurationMs: number | null;
  lastLogSyncTime: string | null;
  lastRowsUpdated: number;
  lastCampMeetingWriteBackError: string | null;
  lastScheduledCycleOrder: string | null;
  nextExpectedRunTime: string | null;
};

export const schedulerStatus: SchedulerStatus = {
  schedulerEnabled: false,
  lastAutomaticCheckTime: null,
  lastAutomaticWriteBackTime: null,
  lastAutomaticImportTime: null,
  lastAutomaticImportSummary: null,
  lastSkipReason: null,
  lastSyncError: null,
  lastCycleDurationMs: null,
  lastLogSyncTime: null,
  lastRowsUpdated: 0,
  lastCampMeetingWriteBackError: null,
  lastScheduledCycleOrder: null,
  nextExpectedRunTime: null
};
