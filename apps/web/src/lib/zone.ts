export type Zone = "good" | "yellow" | "red" | "info";

export function zoneForRecovery(score: number | null): Zone {
  if (score == null) return "info";
  if (score <= 33) return "red";
  if (score <= 66) return "yellow";
  return "good";
}

export const ZONE_LABEL: Record<Zone, string> = {
  good: "Green",
  yellow: "Yellow",
  red: "Red",
  info: "No data",
};

// Tailwind color tokens per zone — used where a class name must be built dynamically
// rather than written literally (Tailwind can't see interpolated class strings).
export const ZONE_HEX: Record<Zone, string> = {
  good: "#6FAE6B",
  yellow: "#D9A548",
  red: "#D1554B",
  info: "#7C96B8",
};
