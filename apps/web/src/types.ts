export interface RecoveryHistoryEntry {
  cycleId: string;
  // The cycle's local start date — a label for charting, not the aggregation key
  // (the row itself is already one physiological cycle, not a calendar day).
  date: string;
  cycleStart: string;
  cycleEnd: string | null;
  recovery: {
    recoveryScore: number | null;
    hrvRmssdMs: number | null;
    restingHr: number | null;
    scoreState: string;
  } | null;
  sleep: {
    durationMin: number | null;
    efficiencyPct: number | null;
    performancePct: number | null;
    sleepDebtMin: number | null;
  } | null;
  // Whoop's own 0-21 cycle strain score.
  strain: number | null;
  // Linear load (kilojoule, or an approximated fallback) — for ratio/sum math, not display.
  load: number | null;
}

export interface ZoneDurations {
  zone_zero_milli: number;
  zone_one_milli: number;
  zone_two_milli: number;
  zone_three_milli: number;
  zone_four_milli: number;
  zone_five_milli: number;
}

export interface RecentActivity {
  id: string;
  date: string;
  startedAt: string | null;
  durationMin: number | null;
  sport: string | null;
  strain: number | null;
  avgHr: number | null;
  maxHr: number | null;
  kilojoules: number | null;
  distanceM: number | null;
  percentRecorded: number | null;
  altitudeGainM: number | null;
  altitudeChangeM: number | null;
  zoneDurations: ZoneDurations | null;
}

export interface RecentActivitiesResponse {
  items: RecentActivity[];
  total: number;
  hasMore: boolean;
  sports: string[];
}
