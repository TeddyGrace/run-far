export interface RecoveryHistoryEntry {
  date: string;
  recovery: {
    recoveryScore: number | null;
    hrvRmssdMs: number | null;
    restingHr: number | null;
    scoreState: string;
  } | null;
  sleep: {
    durationMin: number | null;
    efficiencyPct: number | null;
    sleepDebtMin: number | null;
  } | null;
  strain: number | null;
}
