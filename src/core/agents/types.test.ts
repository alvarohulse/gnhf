import { describe, expect, it } from "vitest";
import { buildAgentOutputSchema, getTokenUsageTotal } from "./types.js";

describe("buildAgentOutputSchema", () => {
  it("adds configured commit message fields to properties and required", () => {
    const schema = buildAgentOutputSchema({
      includeStopField: false,
      commitFields: [
        {
          name: "type",
          allowed: ["feat", "fix"],
        },
        {
          name: "scope",
        },
      ],
    });

    expect(schema.properties.type).toEqual({
      type: "string",
      enum: ["feat", "fix"],
    });
    expect(schema.properties.scope).toEqual({ type: "string" });
    expect(schema.required).toContain("type");
    expect(schema.required).toContain("scope");
  });
});

describe("getTokenUsageTotal", () => {
  it("includes cache reads when the provider omits an explicit total", () => {
    expect(
      getTokenUsageTotal({
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
        tokensAvailable: true,
      }),
    ).toBe(19);
  });
});
