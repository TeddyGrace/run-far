import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { weatherForecasts } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { dateYmdInZone } from "../lib/zonedTime.js";
import { getAthleteLocation } from "../lib/athleteLocation.js";
import { getAthleteTimezone } from "../lib/athleteTimezone.js";

export async function weatherRoutes(app: FastifyInstance) {
  // Pure read of the persisted forecast — kept fresh by generateRecommendations (dashboard
  // read, Whoop webhook, nightly sync), not refetched from NWS on every request. `configured`
  // tells the frontend whether an empty list means "no location set" vs. "no data yet".
  app.get("/api/weather/forecast", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { from, to } = request.query as { from?: string; to?: string };
    const tz = await getAthleteTimezone(userId);
    const today = dateYmdInZone(new Date(), tz);
    const fromYmd = from ?? today;
    const toYmd = to ?? dateYmdInZone(new Date(Date.now() + 7 * 86_400_000), tz);

    const [configured, forecasts] = await Promise.all([
      getAthleteLocation(userId).then((loc) => loc != null),
      db
        .select()
        .from(weatherForecasts)
        .where(
          and(eq(weatherForecasts.userId, userId), gte(weatherForecasts.date, fromYmd), lte(weatherForecasts.date, toYmd)),
        )
        .orderBy(asc(weatherForecasts.date)),
    ]);

    return { configured, forecasts };
  });
}
