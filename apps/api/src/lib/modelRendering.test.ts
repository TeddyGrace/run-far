import { describe, it, expect } from "vitest";
import { resolveModelRendered } from "./modelRendering.js";

describe("resolveModelRendered", () => {
  it("inherits the global default when no override is set", () => {
    expect(resolveModelRendered({ modelRenderedOverride: null }, { modelRenderedDefault: true })).toBe(true);
    expect(resolveModelRendered({ modelRenderedOverride: null }, { modelRenderedDefault: false })).toBe(false);
  });

  it("lets an override win in both directions", () => {
    expect(resolveModelRendered({ modelRenderedOverride: false }, { modelRenderedDefault: true })).toBe(false);
    expect(resolveModelRendered({ modelRenderedOverride: true }, { modelRenderedDefault: false })).toBe(true);
  });
});
