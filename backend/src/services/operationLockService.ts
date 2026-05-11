type OperationKey = 'import' | 'reset' | 'writeback';

const state = {
  importInProgress: false,
  resetInProgress: false,
  writebackInProgress: false,
  schedulerPaused: false
};

function keyToFlag(key: OperationKey): keyof typeof state {
  if (key === 'import') return 'importInProgress';
  if (key === 'reset') return 'resetInProgress';
  return 'writebackInProgress';
}

export function isImportInProgress() { return state.importInProgress; }
export function isResetInProgress() { return state.resetInProgress; }
export function isWritebackInProgress() { return state.writebackInProgress; }
export function isSchedulerPaused() { return state.schedulerPaused; }
export function pauseScheduler() { state.schedulerPaused = true; }
export function resumeScheduler() { state.schedulerPaused = false; }

export function acquireOperationLock(key: OperationKey): boolean {
  const flag = keyToFlag(key);
  if (state[flag]) return false;
  state[flag] = true;
  return true;
}

export function releaseOperationLock(key: OperationKey) {
  state[keyToFlag(key)] = false;
}

export async function waitForOperationsToFinish(keys: OperationKey[], label: string, timeoutMs = 30000) {
  const start = Date.now();
  while (keys.some((key) => state[keyToFlag(key)])) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label} timed out waiting for operations: ${keys.join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

