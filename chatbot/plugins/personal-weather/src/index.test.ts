import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { describe, expect, it } from "vitest";

import entry, { isTrustedOwnerPrivateQq } from "./index.js";

describe("personal-weather plugin metadata", () => {
  it("declares only the reviewed weather, planning, and owner-reminder tools", () => {
    const metadata = getToolPluginMetadata(entry);
    expect(metadata?.activation).toEqual({ onStartup: true });
    expect(metadata?.tools).toHaveLength(11);
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
      "personal_planning_change_commit",
      "personal_reminder_state_get",
      "personal_reminder_propose",
      "personal_reminder_commit",
      "personal_reminder_change_propose",
      "personal_reminder_change_commit",
      "personal_reminder_cancel_propose",
      "personal_reminder_cancel_commit",
    ]);
    expect(metadata?.tools.slice(1).every((tool) => tool.optional)).toBe(true);
  });

  it("allows only the owner in a private QQ delivery context", () => {
    const base = {
      messageChannel: "qqbot",
      deliveryContext: { channel: "qqbot", to: "qqbot:c2c:owner", accountId: "default" },
      senderIsOwner: true,
    };
    expect(isTrustedOwnerPrivateQq(base)).toBe(true);
    expect(isTrustedOwnerPrivateQq({ ...base, senderIsOwner: false })).toBe(false);
    expect(isTrustedOwnerPrivateQq({ ...base, deliveryContext: { ...base.deliveryContext, to: "qqbot:group:123" } })).toBe(false);
    expect(isTrustedOwnerPrivateQq({ ...base, messageChannel: "telegram" })).toBe(false);
    expect(isTrustedOwnerPrivateQq({ ...base, deliveryContext: { channel: "qqbot", to: "qqbot:c2c:owner" } })).toBe(true);
  });
});
