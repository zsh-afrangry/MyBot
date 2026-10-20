import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { describe, expect, it } from "vitest";

import entry, { isTrustedOwnerPrivateQq, isTrustedWeatherRead } from "./weather-plugin.js";

describe("personal-weather plugin metadata", () => {
  it("declares only the weather tool", () => {
    const metadata = getToolPluginMetadata(entry);
    expect(metadata?.activation).toEqual({onStartup: true});
    expect(metadata?.tools.map(tool => tool.name)).toEqual(['personal_weather_get_brief']);
    expect(metadata?.tools[0]?.optional).toBe(true);
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

it("allows only configured owner main Cron to read weather without granting owner writes", () => {
 const ctx={sessionKey:'agent:main:cron:12345678-1234-1234-1234-123456789abc',deliveryContext:{channel:'kurumi-qq',to:'user:365999865',accountId:'default'}};
 expect(isTrustedWeatherRead(ctx,'365999865')).toBe(true);
 expect(isTrustedOwnerPrivateQq(ctx)).toBe(false);
 expect(isTrustedWeatherRead({...ctx,sessionKey:'agent:researcher:cron:12345678-1234-1234-1234-123456789abc'},'365999865')).toBe(false);
 expect(isTrustedWeatherRead({...ctx,deliveryContext:{...ctx.deliveryContext,to:'user:123456'}},'365999865')).toBe(false);
 expect(isTrustedWeatherRead({...ctx,deliveryContext:{...ctx.deliveryContext,to:'group:365999865'}},'365999865')).toBe(false);
 expect(isTrustedWeatherRead(ctx,undefined)).toBe(false);
});
