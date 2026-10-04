import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { describe, expect, it } from "vitest";

import entry, { isTrustedOwnerPrivateQq } from "./index.js";

describe("personal-weather plugin metadata", () => {
  it("declares only the reviewed weather, Profile, planning, and owner-reminder tools", () => {
    const metadata = getToolPluginMetadata(entry);
    expect(metadata?.activation).toEqual({ onStartup: true });
    expect(metadata?.tools).toHaveLength(14);
    expect(metadata?.tools[0]).toMatchObject({
      name: "personal_weather_get_brief",
      optional: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          location: { type: "string" },
          administrative_area: { type: "string" },
        },
      },
    });
    expect(metadata?.tools.slice(1).map((tool) => tool.name)).toEqual([
      "personal_profile_state_get",
      "personal_profile_change_propose",
      "personal_profile_change_commit",
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
    expect(isTrustedOwnerPrivateQq({ ...base, deliveryContext: { channel: "qqbot" } })).toBe(false);
  });
});

it('accepts the fusion owner route and refuses a mismatched sender or worker session', () => {
 const ctx={messageChannel:'kurumi-qq',senderIsOwner:true,requesterSenderId:'365999865',sessionKey:'agent:main:kurumi-qq:direct:365999865',deliveryContext:{channel:'kurumi-qq',to:'user:365999865',accountId:'default'}};
 expect(isTrustedOwnerPrivateQq(ctx)).toBe(true);
 expect(isTrustedOwnerPrivateQq({...ctx,requesterSenderId:'123456'})).toBe(false);
 expect(isTrustedOwnerPrivateQq({...ctx,sessionKey:'agent:worker:task'})).toBe(false);
});
