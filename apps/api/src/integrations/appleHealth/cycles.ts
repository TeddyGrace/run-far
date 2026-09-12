import { dateYmdInZone } from "../../lib/zonedTime.js";

/**
 * Synthesizing physiological cycles from Apple Health sleep.
 *
 * A cycle is the unit everything downstream is written against: `buildRecoverySnapshot` resolves
 * "today" by looking up the current cycle rather than matching a calendar date, the strain/load
 * windows and ACWR count completed cycles, and recovery/sleep rows are keyed to one. That design
 * exists because a calendar day is the wrong bucket for physiology — a cycle is wake-to-wake, can
 * cross midnight, and a single calendar day can hold both a nap and a main sleep.
 *
 * Whoop provides cycles directly. Apple has no such concept: HealthKit has sleep samples and
 * nothing else. The options were to branch every downstream consumer on provider, or to derive
 * the same concept from the data Apple does give. This is the second, and it is the reason the
 * snapshot, the rules, the digest and the assistant needed no per-provider branching at all.
 *
 * The derivation: a cycle begins when the athlete wakes from a primary sleep and ends when they
 * wake from the next one. That matches Whoop's own definition, and it puts the night's recovery
 * readings at the *start* of the cycle they inform — which is what makes "today's recovery"
 * resolve to this morning's reading rather than last night's.
 */

export interface SleepForCycles {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  asleepMin: number | null;
}

export interface WorkoutEnergy {
  startedAt: Date;
  activeEnergyKj: number | null;
}

export interface SynthesizedCycle {
  /** Deterministic: "wake-<athlete-local date of the waking that starts it>". Deterministic is
   * the requirement, not the format — re-ingesting the same nights must re-derive the same id
   * so the upsert updates the cycle instead of accumulating duplicates of it. */
  externalId: string;
  start: Date;
  /** Null while the cycle is still open — i.e. the most recent one, which the athlete is living
   * in. Downstream this is load-bearing: an open cycle is excluded from the strain/load windows
   * because its totals are still accumulating (see cycleStrainAndLoad). */
  end: Date | null;
  /** Athlete-local date of `start`, the date the cycle's recovery row is filed under. */
  localDate: string;
  /** The primary sleep whose waking opens this cycle — the night the cycle's recovery describes. */
  sleepExternalId: string;
  /** Sum of active energy from workouts started inside the cycle, in kJ. This is what carries
   * ACWR for Apple athletes: `cycleLoad` prefers kilojoules, so an Apple cycle takes that branch
   * and never touches the Whoop-calibrated strain approximation. Null when the cycle contains no
   * workout with an energy figure — null rather than 0, because "no data" and "a rest day" are
   * different claims and only the second one should pull a load average down. */
  kilojoule: number | null;
}

/**
 * Which sleep sessions are primary sleeps, and which are naps.
 *
 * Apple has no nap flag — HealthKit records a 25-minute afternoon doze and an 8-hour night with
 * the same sample types. The distinction still has to be made, because the snapshot looks up the
 * primary sleep for the current cycle and a nap standing in for it would report a 25-minute
 * night's sleep and a wildly wrong sleep debt.
 *
 * The rule: within each athlete-local day, the longest session is the primary sleep and any
 * others are naps; and a session must clear a minimum duration to be primary at all. The second
 * clause is what stops a day on which the athlete only napped from promoting that nap to the
 * night — it leaves the day with no primary sleep, which is the truth of it.
 *
 * Sessions are bucketed by their *end* (waking), not their start: the night of the 5th that ends
 * on the morning of the 6th is the 6th's primary sleep, since it is the sleep the 6th's recovery
 * is scored from.
 */
const MIN_PRIMARY_SLEEP_MIN = 3 * 60;

export function classifySleeps(
  sleeps: SleepForCycles[],
  timeZone: string,
): Array<SleepForCycles & { nap: boolean; wakeLocalDate: string }> {
  const annotated = sleeps.map((s) => ({
    ...s,
    wakeLocalDate: dateYmdInZone(s.endedAt, timeZone),
    // Fall back to wall-clock span when the device sent no asleep total: a session with no
    // duration at all can't be compared against the primary-sleep floor otherwise.
    durationMin: s.asleepMin ?? (s.endedAt.getTime() - s.startedAt.getTime()) / 60_000,
  }));

  const longestByDate = new Map<string, { id: string; durationMin: number }>();
  for (const s of annotated) {
    if (s.durationMin < MIN_PRIMARY_SLEEP_MIN) continue;
    const current = longestByDate.get(s.wakeLocalDate);
    // Ties broken by the earlier-inserted session, deterministically, so a re-ingest of the
    // same two equal-length sessions doesn't flip which one is primary.
    if (!current || s.durationMin > current.durationMin) {
      longestByDate.set(s.wakeLocalDate, { id: s.externalId, durationMin: s.durationMin });
    }
  }

  return annotated.map(({ durationMin: _durationMin, ...s }) => ({
    ...s,
    nap: longestByDate.get(s.wakeLocalDate)?.id !== s.externalId,
  }));
}

/**
 * Build cycles from classified sleeps.
 *
 * `now` bounds the open cycle rather than being its end: the most recent cycle is genuinely
 * still running, and giving it an end would let its partial, necessarily-low energy total into
 * the completed-cycle windows as a spurious rest day.
 */
export function synthesizeCycles(
  primarySleeps: Array<SleepForCycles & { wakeLocalDate: string }>,
  workouts: WorkoutEnergy[],
  timeZone: string,
): SynthesizedCycle[] {
  const ordered = [...primarySleeps].sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());

  const cycles: SynthesizedCycle[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const sleep = ordered[i]!;
    const next = ordered[i + 1];
    const start = sleep.endedAt;
    const end = next ? next.endedAt : null;

    const kilojoule = sumEnergyInWindow(workouts, start, end);

    cycles.push({
      externalId: `wake-${dateYmdInZone(start, timeZone)}`,
      start,
      end,
      localDate: dateYmdInZone(start, timeZone),
      sleepExternalId: sleep.externalId,
      kilojoule,
    });
  }

  // Two primary sleeps ending on the same local date would produce two cycles with the same
  // synthetic id. classifySleeps makes that impossible by construction (one primary per local
  // date), but the invariant is worth holding here too: this function's output feeds an upsert
  // keyed on that id, and a duplicate would have the second silently overwrite the first.
  const seen = new Set<string>();
  return cycles.filter((c) => {
    if (seen.has(c.externalId)) return false;
    seen.add(c.externalId);
    return true;
  });
}

/** Active energy from workouts starting in [start, end). Null when no workout in the window
 * reported energy — see SynthesizedCycle.kilojoule for why that isn't 0. */
function sumEnergyInWindow(workouts: WorkoutEnergy[], start: Date, end: Date | null): number | null {
  let total = 0;
  let sawEnergy = false;
  for (const w of workouts) {
    const t = w.startedAt.getTime();
    if (t < start.getTime()) continue;
    if (end && t >= end.getTime()) continue;
    if (w.activeEnergyKj == null) continue;
    total += w.activeEnergyKj;
    sawEnergy = true;
  }
  return sawEnergy ? total : null;
}
