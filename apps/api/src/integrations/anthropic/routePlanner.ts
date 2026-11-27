import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { GenerateRouteResult, GeneratedRoute, LatLon, PlannedRoute } from "@run-far/shared";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { logger } from "../../lib/logger.js";
import { AiUsageAccumulator } from "../../lib/aiCost.js";
import {
  PLACE_KINDS,
  RoutingError,
  findNearbyPlaces,
  routeOfDistance,
  routeThrough,
  type LoopShape,
} from "../routing/routingClient.js";
import { bearingDeg, compassPoint, haversineM } from "../routing/geo.js";

const METERS_PER_MILE = 1609.344;
// Route planning is a short, bounded search (look around, try a few shapes, pick one); far
// fewer round trips than the assistant needs. Still only a runaway backstop.
const MAX_TOOL_ITERATIONS = 12;
const MAX_ROUTE_MILES = 40;

export function isAnthropicConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

const SYSTEM_PROMPT = `You are run-far's route planner. The athlete is standing at a start point and has described the run
they want. Build them one concrete running route that starts (and, unless they say otherwise, ends) at the start point.

You cannot see a map. Work only from tool results:
- find_nearby_places lists named parks, water, trails, running tracks and landmarks around the start, with distance and
  compass direction. Use it whenever the request mentions scenery or surface (parks, trails, water, "quiet", "scenic"),
  or to pick a sensible direction for an otherwise unconstrained run.
- build_route_of_distance builds a loop or out-and-back of a target distance heading in a compass direction. It is the
  reliable way to hit a distance. Prefer it when the athlete mainly cares about distance.
- build_route_through snaps a run through specific points (e.g. the start, a park, back to start) and reports the
  real distance. Use it to route via places found with find_nearby_places.
- present_route hands one built route to the athlete. Call it exactly once, with your best route, then stop.

Rules:
- Every route you build is snapped to real paths; trust the distances the tools report, never estimate your own.
- Aim within about 10% of a requested distance. If a via-places route comes out too long or short, try adjusting
  (drop a point, pick a nearer/farther place, or fall back to build_route_of_distance in that place's direction).
- If no distance is given, pick something reasonable for the request (default 3 miles) and say so.
- Built routes report climb_feet (total ascent) when elevation data is available. Use it for requests about
  flat or hilly runs: compare a few directions and pick the one that best fits. As a guide, under ~30 ft of climb
  per mile is flat and over ~100 ft per mile is hilly. If climb_feet is null, elevation is unavailable: say so
  plainly rather than claiming a route is flat or hilly.
- You know nothing about safety, lighting, traffic, or surface beyond what tools return. Don't invent it.
- Speak to the athlete in miles. Keep the summary to 2-3 short sentences: the shape, what it passes, the distance.
- Name routes briefly (e.g. "Riverside 5-miler").`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "find_nearby_places",
    description:
      "List named runnable features near the start: parks, water (lakes/rivers/beaches), trails (named paths and hiking routes), running tracks, landmarks. Returns name, kind, lat/lon, distance in miles and compass direction from the start.",
    input_schema: {
      type: "object",
      properties: {
        kinds: { type: "array", items: { type: "string", enum: PLACE_KINDS }, description: "Which kinds to look for. Omit for all." },
        radius_miles: { type: "number", description: "Search radius in miles (max 12). Roughly half the planned run distance is a good default." },
      },
      required: ["radius_miles"],
    },
  },
  {
    name: "build_route_of_distance",
    description:
      "Build a route of roughly target_miles from the start, heading out in direction_degrees (0=N, 90=E, 180=S, 270=W). shape 'loop' returns to the start by a different way; 'out_and_back' runs out and retraces. Returns a route_id and the snapped distance.",
    input_schema: {
      type: "object",
      properties: {
        target_miles: { type: "number" },
        direction_degrees: { type: "number" },
        shape: { type: "string", enum: ["loop", "out_and_back"] },
      },
      required: ["target_miles", "direction_degrees", "shape"],
    },
  },
  {
    name: "build_route_through",
    description:
      "Snap a run through the given points in order, starting at the start point. Set return_to_start to finish back at the start. Returns a route_id and the snapped distance.",
    input_schema: {
      type: "object",
      properties: {
        points: {
          type: "array",
          items: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
          description: "Intermediate points (not including the start), max 8.",
        },
        return_to_start: { type: "boolean" },
      },
      required: ["points", "return_to_start"],
    },
  },
  {
    name: "present_route",
    description: "Present one built route to the athlete. Call once, at the end.",
    input_schema: {
      type: "object",
      properties: {
        route_id: { type: "string" },
        name: { type: "string" },
        summary: { type: "string", description: "2-3 sentences for the athlete, in miles." },
      },
      required: ["route_id", "name", "summary"],
    },
  },
];

const miles = (m: number) => Math.round((m / METERS_PER_MILE) * 100) / 100;

interface ToolState {
  start: LatLon;
  routes: Map<string, PlannedRoute>;
  presented: GeneratedRoute | null;
}

/** What the athlete sees while a tool runs — the planner can take a while, and a bare spinner
 * for 30 seconds reads as broken. */
export function progressMessage(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case "find_nearby_places": {
      const kinds = Array.isArray(input.kinds) && input.kinds.length ? input.kinds.map(String) : null;
      const label = kinds ? kinds.map((k) => (k === "water" ? "water" : `${k}s`)).join(", ") : "parks, trails and water";
      return `Looking for ${label} nearby…`;
    }
    case "build_route_of_distance": {
      const mi = Number(input.target_miles);
      const shape = input.shape === "out_and_back" ? "out-and-back" : "loop";
      const deg = Number(input.direction_degrees);
      const dir = Number.isFinite(deg) ? ` heading ${compassPoint(((deg % 360) + 360) % 360)}` : "";
      return Number.isFinite(mi) ? `Trying a ${mi}-mile ${shape}${dir}…` : `Trying a ${shape}…`;
    }
    case "build_route_through":
      return "Routing through the places it picked…";
    case "present_route":
      return "Finishing up…";
    default:
      return null;
  }
}

export interface RoutePlannerDeps {
  /** Injected in tests; defaults to a real client. Only `messages.create` is used. */
  client?: Pick<Anthropic, "messages">;
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => void;
}

/** A compact, model-readable description of a built route — never the full polyline. */
function describe(id: string, route: PlannedRoute, start: LatLon) {
  let farthest = route.geometry[0]!;
  let farthestM = 0;
  for (const p of route.geometry) {
    const d = haversineM(start, p);
    if (d > farthestM) {
      farthestM = d;
      farthest = p;
    }
  }
  const end = route.geometry[route.geometry.length - 1]!;
  return {
    route_id: id,
    distance_miles: miles(route.distanceM),
    farthest_point: { miles_from_start: miles(farthestM), direction: compassPoint(bearingDeg(start, farthest)) },
    ends_at_start: haversineM(start, end) < 150,
    climb_feet: route.elevationGainM == null ? null : Math.round(route.elevationGainM / 0.3048),
  };
}

export async function executeRouteTool(
  name: string,
  input: Record<string, unknown>,
  state: ToolState,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const addRoute = (route: PlannedRoute) => {
    const id = `r${state.routes.size + 1}`;
    state.routes.set(id, route);
    return describe(id, route, state.start);
  };

  switch (name) {
    case "find_nearby_places": {
      const radiusMiles = Math.min(12, Math.max(0.25, Number(input.radius_miles) || 2));
      const kinds = Array.isArray(input.kinds) ? input.kinds.map(String) : [];
      const places = await findNearbyPlaces({ center: state.start, radiusM: radiusMiles * METERS_PER_MILE, kinds }, fetchImpl);
      return places.length ? { places } : { places, note: "Nothing named found in that radius; try a wider radius or other kinds." };
    }
    case "build_route_of_distance": {
      const target = Number(input.target_miles);
      if (!(target > 0 && target <= MAX_ROUTE_MILES)) return { error: `target_miles must be between 0 and ${MAX_ROUTE_MILES}` };
      const shape: LoopShape = input.shape === "out_and_back" ? "out_and_back" : "loop";
      const bearing = ((Number(input.direction_degrees) || 0) % 360 + 360) % 360;
      return addRoute(await routeOfDistance({ start: state.start, targetM: target * METERS_PER_MILE, bearing, shape }, fetchImpl));
    }
    case "build_route_through": {
      const raw = Array.isArray(input.points) ? input.points : [];
      const points = raw
        .slice(0, 8)
        .map((p) => p as { lat?: unknown; lon?: unknown })
        .filter((p) => typeof p.lat === "number" && typeof p.lon === "number")
        .map((p) => [p.lat as number, p.lon as number] as LatLon);
      if (!points.length) return { error: "Provide at least one point with numeric lat and lon." };
      const tooFar = points.find((p) => haversineM(state.start, p) > 25 * METERS_PER_MILE);
      if (tooFar) return { error: "A point is more than 25 miles from the start; pick nearer points." };
      const waypoints = [state.start, ...points, ...(input.return_to_start ? [state.start] : [])];
      return addRoute(await routeThrough(waypoints, fetchImpl));
    }
    case "present_route": {
      const route = state.routes.get(String(input.route_id));
      if (!route) return { error: `Unknown route_id. Built so far: ${[...state.routes.keys()].join(", ") || "none"}` };
      state.presented = {
        ...route,
        name: String(input.name || "Planned run").slice(0, 120),
        summary: String(input.summary || "").slice(0, 2_000),
      };
      return { ok: true };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

/** One planning request: the athlete's prompt in, at most one snapped route out. */
export async function planRouteWithAi(
  params: { userId: string; start: LatLon; prompt: string },
  deps: RoutePlannerDeps = {},
): Promise<GenerateRouteResult> {
  if (!deps.client && !isAnthropicConfigured()) throw new Error("AI_NOT_CONFIGURED");

  const client = deps.client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const progress = deps.onProgress ?? (() => {});
  const [user] = await db.select({ role: users.role, planModel: users.planModel }).from(users).where(eq(users.id, params.userId));
  // Same model selection as the plan builder: admins may override, everyone else gets the default.
  const model = (user?.role === "admin" && user.planModel) || env.ANTHROPIC_MODEL;
  const usage = new AiUsageAccumulator();
  const state: ToolState = { start: params.start, routes: new Map(), presented: null };

  // The athlete's text goes in a user turn, never the system prompt, so it can only ever ask
  // for a route — it can't rewrite the planner's rules.
  const conversation: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Start point: ${params.start[0].toFixed(5)}, ${params.start[1].toFixed(5)}\n\nWhat I want:\n${params.prompt}`,
    },
  ];
  let message = "";
  progress("Reading your request…");

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS && !state.presented; i++) {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: conversation,
      });
      usage.add(response.usage);

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      if (text) message = text;

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) break;

      // Independent lookups the model fires in parallel run in parallel; results go back in one message.
      const results = await Promise.all(
        toolUses.map(async (block): Promise<Anthropic.ToolResultBlockParam> => {
          const input = (block.input as Record<string, unknown>) ?? {};
          const note = progressMessage(block.name, input);
          if (note) progress(note);
          try {
            const out = await executeRouteTool(block.name, input, state, fetchImpl);
            return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) };
          } catch (err) {
            const msg = err instanceof RoutingError ? err.message : "Tool failed unexpectedly.";
            if (!(err instanceof RoutingError)) logger.error({ err, tool: block.name }, "route planner tool failed");
            return { type: "tool_result", tool_use_id: block.id, is_error: true, content: msg };
          }
        }),
      );
      conversation.push({ role: "assistant", content: response.content });
      conversation.push({ role: "user", content: results });
    }
  } finally {
    await usage.flush({ userId: params.userId, surface: "route_planner", model });
  }

  if (state.presented) {
    return { message: state.presented.summary || message, route: state.presented };
  }
  return {
    message: message || "I couldn't build a route for that. Try giving a distance, or a place you'd like to run past.",
    route: null,
  };
}
