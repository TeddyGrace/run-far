import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

const { classifySleeps, synthesizeCycles } = await import("./cycles.js");

const TZ = "America/New_York";

/**
 * Apple Health has no physiological-cycle concept, but everything downstream is written against
 * one: the snapshot resolves "today" by looking up the current cycle, and the strain/load
 * windows and ACWR count completed cycles. These tests cover the synthesis that lets all of
 * that stay provider-agnostic.
 */

function sleep(id: string, start: string, end: string, asleepMin: number | null = 460) {
  return { externalId: id, startedAt: new Date(start), endedAt: new Date(end), asleepMin };
}

describe("classifySleeps", () => {
  it("treats the longest session of a local day as the night and the rest as naps", () => {
    // Apple records a 25-minute doze and an 8-hour night with the same sample types. The
    // snapshot looks up the *primary* sleep for the current cycle, so a nap standing in for it
    // would report a 25-minute night and a wildly wrong sleep debt.
    const classified = classifySleeps(
      [
        sleep("night", "2026-09-11T03:00:00Z", "2026-09-11T11:00:00Z", 460),
        sleep("nap", "2026-09-11T18:00:00Z", "2026-09-11T18:25:00Z", 25),
      ],
      TZ,
    );
    expect(classified.find((c) => c.externalId === "night")?.nap).toBe(false);
    expect(classified.find((c) => c.externalId === "nap")?.nap).toBe(true);
  });

  it("leaves a nap-only day with no primary sleep rather than promoting the nap", () => {
    // An athlete who only napped did not have a night. Promoting the nap would have the engine
    // reading a 40-minute sleep as that day's night — a fabricated catastrophic sleep debt.
    const classified = classifySleeps(
      [sleep("doze", "2026-09-11T18:00:00Z", "2026-09-11T18:40:00Z", 40)],
      TZ,
    );
    expect(classified[0]?.nap).toBe(true);
  });

  it("buckets a session by the waking, not the falling asleep", () => {
    // The night of the 10th that ends on the morning of the 11th is the 11th's sleep: it is
    // what the 11th's recovery is scored from.
    const classified = classifySleeps(
      [sleep("overnight", "2026-09-11T02:30:00Z", "2026-09-11T10:30:00Z", 470)],
      TZ,
    );
    // 02:30Z is 22:30 on the 10th in New York; 10:30Z is 06:30 on the 11th.
    expect(classified[0]?.wakeLocalDate).toBe("2026-09-11");
  });

  it("falls back to the wall-clock span when the device sent no asleep total", () => {
    const classified = classifySleeps(
      [sleep("night", "2026-09-11T03:00:00Z", "2026-09-11T11:00:00Z", null)],
      TZ,
    );
    expect(classified[0]?.nap).toBe(false);
  });
});

describe("synthesizeCycles", () => {
  function primary(id: string, wakeIso: string, wakeLocalDate: string) {
    return {
      externalId: id,
      startedAt: new Date(wakeIso),
      endedAt: new Date(wakeIso),
      asleepMin: 460,
      wakeLocalDate,
    };
  }

  it("runs each cycle from one waking to the next", () => {
    const cycles = synthesizeCycles(
      [
        primary("s1", "2026-09-10T11:00:00Z", "2026-09-10"),
        primary("s2", "2026-09-11T11:00:00Z", "2026-09-11"),
        primary("s3", "2026-09-12T11:00:00Z", "2026-09-12"),
      ],
      [],
      TZ,
    );
    expect(cycles).toHaveLength(3);
    expect(cycles[0]?.end?.toISOString()).toBe("2026-09-11T11:00:00.000Z");
    expect(cycles[1]?.start.toISOString()).toBe("2026-09-11T11:00:00.000Z");
  });

  it("leaves the most recent cycle open", () => {
    // An open cycle's totals are still accumulating; giving it an end would let a partial,
    // necessarily-low energy figure into the completed-cycle windows as a spurious rest day.
    const cycles = synthesizeCycles(
      [primary("s1", "2026-09-11T11:00:00Z", "2026-09-11"), primary("s2", "2026-09-12T11:00:00Z", "2026-09-12")],
      [],
      TZ,
    );
    expect(cycles[0]?.end).not.toBeNull();
    expect(cycles[1]?.end).toBeNull();
  });

  it("gives a cycle a deterministic id so re-ingesting doesn't duplicate it", () => {
    const args = [primary("s1", "2026-09-11T11:00:00Z", "2026-09-11")] as const;
    const first = synthesizeCycles([...args], [], TZ);
    const second = synthesizeCycles([...args], [], TZ);
    expect(first[0]?.externalId).toBe(second[0]?.externalId);
    expect(first[0]?.externalId).toBe("wake-2026-09-11");
  });

  it("sums active energy from workouts inside the cycle only", () => {
    // This is the figure ACWR runs on for Apple athletes: cycleLoad prefers kilojoules, so an
    // Apple cycle never touches the Whoop-calibrated strain approximation.
    const cycles = synthesizeCycles(
      [primary("s1", "2026-09-11T11:00:00Z", "2026-09-11"), primary("s2", "2026-09-12T11:00:00Z", "2026-09-12")],
      [
        { startedAt: new Date("2026-09-11T13:00:00Z"), activeEnergyKj: 2000 },
        { startedAt: new Date("2026-09-11T23:00:00Z"), activeEnergyKj: 500 },
        // After the next waking: belongs to the following cycle, not this one.
        { startedAt: new Date("2026-09-12T14:00:00Z"), activeEnergyKj: 9999 },
        // Before the first waking: outside every cycle here.
        { startedAt: new Date("2026-09-10T14:00:00Z"), activeEnergyKj: 777 },
      ],
      TZ,
    );
    expect(cycles[0]?.kilojoule).toBe(2500);
    expect(cycles[1]?.kilojoule).toBe(9999);
  });

  it("reports null rather than zero energy for a cycle with no data", () => {
    // "No data" and "a rest day" are different claims, and only the second should pull a load
    // average down. A 0 here would quietly depress ACWR's chronic baseline.
    const cycles = synthesizeCycles([primary("s1", "2026-09-11T11:00:00Z", "2026-09-11")], [], TZ);
    expect(cycles[0]?.kilojoule).toBeNull();
  });

  it("distinguishes a genuine rest day from a missing one", () => {
    const cycles = synthesizeCycles(
      [primary("s1", "2026-09-11T11:00:00Z", "2026-09-11"), primary("s2", "2026-09-12T11:00:00Z", "2026-09-12")],
      // A walk with a real (small) energy figure inside the first cycle: rest, but observed.
      [{ startedAt: new Date("2026-09-11T15:00:00Z"), activeEnergyKj: 120 }],
      TZ,
    );
    expect(cycles[0]?.kilojoule).toBe(120);
    expect(cycles[1]?.kilojoule).toBeNull();
  });

  it("orders cycles by waking regardless of the order data arrived in", () => {
    const cycles = synthesizeCycles(
      [
        primary("s3", "2026-09-12T11:00:00Z", "2026-09-12"),
        primary("s1", "2026-09-10T11:00:00Z", "2026-09-10"),
        primary("s2", "2026-09-11T11:00:00Z", "2026-09-11"),
      ],
      [],
      TZ,
    );
    expect(cycles.map((c) => c.externalId)).toEqual([
      "wake-2026-09-10",
      "wake-2026-09-11",
      "wake-2026-09-12",
    ]);
  });

  it("never emits two cycles with the same id", () => {
    // classifySleeps makes one primary per local date, so this can't arise from it — but the
    // output feeds an upsert keyed on that id, and a duplicate would silently overwrite.
    const cycles = synthesizeCycles(
      [
        primary("s1", "2026-09-11T09:00:00Z", "2026-09-11"),
        primary("s2", "2026-09-11T13:00:00Z", "2026-09-11"),
      ],
      [],
      TZ,
    );
    expect(cycles).toHaveLength(1);
  });
});
