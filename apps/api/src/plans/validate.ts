import type { AiPlanDraft } from "@run-far/shared";

const DAY_MS = 86_400_000;
const HARD_TYPES = new Set(["tempo", "interval", "long", "race"]);

export interface PlanValidationInput {
  draft: AiPlanDraft;
  today: Date;
  startDate?: string; // YYYY-MM-DD, earliest allowed run
  raceDate?: string; // YYYY-MM-DD, latest allowed run (should hold the race)
  availableWeekdays?: number[]; // 0 Sun .. 6 Sat; if set, non-rest runs must fall on these
  maxWeeklyRampPct?: number; // default 0.15
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    runs: number;
    weeks: number;
    weeklyMeters: Array<{ weekStart: string; meters: number }>;
    firstDate: string | null;
    lastDate: string | null;
  };
}

function utcDay(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function mondayKey(d: Date): string {
  const day = d.getUTCDay();
  const monday = new Date(d.getTime() - ((day + 6) % 7) * DAY_MS);
  return isoDate(monday);
}

/**
 * Deterministic safety gate for AI-proposed plans. This does NOT build schedules — it rejects
 * ones that violate hard constraints so the model can revise them in the agent loop before
 * anything reaches the athlete's preview.
 */
export function validatePlanDraft(input: PlanValidationInput): PlanValidationResult {
  const { draft } = input;
  const errors: string[] = [];
  const warnings: string[] = [];
  const rampPct = input.maxWeeklyRampPct ?? 0.15;

  const start = input.startDate ? utcDay(input.startDate) : null;
  const race = input.raceDate ? utcDay(input.raceDate) : null;
  const today = new Date(
    Date.UTC(input.today.getUTCFullYear(), input.today.getUTCMonth(), input.today.getUTCDate()),
  );

  const parsed = draft.runs
    .map((r, i) => {
      const d = utcDay(r.scheduledAt);
      return d ? { i, date: d, run: r } : null;
    })
    .filter((x): x is { i: number; date: Date; run: AiPlanDraft["runs"][number] } => x !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (parsed.length !== draft.runs.length) {
    errors.push("One or more runs have an unparseable scheduledAt (expected ISO datetime).");
  }

  const firstDate = parsed[0]?.date ?? null;
  const lastDate = parsed[parsed.length - 1]?.date ?? null;

  // --- Bounds ---
  const lowerBound = start ?? today;
  for (const { date, run } of parsed) {
    if (date.getTime() < lowerBound.getTime()) {
      errors.push(`Run on ${isoDate(date)} (${run.runType}) is before the plan start (${isoDate(lowerBound)}).`);
      break;
    }
  }
  if (race) {
    for (const { date, run } of parsed) {
      if (date.getTime() > race.getTime()) {
        errors.push(`Run on ${isoDate(date)} (${run.runType}) is after race day (${isoDate(race)}).`);
        break;
      }
    }
    const hasRaceDay = parsed.some(
      ({ date, run }) => isoDate(date) === isoDate(race) && run.runType === "race",
    );
    if (!hasRaceDay) warnings.push(`No run of type "race" on race day ${isoDate(race)}.`);
  }

  // --- Available weekdays ---
  if (input.availableWeekdays && input.availableWeekdays.length > 0) {
    const allowed = new Set(input.availableWeekdays);
    for (const { date, run } of parsed) {
      if (run.runType === "rest") continue;
      if (!allowed.has(date.getUTCDay())) {
        warnings.push(`${run.runType} on ${isoDate(date)} falls outside the athlete's available days.`);
      }
    }
  }

  // --- Rest / easy after hard ---
  for (let i = 0; i < parsed.length - 1; i++) {
    const cur = parsed[i]!;
    const next = parsed[i + 1]!;
    const consecutive = next.date.getTime() - cur.date.getTime() === DAY_MS;
    if (consecutive && HARD_TYPES.has(cur.run.runType) && HARD_TYPES.has(next.run.runType)) {
      warnings.push(
        `Back-to-back hard days: ${cur.run.runType} (${isoDate(cur.date)}) then ${next.run.runType} (${isoDate(next.date)}).`,
      );
    }
  }

  // --- Weekly mileage ramp ---
  const weekMeters = new Map<string, number>();
  for (const { date, run } of parsed) {
    const key = mondayKey(date);
    weekMeters.set(key, (weekMeters.get(key) ?? 0) + (run.distanceM ?? 0));
  }
  const weeklyMeters = [...weekMeters.entries()]
    .map(([weekStart, meters]) => ({ weekStart, meters }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  for (let i = 1; i < weeklyMeters.length; i++) {
    const prev = weeklyMeters[i - 1]!.meters;
    const cur = weeklyMeters[i]!.meters;
    if (prev > 0 && cur > prev * (1 + rampPct)) {
      const jump = Math.round(((cur - prev) / prev) * 100);
      // A taper week naturally drops volume; only rising jumps are a concern.
      warnings.push(
        `Week of ${weeklyMeters[i]!.weekStart} jumps ${jump}% in distance vs the prior week (>${Math.round(rampPct * 100)}%).`,
      );
    }
  }

  // --- Taper before race ---
  if (race && weeklyMeters.length >= 3) {
    const raceWeek = weeklyMeters.find((w) => {
      const monday = utcDay(w.weekStart)!;
      const sunday = new Date(monday.getTime() + 6 * DAY_MS);
      return race.getTime() >= monday.getTime() && race.getTime() <= sunday.getTime();
    });
    if (raceWeek) {
      const idx = weeklyMeters.indexOf(raceWeek);
      const peak = Math.max(...weeklyMeters.slice(0, Math.max(idx, 1)).map((w) => w.meters));
      if (peak > 0 && raceWeek.meters > peak * 0.85) {
        warnings.push("Race-week volume is not tapered (should be well below peak).");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      runs: parsed.length,
      weeks: weeklyMeters.length,
      weeklyMeters,
      firstDate: firstDate ? isoDate(firstDate) : null,
      lastDate: lastDate ? isoDate(lastDate) : null,
    },
  };
}
