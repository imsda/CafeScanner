let resetInProgress = false;

export function isResetInProgress() {
  return resetInProgress;
}

export function startReset() {
  if (resetInProgress) return false;
  resetInProgress = true;
  return true;
}

export function endReset() {
  resetInProgress = false;
}
