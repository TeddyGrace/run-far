import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { env } from "../env.js";
import { dateYmdInZone } from "./zonedTime.js";

function isValidTimeZone(tz: string): boolean {
  try {
    dateYmdInZone(new Date(), tz);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the IANA zone to bucket dates in for this user: the zone captured from the
 * browser at login (see users.timezone), falling back to env.ATHLETE_TIMEZONE for users who
 * haven't logged in since that capture was added. Unlike getAthleteLocation this never
 * returns null — every caller needs some zone to compute "today" in. */
export async function getAthleteTimezone(userId: string): Promise<string> {
  const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId));

  if (user?.timezone && isValidTimeZone(user.timezone)) {
    return user.timezone;
  }
  return env.ATHLETE_TIMEZONE;
}
