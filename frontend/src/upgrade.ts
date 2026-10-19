export interface UpgradeState {
  job_id?: string | null;
  target_version?: string | null;
  step: string;
}

export function serverUpgradeCompleted(
  state: UpgradeState,
  health: { ready: boolean; app_version: string },
  expectedJob: string,
): boolean {
  return state.job_id === expectedJob && state.step === 'succeeded'
    && !!state.target_version && health.ready
    && health.app_version === state.target_version;
}

export function upgradeBusy(status?: string): boolean {
  return !!status && ['sent', 'queued', 'acknowledged', 'pulling', 'preparing', 'stopping',
    'starting', 'verifying', 'rolling_back', 'unknown'].includes(status);
}

export function upgradeFailed(status?: string): boolean {
  return !!status && ['failed', 'rolled_back', 'rollback_failed', 'unsupported', 'unknown'].includes(status);
}

export function upgradeTimestamp(value?: string | number): string {
  if (!value) return '-';
  return new Date(typeof value === 'number' ? value * 1000 : value).toLocaleTimeString();
}
