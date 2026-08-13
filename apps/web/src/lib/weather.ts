import type { WeatherSegment } from "@run-far/shared";

export const SEGMENT_LABELS: Record<WeatherSegment["segment"], string> = {
  morning: "AM",
  midday: "Mid",
  evening: "PM",
};
