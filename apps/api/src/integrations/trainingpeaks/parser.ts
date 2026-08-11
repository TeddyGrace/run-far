import Papa from "papaparse";
import type { ImportPreviewRow, ImportRowWarning, RunType } from "@run-far/shared";
import { buildHeaderMap } from "./columnAliases.js";
import {
  parseDurationMinutes,
  parseDistanceMeters,
  parsePaceSecondsPerKm,
  classifyRunType,
} from "./normalize.js";

const VALID_RUN_TYPES: readonly RunType[] = [
  "easy",
  "tempo",
  "interval",
  "long",
  "recovery",
  "race",
  "rest",
];

export interface ParseResult {
  rows: ImportPreviewRow[];
  headerWarnings: string[];
}

/** Parses a TrainingPeaks-style CSV (raw file contents) into preview rows. Never throws on bad data — bad rows get warnings instead. */
export function parseTrainingPeaksCsv(csvContent: string, planStartDate?: string): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  const headers = parsed.meta.fields ?? [];
  const map = buildHeaderMap(headers);
  const headerWarnings: string[] = [];

  if (!map.date && !map.day) {
    headerWarnings.push(
      "No recognizable date or day-number column found — every row will need a manual date.",
    );
  }
  if (map.day && !planStartDate) {
    headerWarnings.push(
      "This file uses relative day numbers; provide a plan start date to compute actual dates.",
    );
  }

  const rows: ImportPreviewRow[] = parsed.data.map((record, index) => {
    const warnings: ImportRowWarning[] = [];

    let scheduledAt: string | null = null;
    if (map.date) {
      const raw = record[map.date];
      const d = raw ? new Date(raw) : null;
      if (d && !Number.isNaN(d.getTime())) {
        scheduledAt = d.toISOString();
      } else {
        warnings.push({ rowIndex: index, field: "date", message: `Unparseable date: "${raw}"` });
      }
    } else if (map.day && planStartDate) {
      const dayNum = Number(record[map.day]);
      if (Number.isFinite(dayNum)) {
        const base = new Date(planStartDate);
        base.setUTCDate(base.getUTCDate() + (dayNum - 1));
        scheduledAt = base.toISOString();
      } else {
        warnings.push({
          rowIndex: index,
          field: "day",
          message: `Unparseable day number: "${record[map.day]}"`,
        });
      }
    } else {
      warnings.push({ rowIndex: index, message: "No date could be determined for this row." });
    }

    const subtype = map.subtype ? record[map.subtype] : undefined;
    const sport = map.sport ? record[map.sport] : undefined;
    const title = map.title ? record[map.title] : undefined;
    const description = map.description ? record[map.description] : undefined;

    if (sport && !/run|walk/i.test(sport)) {
      warnings.push({
        rowIndex: index,
        field: "sport",
        message: `Sport "${sport}" is not a run — imported anyway, but review before committing.`,
      });
    }

    const classifiedRunType = classifyRunType(subtype, title, description);
    const runType: RunType = VALID_RUN_TYPES.includes(classifiedRunType as RunType)
      ? (classifiedRunType as RunType)
      : "easy";

    const durationMin = map.durationMinutes
      ? parseDurationMinutes(record[map.durationMinutes])
      : null;
    const distanceUnit = map.distanceUnit ? record[map.distanceUnit] : undefined;
    const distanceM = map.distance ? parseDistanceMeters(record[map.distance], distanceUnit) : null;
    const targetPaceSPerKm = map.targetPace
      ? parsePaceSecondsPerKm(record[map.targetPace], distanceUnit)
      : null;
    const plannedTss = map.tss ? Number(record[map.tss]) : null;

    if (durationMin == null && distanceM == null && runType !== "rest") {
      warnings.push({
        rowIndex: index,
        message: "Neither duration nor distance could be parsed for this run.",
      });
    }

    return {
      rowIndex: index,
      scheduledAt,
      runType,
      durationMin,
      distanceM,
      targetPaceSPerKm,
      plannedTss: plannedTss != null && Number.isFinite(plannedTss) ? plannedTss : null,
      description: description || title || null,
      warnings,
    };
  });

  return { rows, headerWarnings };
}
