/** Shapes returned by the Whoop v2 REST API — only the fields we consume. */

export interface WhoopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  scope: string;
  token_type: string;
}

export interface WhoopPaginated<T> {
  records: T[];
  next_token: string | null;
}

export type WhoopScoreState = "SCORED" | "PENDING_SCORE" | "UNSCORABLE";

export interface WhoopRecovery {
  cycle_id: number;
  sleep_id: string; // v2 UUID
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: WhoopScoreState;
  score?: {
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
}

/** A Whoop Physiological Cycle — see https://developer.whoop.com/docs/developing/user-data/cycle.
 * `end` is absent while the cycle is still open/ongoing. No cycle.* webhooks exist. */
export interface WhoopCycle {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end?: string;
  timezone_offset: string;
  score_state: WhoopScoreState;
  score?: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  };
}

export interface WhoopSleep {
  id: string;
  cycle_id: number;
  // True for a nap; false for the primary sleep that starts the cycle.
  nap: boolean;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  score_state: WhoopScoreState;
  score?: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      sleep_efficiency_percentage: number;
    };
    sleep_needed: {
      need_from_sleep_debt_milli: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
  };
}

export interface WhoopZoneDurations {
  zone_zero_milli: number;
  zone_one_milli: number;
  zone_two_milli: number;
  zone_three_milli: number;
  zone_four_milli: number;
  zone_five_milli: number;
}

export interface WhoopWorkout {
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  sport_name?: string;
  score_state: WhoopScoreState;
  score?: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    distance_meter?: number;
    altitude_gain_meter?: number;
    altitude_change_meter?: number;
    zone_durations: WhoopZoneDurations;
  };
}

/** Webhook payload — same shape for all six event types. */
export interface WhoopWebhookPayload {
  user_id: number;
  id: string | number;
  type:
    | "recovery.updated"
    | "recovery.deleted"
    | "sleep.updated"
    | "sleep.deleted"
    | "workout.updated"
    | "workout.deleted";
  trace_id: string;
}
