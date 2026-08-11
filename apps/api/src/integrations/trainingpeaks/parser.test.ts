import { describe, it, expect } from "vitest";
import { parseTrainingPeaksCsv } from "./parser.js";

describe("parseTrainingPeaksCsv", () => {
  it("parses an absolute-date export with standard headers", () => {
    const csv = [
      "Date,WorkoutType,Title,PlannedDuration,PlannedDistance,PlannedTSS,Description",
      "2026-08-12,Run,Tempo Run,0:50:00,10,65,3x2km at threshold",
      "2026-08-13,Run,Easy Run,0:35:00,6,30,Easy aerobic",
    ].join("\n");

    const { rows, headerWarnings } = parseTrainingPeaksCsv(csv);
    expect(headerWarnings).toEqual([]);
    expect(rows).toHaveLength(2);

    expect(rows[0]?.runType).toBe("tempo");
    expect(rows[0]?.durationMin).toBe(50);
    expect(rows[0]?.distanceM).toBe(10000); // 10, no unit column -> defaults to km per normalize.ts heuristic
    expect(rows[0]?.plannedTss).toBe(65);
    expect(rows[0]?.warnings).toEqual([]);

    expect(rows[1]?.runType).toBe("easy");
  });

  it("parses a relative-day plan-import format given a plan start date", () => {
    const csv = [
      "day,sport,subtype,title,duration_minutes,tss,description,phase",
      "1,Run,Interval,VO2 max repeats,55,70,6x800m,Build",
      "2,Run,Recovery,Recovery jog,30,20,Easy shakeout,Build",
    ].join("\n");

    const { rows, headerWarnings } = parseTrainingPeaksCsv(csv, "2026-09-01");
    expect(headerWarnings).toEqual([]);
    expect(rows[0]?.scheduledAt).toBe(new Date("2026-09-01").toISOString());
    expect(rows[1]?.scheduledAt).toBe(new Date("2026-09-02").toISOString());
    expect(rows[0]?.runType).toBe("interval");
    expect(rows[1]?.runType).toBe("recovery");
  });

  it("warns instead of throwing when the day column has no plan start date", () => {
    const csv = ["day,sport,title,duration_minutes", "1,Run,Easy,30"].join("\n");
    const { rows, headerWarnings } = parseTrainingPeaksCsv(csv);
    expect(headerWarnings.some((w) => w.includes("plan start date"))).toBe(true);
    expect(rows[0]?.scheduledAt).toBeNull();
  });

  it("flags rows with unparseable dates instead of throwing", () => {
    const csv = ["Date,Title,PlannedDuration", "not-a-date,Broken Row,30"].join("\n");
    const { rows } = parseTrainingPeaksCsv(csv);
    expect(rows[0]?.scheduledAt).toBeNull();
    expect(rows[0]?.warnings.some((w) => w.field === "date")).toBe(true);
  });

  it("flags rows missing both duration and distance", () => {
    const csv = ["Date,Title", "2026-08-12,Mystery workout"].join("\n");
    const { rows } = parseTrainingPeaksCsv(csv);
    expect(rows[0]?.warnings.some((w) => w.message.includes("Neither duration nor distance"))).toBe(
      true,
    );
  });

  it("warns when no date or day column exists at all", () => {
    const csv = ["Title,PlannedDuration", "Mystery,30"].join("\n");
    const { headerWarnings } = parseTrainingPeaksCsv(csv);
    expect(headerWarnings.some((w) => w.includes("No recognizable date"))).toBe(true);
  });

  it("handles an empty file without throwing", () => {
    const { rows } = parseTrainingPeaksCsv("Date,Title\n");
    expect(rows).toEqual([]);
  });
});
