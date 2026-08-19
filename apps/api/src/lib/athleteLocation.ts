import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

export interface AthleteLocation {
  lat: number;
  lon: number;
}

/** Resolves where to point NWS weather lookups: the per-user location set in Settings
 * (browser geolocation). Returns null when it isn't configured — callers should treat that
 * as "weather unavailable" and, in user-facing contexts, point the athlete at Settings to
 * set it. */
export async function getAthleteLocation(userId: string): Promise<AthleteLocation | null> {
  const [user] = await db
    .select({ locationLat: users.locationLat, locationLon: users.locationLon })
    .from(users)
    .where(eq(users.id, userId));

  if (user?.locationLat != null && user?.locationLon != null) {
    return { lat: user.locationLat, lon: user.locationLon };
  }
  return null;
}
