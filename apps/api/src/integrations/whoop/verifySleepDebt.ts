import "dotenv/config";
import { and, desc, eq } from "drizzle-orm";
import { db, pool } from "../../db/client.js";
import { users, sleepRecords } from "../../db/schema.js";
import { whoopGet } from "./client.js";
import type { WhoopSleep } from "./types.js";
import { getAthleteTimezone } from "../../lib/athleteTimezone.js";
import { dateYmdInZone } from "../../lib/zonedTime.js";

/**
 * Diagnostic: compare the stored sleep-debt for a user's most recent primary (non-nap) sleep
 * against Whoop's current live value for that same sleep. Confirms whether a stored row has gone
 * stale relative to Whoop (e.g. after a dropped sleep.updated webhook).
 *
 * Usage:  tsx src/integrations/whoop/verifySleepDebt.ts <email>
 */
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: tsx src/integrations/whoop/verifySleepDebt.ts <email>");
    process.exit(1);
  }

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    console.error(`no user found for email ${email}`);
    process.exit(1);
  }

  const tz = await getAthleteTimezone(user.id);
  const todayIso = dateYmdInZone(new Date(), tz);

  // Most recent primary sleep (nap = false); report which local date it belongs to.
  const [row] = await db
    .select()
    .from(sleepRecords)
    .where(and(eq(sleepRecords.userId, user.id), eq(sleepRecords.nap, false)))
    .orderBy(desc(sleepRecords.date), desc(sleepRecords.createdAt));

  if (!row) {
    console.error("no primary sleep records for this user");
    process.exit(1);
  }

  const live = await whoopGet<WhoopSleep>(user.id, `/v2/activity/sleep/${row.whoopSleepId}`);
  const liveDebtMin =
    live.score?.sleep_needed.need_from_sleep_debt_milli != null
      ? live.score.sleep_needed.need_from_sleep_debt_milli / 60_000
      : null;

  const fmt = (v: number | null) => (v == null ? "null" : `${v.toFixed(1)} min`);
  const delta = row.sleepDebtMin != null && liveDebtMin != null ? liveDebtMin - row.sleepDebtMin : null;

  console.log(`user:            ${email} (${user.id})`);
  console.log(`sleep date:      ${row.date}${row.date === todayIso ? " (today)" : ""}`);
  console.log(`whoop sleep id:  ${row.whoopSleepId}`);
  console.log(`row updatedAt:   ${row.updatedAt.toISOString()}`);
  console.log(`stored debt:     ${fmt(row.sleepDebtMin)}`);
  console.log(`live whoop debt: ${fmt(liveDebtMin)}`);
  console.log(`delta (live-stored): ${delta == null ? "n/a" : `${delta.toFixed(1)} min`}`);
  if (delta != null && Math.abs(delta) >= 1) {
    console.log("=> STALE: stored value differs from Whoop's current value.");
  } else {
    console.log("=> in sync.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
