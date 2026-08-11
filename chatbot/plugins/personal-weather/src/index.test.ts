import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { describe, expect, it } from "vitest";

import entry from "./index.js";

describe("personal-weather plugin metadata", () => {
  it("declares the P1 weather reader and P2A planning tools", () => {
    const metadata = getToolPluginMetadata(entry);
    expect(metadata?.activation).toEqual({ onStartup: false });
    expect(metadata?.tools).toHaveLength(3);
    expect(metadata?.tools[0]).toMatchObject({
      name: "personal_weather_get_brief",
      optional: true,
      parameters: {
        type: "object",
        additionalProperties: false,
      },
    });
    expect(metadata?.tools.slice(1).map((tool) => tool.name)).toEqual([
      "personal_planning_state_get",
      "personal_planning_change_propose",
    ]);
    expect(metadata?.tools.slice(1).every((tool) => tool.optional)).toBe(true);
  });
});
