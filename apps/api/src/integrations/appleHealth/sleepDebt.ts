/**
 * A rolling sleep-debt figure for Apple Health athletes.
 *
 * `sleep_records.sleep_debt_min` is read by the sleep-debt rule against a threshold in minutes
 * (`sleepDebtThresholdMin`, default 90). Whoop reports its own figure and the schema comment
 * warns, in capitals, never to re-aggregate it across days — because Whoop's number is already
 * cumulative. Apple reports nothing of the kind, so for Apple rows this file produces a figure
 * with the same contract: already cumulative, already rolling, never to be summed again.
 *
 * The model: each night's shortfall against need accrues, and older shortfalls decay. Decay is
 * the essential part — sleep debt is not a ledger that remembers a bad night in March. An
 * athlete who sleeps well for a week should be square, and a straight sum over a fixed window
 * would instead have them carrying a debt that steps off a cliff when the window slides past
 * the bad night.
 *
 * Surplus sleep pays debt down but does not bank credit: sleeping ten hours does not put you
 * ahead, it just clears what you owed. Allowing a negative debt would let a long weekend
 * mask a genuinely bad Tuesday.
 */

/** Per-day retention of accrued debt. At 0.7, roughly half a night's debt has decayed after two
 * nights and about 8% of it survives a week (0.7^7) — fast enough that the figure reflects the
 * recent past, slow enough that two consecutive short nights compound rather than each being
 * forgiven overnight. A judgement call, like everything else in this derivation. Note that
 * decay alone never quite reaches zero: a single catastrophic night leaves a small residue for
 * a couple of weeks, far below the rule's threshold, and a night above need clears it outright. */
const DAILY_RETENTION = 0.7;

/** Shortfalls smaller than this are treated as noise rather than debt. Sleep-stage durations
 * from a watch are estimates; treating an 8-minute miss as a real deficit would have the figure
 * jittering above zero on nights that were, for any practical purpose, fine. */
const NOISE_FLOOR_MIN = 15;

export interface NightForDebt {
  /** Athlete-local date of the waking that ended this sleep — the date the debt is filed under. */
  localDate: string;
  asleepMin: number | null;
  sleepNeedMin: number;
}

/**
 * Cumulative sleep debt as of each night, oldest first in, keyed by local date out.
 *
 * Takes the whole trailing series rather than one night because the answer for any night
 * depends on the ones before it — which is exactly why the result must not be re-aggregated
 * downstream. Nights must arrive oldest-first; callers pass the DB's own ordering.
 */
export function computeRollingSleepDebt(nights: NightForDebt[]): Map<string, number> {
  const out = new Map<string, number>();
  let carried = 0;

  for (const night of nights) {
    // A night with no duration recorded is not a night with no sleep. Carry the existing debt
    // forward with its decay applied and add nothing: an unworn watch must not manufacture an
    // 8-hour deficit, which would then propose cancelling the next day's session.
    if (night.asleepMin == null) {
      carried = carried * DAILY_RETENTION;
      out.set(night.localDate, round(carried));
      continue;
    }

    const shortfall = night.sleepNeedMin - night.asleepMin;
    const accrued = shortfall > NOISE_FLOOR_MIN ? shortfall : 0;
    // Surplus repays at face value: an hour over need clears an hour of debt.
    const repaid = shortfall < 0 ? -shortfall : 0;

    carried = Math.max(0, carried * DAILY_RETENTION + accrued - repaid);
    out.set(night.localDate, round(carried));
  }

  return out;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
