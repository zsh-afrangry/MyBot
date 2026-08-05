import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { describe, expect, it } from "vitest";

import entry from "./index.js";

describe("personal-weather plugin metadata", () => {
  it("declares one optional, parameterless, read-only weather tool", () => {
    const metadata = getToolPluginMetadata(entry);
    expect(metadata?.activation).toEqual({ onStartup: false });
    expect(metadata?.tools).toHaveLength(1);
    expect(metadata?.tools[0]).toMatchObject({
      name: "personal_weather_get_brief",
      optional: true,
      parameters: {
        type: "object",
        additionalProperties: false,
      },
    });
  });
});
