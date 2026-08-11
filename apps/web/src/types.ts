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
    performancePct: number | null;
    sleepDebtMin: number | null;
  } | null;
  strain: number | null;
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
