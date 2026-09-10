import { describe, expect, it } from "vitest";

import { matchWorkoutsToRuns, type MatchableRun, type MatchableWorkout } from "./match.js";

const TZ = "America/New_York";

function run(overrides: Partial<MatchableRun> & Pick<MatchableRun, "id" | "scheduledAt">): MatchableRun {
  return { runType: "easy", distanceM: 8000, durationMin: 45, ...overrides };
}

function workout(
  overrides: Partial<MatchableWorkout> & Pick<MatchableWorkout, "id" | "date">,
): MatchableWorkout {
  return {
    startedAt: null,
    sport: "running",
    distanceM: 8000,
    durationMin: 45,
    ...overrides,
  };
}

/** 2025-03-11 is an ordinary EDT day; -04:00 is New York's offset. */
const at = (local: string) => new Date(`${local}-04:00`);

describe("matchWorkoutsToRuns", () => {
  it("matches a run to the run-sport workout on the same athlete-local day", () => {
    const result = matchWorkoutsToRuns(
      [run({ id: "run-1", scheduledAt: at("2025-03-11T07:00:00") })],
      [workout({ id: "w-1", date: "2025-03-11", startedAt: at("2025-03-11T07:12:00") })],
      TZ,
    );

    expect(result.matches).toEqual([{ runId: "run-1", workoutId: "w-1", deltaMin: 12 }]);
    expect(result.unmatchedRunIds).toEqual([]);
    expect(result.unmatchedWorkoutIds).toEqual([]);
  });

  it("matches across the whole day, not a narrow window around the planned time", () => {
    // Planned for the morning, actually run after work. This is the single most common way a
    // real training day departs from the plan, and it must still count as done.
    const result = matchWorkoutsToRuns(
      [run({ id: "run-1", scheduledAt: at("2025-03-11T06:30:00") })],
      [workout({ id: "w-1", date: "2025-03-11", startedAt: at("2025-03-11T19:45:00") })],
      TZ,
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.workoutId).toBe("w-1");
  });

  it("does not match across a day boundary", () => {
    // Tuesday's session run on Wednesday is a real schedule change, not an execution of
    // Tuesday's plan — linking it would report perfect adherence for a week that drifted.
    const result = matchWorkoutsToRuns(
      [run({ id: "run-1", scheduledAt: at("2025-03-11T07:00:00") })],
      [workout({ id: "w-1", date: "2025-03-12", startedAt: at("2025-03-12T07:05:00") })],
      TZ,
    );

    expect(result.matches).toEqual([]);
    expect(result.unmatchedRunIds).toEqual(["run-1"]);
    expect(result.unmatchedWorkoutIds).toEqual(["w-1"]);
  });

  it("buckets the planned run into the athlete's day, not UTC's", () => {
    // 21:00 New York on the 11th is 01:00 UTC on the 12th. Bucketing in UTC would look for the
    // workout on the wrong calendar day and never find it — the same class of bug that
    // toLocalDateOnly fixes on the ingest side.
    const result = matchWorkoutsToRuns(
      [run({ id: "run-1", scheduledAt: at("2025-03-11T21:00:00") })],
      [workout({ id: "w-1", date: "2025-03-11", startedAt: at("2025-03-11T21:10:00") })],
      TZ,
    );

    expect(result.matches).toHaveLength(1);
  });

  it("ignores workouts that are not a run sport", () => {
    const result = matchWorkoutsToRuns(
      [run({ id: "run-1", scheduledAt: at("2025-03-11T07:00:00") })],
      [
        workout({ id: "lift", date: "2025-03-11", sport: "weightlifting", startedAt: at("2025-03-11T07:01:00") }),
        workout({ id: "w-1", date: "2025-03-11", startedAt: at("2025-03-11T09:00:00") }),
      ],
      TZ,
    );

    expect(result.matches).toEqual([{ runId: "run-1", workoutId: "w-1", deltaMin: 120 }]);
    // The lift is not a failed run match; it never enters the picture at all.
    expect(result.unmatchedWorkoutIds).toEqual([]);
  });

  it("never matches a rest day, and never reports one as unmatched", () => {
    const result = matchWorkoutsToRuns(
      [run({ id: "rest-1", scheduledAt: at("2025-03-11T07:00:00"), runType: "rest" })],
      [workout({ id: "w-1", date: "2025-03-11", startedAt: at("2025-03-11T07:00:00") })],
      TZ,
    );

    expect(result.matches).toEqual([]);
    expect(result.unmatchedRunIds).toEqual([]);
    expect(result.unmatchedWorkoutIds).toEqual(["w-1"]);
  });

  it("gives each of two runs on a double day its own workout, nearest first", () => {
    const result = matchWorkoutsToRuns(
      [
        run({ id: "am", scheduledAt: at("2025-03-11T06:00:00") }),
        run({ id: "pm", scheduledAt: at("2025-03-11T18:00:00") }),
      ],
      [
        workout({ id: "w-evening", date: "2025-03-11", startedAt: at("2025-03-11T18:20:00") }),
        workout({ id: "w-morning", date: "2025-03-11", startedAt: at("2025-03-11T06:10:00") }),
      ],
      TZ,
    );

    expect(result.matches).toEqual(
      expect.arrayContaining([
        { runId: "am", workoutId: "w-morning", deltaMin: 10 },
        { runId: "pm", workoutId: "w-evening", deltaMin: 20 },
      ]),
    );
    expect(result.matches).toHaveLength(2);
  });

  it("assigns one workout to at most one run", () => {
    // Two planned runs, one actually done. The nearer run owns it; the other is unmatched
    // rather than both reading as completed off the same session.
    const result = matchWorkoutsToRuns(
      [
        run({ id: "am", scheduledAt: at("2025-03-11T06:00:00") }),
        run({ id: "pm", scheduledAt: at("2025-03-11T18:00:00") }),
      ],
      [workout({ id: "w-1", date: "2025-03-11", startedAt: at("2025-03-11T17:30:00") })],
      TZ,
    );

    expect(result.matches).toEqual([{ runId: "pm", workoutId: "w-1", deltaMin: -30 }]);
    expect(result.unmatchedRunIds).toEqual(["am"]);
  });

  it("prefers a timed workout over an untimed one on the same day", () => {
    const result = matchWorkoutsToRuns(
      [run({ id: "run-1", scheduledAt: at("2025-03-11T07:00:00") })],
      [
        workout({ id: "w-untimed", date: "2025-03-11", startedAt: null }),
        workout({ id: "w-timed", date: "2025-03-11", startedAt: at("2025-03-11T15:00:00") }),
      ],
      TZ,
    );

    // 8 hours off still beats an unknown start: the timed one is evidence, the untimed one is
    // only a date.
    expect(result.matches[0]?.workoutId).toBe("w-timed");
  });

  it("still matches an untimed workout when it is the only candidate", () => {
    const result = matchWorkoutsToRuns(
      [run({ id: "run-1", scheduledAt: at("2025-03-11T07:00:00") })],
      [workout({ id: "w-1", date: "2025-03-11", startedAt: null })],
      TZ,
    );

    expect(result.matches).toEqual([{ runId: "run-1", workoutId: "w-1", deltaMin: null }]);
  });

  it("is a function of its inputs, not of row order", () => {
    // Two workouts equidistant from the planned time. Whichever wins, it must be the same
    // winner whatever order the database returned them in.
    const runs = [run({ id: "run-1", scheduledAt: at("2025-03-11T12:00:00") })];
    const a = workout({ id: "w-a", date: "2025-03-11", startedAt: at("2025-03-11T11:30:00") });
    const b = workout({ id: "w-b", date: "2025-03-11", startedAt: at("2025-03-11T12:30:00") });

    const forward = matchWorkoutsToRuns(runs, [a, b], TZ);
    const reversed = matchWorkoutsToRuns(runs, [b, a], TZ);

    expect(forward.matches).toEqual(reversed.matches);
  });

  it("returns empty results rather than throwing when there is nothing to match", () => {
    expect(matchWorkoutsToRuns([], [], TZ)).toEqual({
      matches: [],
      unmatchedRunIds: [],
      unmatchedWorkoutIds: [],
    });
  });
});
