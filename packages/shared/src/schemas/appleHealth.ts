import { z } from "zod";

/**
 * The contract between the iOS app and the API for Apple Health data.
 *
 * Apple Health is the one data source the server cannot go and fetch. HealthKit has no cloud
 * API — the data lives in the Health store on the device, readable only by an app running on
 * that device with the athlete's explicit per-type permission. So the direction of every other
 * integration is reversed here: instead of the server polling a provider and receiving
 * webhooks, the iOS app reads HealthKit and pushes, and this schema is what it pushes.
 *
 * Two consequences shape the design:
 *
 *   1. The server can never ask for a fresher copy. An Apple row is as fresh as the last time
 *      the app ran, which is why the ingest route is what recomputes everything derived from a
 *      batch, and why `coveredThrough` is part of the payload rather than something the server
 *      infers from arrival time.
 *   2. The device does the grouping the server can't. HealthKit stores sleep as a stream of
 *      per-stage category samples, not as nights, and a night's vitals as separate discrete
 *      samples; only the app can see the whole store and assemble sessions. So this schema is
 *      session-shaped, and the app is responsible for that assembly.
 *
 * Everything here is treated as untrusted input: the device is the athlete's, the payload is
 * whatever it sent, and the server re-derives every conclusion (nap vs primary sleep, cycles,
 * the recovery score) from it rather than accepting the device's own verdicts.
 */

/** Apple's own activity-type name for a workout, normalized by the iOS plugin from
 * HKWorkoutActivityType's numeric raw value. Left as a free string rather than an enum because
 * Apple adds activity types with OS releases, and an unknown one should land as an activity
 * with an unrecognized sport rather than fail the whole batch. */
export const appleWorkoutSchema = z.object({
  /** HKWorkout's UUID. Stable across syncs, which is what makes ingest idempotent. */
  externalId: z.string().min(1),
  /** e.g. "running", "cycling", "hiking", "functionalStrengthTraining". */
  activityType: z.string().min(1),
  /** HKMetadataKeyIndoorWorkout. Distinguishes a treadmill run from a road run — the one
   * distinction that changes how the workout is classified, since a treadmill run with no
   * distance is expected rather than a data gap. */
  indoor: z.boolean().default(false),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  /** HKWorkout.duration — the workout's own active duration, which excludes paused time and so
   * is not endedAt - startedAt. Sent separately for exactly that reason. */
  durationMin: z.number().nonnegative().nullable().default(null),
  distanceM: z.number().nonnegative().nullable().default(null),
  /** activeEnergyBurned, converted to kilojoules on the device so the server never has to
   * guess which energy unit it received. This is the additive load figure ACWR runs on. */
  activeEnergyKj: z.number().nonnegative().nullable().default(null),
  avgHr: z.number().positive().nullable().default(null),
  maxHr: z.number().positive().nullable().default(null),
  /** HKMetadataKeyElevationAscended. */
  elevationAscendedM: z.number().nullable().default(null),
});
export type AppleWorkout = z.infer<typeof appleWorkoutSchema>;

/**
 * One assembled sleep session, with the vitals Apple Watch measured during it.
 *
 * The nightly vitals are carried on the session rather than as their own samples because that
 * is the only relationship that matters to the engine: HRV and resting HR are interpreted as
 * "this morning's reading", and pairing them to a night on the device — where the full sample
 * stream is visible — is more reliable than the server trying to re-associate them by
 * timestamp.
 */
export const appleSleepSessionSchema = z.object({
  /** UUID of the sleep sample the app treats as the session's anchor. */
  externalId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  /** Total asleep minutes (core + deep + REM), excluding awake time. */
  asleepMin: z.number().nonnegative().nullable().default(null),
  /** Total in-bed minutes, when the athlete's setup records inBed at all. Many watch-only
   * sleepers have no inBed samples, which is why efficiency can be null. */
  inBedMin: z.number().nonnegative().nullable().default(null),
  lightMin: z.number().nonnegative().nullable().default(null),
  deepMin: z.number().nonnegative().nullable().default(null),
  remMin: z.number().nonnegative().nullable().default(null),
  awakeMin: z.number().nonnegative().nullable().default(null),
  /** heartRateVariabilitySDNN, in ms. SDNN, not RMSSD — see hrvMetricSchema. */
  hrvSdnnMs: z.number().positive().nullable().default(null),
  restingHr: z.number().positive().nullable().default(null),
  respiratoryRate: z.number().positive().nullable().default(null),
  oxygenSaturationPct: z.number().min(0).max(100).nullable().default(null),
  /** appleSleepingWristTemperature, in °C. Absolute value, not Apple's own deviation figure —
   * HealthKit does not expose the deviation, so run-far computes its own against the athlete's
   * baseline. */
  wristTempC: z.number().nullable().default(null),
});
export type AppleSleepSession = z.infer<typeof appleSleepSessionSchema>;

export const appleHealthDeviceSchema = z.object({
  /** Free-form, for diagnosing a bad sync — never used to make a decision. */
  model: z.string().max(120).optional(),
  osVersion: z.string().max(60).optional(),
  appVersion: z.string().max(60).optional(),
  /** IANA zone the device is in. Recorded but not authoritative: dates are bucketed in the
   * athlete's configured timezone, the same as every other provider, so a run logged abroad
   * lands on the same day here as it does everywhere else in the app. */
  timeZone: z.string().max(80).optional(),
});

export const appleHealthIngestSchema = z.object({
  device: appleHealthDeviceSchema.default({}),
  /**
   * The instant through which the app believes it has read the Health store completely.
   *
   * This becomes the athlete's Apple Health sync watermark, and the reconciliation sweep's
   * coverage gate reads it to decide whether an absence of workouts is evidence of an absence
   * of running. So it must mean "I have looked at everything up to here", not "here is when I
   * happened to run" — an app that sent `now` while only querying the last hour would claim
   * coverage over days it never examined, and the sweep would mark real sessions missed.
   *
   * Clamped server-side to not exceed the receiving time: a device with a skewed clock must not
   * be able to buy coverage over the future.
   */
  coveredThrough: z.string().datetime(),
  sleepSessions: z.array(appleSleepSessionSchema).max(400).default([]),
  workouts: z.array(appleWorkoutSchema).max(1000).default([]),
});
export type AppleHealthIngestInput = z.infer<typeof appleHealthIngestSchema>;

export const appleHealthIngestResultSchema = z.object({
  sleepSessions: z.number().int().nonnegative(),
  workouts: z.number().int().nonnegative(),
  cycles: z.number().int().nonnegative(),
  /** Recovery rows written, and how many of those got an actual score. A young account ingests
   * recovery rows that are deliberately unscored until enough baseline exists — reported so the
   * app can say "collecting baseline, N days to go" instead of showing an empty dashboard with
   * no explanation. */
  recoveryRows: z.number().int().nonnegative(),
  recoveryScored: z.number().int().nonnegative(),
  /** Days of baseline history available after this batch, and the minimum needed to score. */
  baselineDays: z.number().int().nonnegative(),
  baselineDaysRequired: z.number().int().nonnegative(),
  coveredThrough: z.string(),
});
export type AppleHealthIngestResult = z.infer<typeof appleHealthIngestResultSchema>;
