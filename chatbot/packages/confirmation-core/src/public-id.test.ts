import { describe, expect, it } from "vitest";
import { createPublicUuid } from "./public-id.js";

describe("public UUID transport compatibility", () => {
  it("rejects a fixed real collision shape before returning the next UUID", () => {
    const ids = ["00000000-0000-4000-80fc-000000000000", "00000000-0000-4000-80fd-000000000000"];
    expect(createPublicUuid(() => ids.shift()!)).toBe("00000000-0000-4000-80fd-000000000000");
    expect(ids).toHaveLength(0);
  });
  it("fails after bounded collisions rather than returning an unsafe reference", () => {
    let calls = 0;
    expect(() => createPublicUuid(() => { calls++; return "00000000-0000-4000-80fc-000000000000"; })).toThrow("transport-safe");
    expect(calls).toBe(16);
  });
  it("retains valid random UUID v4 references", () => {
    const ids = new Set(Array.from({ length: 256 }, () => createPublicUuid()));
    expect(ids.size).toBe(256);
    for (const id of ids) {
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
      expect(id).not.toMatch(/fc-/iu);
    }
  });
});
