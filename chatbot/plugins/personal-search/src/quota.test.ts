import { describe, expect, it } from "vitest";

import { SearchError } from "./errors.js";
import { SearchQuota } from "./quota.js";

describe("SearchQuota", () => {
  it("counts requests and releases concurrency after completion", async () => {
    let now = 0;
    const quota = new SearchQuota({ maxPerMinute: 2, maxPerDay: 3, now: () => now });
    await quota.run(async () => undefined);
    expect(quota.snapshot()).toMatchObject({ minuteCount: 1, dayCount: 1, inFlight: 0 });
    await quota.run(async () => undefined);
    await expect(quota.run(async () => undefined)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    now = 60_000;
    await quota.run(async () => undefined);
    expect(quota.snapshot()).toMatchObject({ minuteCount: 1, dayCount: 3, inFlight: 0 });
  });

  it("does not allow a concurrent request through the hard limit", async () => {
    const quota = new SearchQuota({ maxConcurrent: 1 });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = quota.run(async () => pending);
    await expect(quota.run(async () => undefined)).rejects.toBeInstanceOf(SearchError);
    release();
    await running;
  });
});
