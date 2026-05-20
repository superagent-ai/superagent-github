import { describe, expect, it } from "vitest";
import { formatFindingPriority } from "../findingPriority.js";

describe("formatFindingPriority", () => {
  it("maps severities to P0-P3", () => {
    expect(formatFindingPriority("critical")).toBe("P0");
    expect(formatFindingPriority("high")).toBe("P1");
    expect(formatFindingPriority("medium")).toBe("P2");
    expect(formatFindingPriority("low")).toBe("P3");
  });
});
