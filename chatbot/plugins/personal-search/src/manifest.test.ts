import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("personal-search manifest", () => {
  it("declares only the optional model tool and its owned provider", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      id?: string;
      contracts?: { tools?: string[]; webSearchProviders?: string[] };
      toolMetadata?: Record<string, { optional?: boolean }>;
    };
    expect(manifest.id).toBe("personal-search");
    expect(manifest.contracts).toEqual({
      tools: ["personal_web_search"],
      webSearchProviders: ["deepseek-search"],
    });
    expect(manifest.toolMetadata?.personal_web_search?.optional).toBe(true);
  });
});
