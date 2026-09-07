import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildConfirmationInstruction, parseConfirmationText } from "./confirmation-gate.js";
import { commitPlanningProposal, proposePlanningChange } from "./planning.js";
import { ReminderStore } from "./reminder-store.js";
import { commitReminderProposal, proposeReminderCreate, type ReminderCronScheduler, type TrustedReminderContext } from "./reminders.js";
import { WeatherStore } from "./store.js";

const NOW = Math.floor(Date.parse("2026-08-12T12:00:00Z") / 1000);
const SCOPE = {
  primary: "conversation:qqbot:c2c:gate-owner",
  delivery: ["conversation:qqbot:c2c:gate-owner", "target:qqbot:c2c:gate-owner"],
};
const REMINDER_CONTEXT: TrustedReminderContext = {
  delivery: { channel: "qqbot", to: "qqbot:c2c:gate-owner", accountId: "default" },
  scope: SCOPE,
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Confirmation Gate", () => {
  it("rejects a same-run planning commit until a trusted later inbound message issues a grant", () => {
    const store = createWeatherStore();
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "无锡" } },
      }, SCOPE);
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;

      expect(commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, SCOPE)).toMatchObject({ ok: false, error: { code: "approval_required" } });
      expect(store.listTripSummaries()).toEqual([]);

      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:gate-owner",
        messageId: "gate-message-1",
        content: `确认 ${proposal.proposalId} ${proposal.payloadHash}`,
        isGroup: false,
        senderIsOwner: true,
      })).toBe(true);

      const committed = commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, SCOPE);
      expect(committed).toMatchObject({ ok: true, status: "committed", idempotent: false });
      expect(store.listTripSummaries()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("does not choose among multiple pending proposals for a bare confirmation", () => {
    const store = createWeatherStore();
    try {
      const first = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "无锡" } },
      }, SCOPE);
      const second = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "常州" } },
      }, SCOPE);
      expect(first.ok && second.ok).toBe(true);
      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:gate-owner",
        messageId: "gate-message-ambiguous",
        content: "确认",
        isGroup: false,
        senderIsOwner: true,
      })).toBe(false);
      expect(store.listTripSummaries()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects a confirmation from another QQ conversation", () => {
    const store = createWeatherStore();
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "无锡" } },
      }, SCOPE);
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;
      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:other-owner",
        messageId: "gate-message-cross-context",
        content: `确认 ${proposal.proposalId} ${proposal.payloadHash}`,
        isGroup: false,
        senderIsOwner: true,
      })).toBe(false);
      expect(commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, SCOPE)).toMatchObject({ ok: false, error: { code: "approval_required" } });
    } finally {
      store.close();
    }
  });

  it("does not treat quoted confirmation text as a new approval event", () => {
    const store = createWeatherStore();
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "无锡" } },
      }, SCOPE);
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;
      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:gate-owner",
        messageId: "gate-message-quote",
        content: `确认 ${proposal.proposalId} ${proposal.payloadHash}`,
        replyToIsQuote: true,
        isGroup: false,
        senderIsOwner: true,
      })).toBe(false);
      expect(commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, SCOPE)).toMatchObject({ ok: false, error: { code: "approval_required" } });
    } finally {
      store.close();
    }
  });

  it("applies the same gate to reminder creation without changing Cron policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "kurumi-confirmation-reminder-"));
    directories.push(root);
    const store = new ReminderStore({ stateDirectory: join(root, "state"), now: () => NOW });
    try {
      const proposal = proposeReminderCreate(store, {
        schema_version: 1,
        request: {
          kind: "reminder.create",
          content: "Gate 测试",
          schedule: { local_date_time: "2026-08-12T20:30", timezone: "Asia/Shanghai" },
        },
      }, REMINDER_CONTEXT);
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;
      const scheduler: ReminderCronScheduler = { add: async () => ({ jobId: "gate-job" }), remove: async () => undefined };
      expect(await commitReminderProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, REMINDER_CONTEXT, scheduler)).toMatchObject({ ok: false, error: { code: "approval_required" } });
      expect(store.listActiveSummaries()).toEqual([]);

      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:gate-owner",
        messageId: "gate-reminder-message-1",
        content: `确认 ${proposal.proposalId} ${proposal.payloadHash}`,
        isGroup: false,
        senderIsOwner: true,
      })).toBe(true);
      expect(await commitReminderProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, REMINDER_CONTEXT, scheduler)).toMatchObject({ ok: true, status: "scheduled" });
    } finally {
      store.close();
    }
  });
});

describe("parseConfirmationText", () => {
  const ID = "e4787f7a-1b2c-4d3e-8f90-1a2b3c4d5e6f";
  const HASH = "a".repeat(64);

  it("accepts an affirmative verb followed directly by its object", () => {
    // The 2026-08-30 22:14:35 owner message shape. The previous prefix pattern
    // required a separator after the verb and rejected this outright.
    expect(parseConfirmationText(`我确认变更 ${ID} ${HASH}`)).toEqual({ proposalId: ID, payloadHash: HASH });
  });

  it("accepts the instruction string the proposal preview hands to the owner", () => {
    expect(parseConfirmationText(buildConfirmationInstruction(ID, HASH))).toEqual({
      proposalId: ID,
      payloadHash: HASH,
    });
  });

  it("requires both identifiers", () => {
    // A bare affirmation carries no binding at all; one field alone still
    // leaves the gate guessing which proposal the owner meant.
    expect(parseConfirmationText("确认")).toBeUndefined();
    expect(parseConfirmationText(`确认 ${ID}`)).toBeUndefined();
    expect(parseConfirmationText(`确认 ${HASH}`)).toBeUndefined();
  });

  it("rejects negated affirmations", () => {
    expect(parseConfirmationText(`不确认 ${ID} ${HASH}`)).toBeUndefined();
    expect(parseConfirmationText(`取消确认 ${ID} ${HASH}`)).toBeUndefined();
  });

  it("does not match an over-long hex run as a hash", () => {
    expect(parseConfirmationText(`确认 ${ID} ${"a".repeat(65)}`)).toBeUndefined();
  });
});

describe("Confirmation Gate without a host-resolved owner bit", () => {
  it("commits when the inbound event omits senderIsOwner (LIVE-07-A regression)", () => {
    // The host builds the inbound hook event before it resolves owner identity,
    // so senderIsOwner is always absent in production (docs/7 §六 A.1). Every
    // pre-existing gate test set it explicitly, which is why the suite stayed
    // green while the real 宿迁 change could never commit. Authorization is
    // enforced at the commit tool boundary; scope binding is what protects the
    // inbound side.
    const store = createWeatherStore();
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "宿迁" } },
      }, SCOPE);
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;

      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:gate-owner",
        messageId: "gate-no-owner-bit",
        content: `我确认变更 ${proposal.proposalId} ${proposal.payloadHash}`,
        isGroup: false,
      })).toBe(true);

      expect(commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, SCOPE)).toMatchObject({ ok: true, status: "committed" });
    } finally {
      store.close();
    }
  });

  it("round-trips the instruction the proposal preview shows the owner", () => {
    // Closes the loop end to end: whatever the preview tells the owner to send
    // must be exactly what the inbound parser accepts. If the two ever drift
    // apart, the owner follows the instructions and the commit still fails.
    const store = createWeatherStore();
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "宿迁" } },
      }, SCOPE);
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;

      expect(proposal.previewText).toContain(proposal.confirmationInstruction);
      expect(parseConfirmationText(proposal.confirmationInstruction)).toEqual({
        proposalId: proposal.proposalId.toLowerCase(),
        payloadHash: proposal.payloadHash.toLowerCase(),
      });
      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:gate-owner",
        messageId: "gate-instruction-roundtrip",
        content: proposal.confirmationInstruction,
        isGroup: false,
      })).toBe(true);
      expect(commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, SCOPE)).toMatchObject({ ok: true, status: "committed" });
    } finally {
      store.close();
    }
  });

  it("binds the grant to one proposal when several domains have pending ones", () => {
    // The real 22:13 turn had two coexisting pending proposals (docs/7 §7.4).
    // Dual-field binding must pick exactly the named one and leave the other
    // pending rather than falling back to an ambiguity refusal.
    const store = createWeatherStore();
    try {
      const first = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "无锡" } },
      }, SCOPE);
      const second = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "常州" } },
      }, SCOPE);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:gate-owner",
        messageId: "gate-two-pending",
        content: `确认 ${second.proposalId} ${second.payloadHash}`,
        isGroup: false,
      })).toBe(true);

      expect(commitPlanningProposal(store, {
        proposal_id: first.proposalId,
        payload_hash: first.payloadHash,
      }, SCOPE)).toMatchObject({ ok: false, error: { code: "approval_required" } });
      expect(commitPlanningProposal(store, {
        proposal_id: second.proposalId,
        payload_hash: second.payloadHash,
      }, SCOPE)).toMatchObject({ ok: true, status: "committed" });
      expect(store.listTripSummaries()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rejects a correctly-formed confirmation carrying a mismatched hash", () => {
    const store = createWeatherStore();
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "无锡" } },
      }, SCOPE);
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;

      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:gate-owner",
        messageId: "gate-wrong-hash",
        content: `确认 ${proposal.proposalId} ${"b".repeat(64)}`,
        isGroup: false,
      })).toBe(false);
      expect(commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, SCOPE)).toMatchObject({ ok: false, error: { code: "approval_required" } });
    } finally {
      store.close();
    }
  });

  it("still refuses a stranger conversation that quotes the exact identifiers", () => {
    // With the inbound owner bit gone, scope binding is the only thing standing
    // between a third party and an owner proposal. Assert it directly.
    const store = createWeatherStore();
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "无锡" } },
      }, SCOPE);
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;

      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:stranger",
        messageId: "gate-stranger",
        content: `确认 ${proposal.proposalId} ${proposal.payloadHash}`,
        isGroup: false,
      })).toBe(false);
      expect(commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, SCOPE)).toMatchObject({ ok: false, error: { code: "approval_required" } });
    } finally {
      store.close();
    }
  });

  it("refuses a group message that carries the exact identifiers", () => {
    const store = createWeatherStore();
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "无锡" } },
      }, SCOPE);
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;

      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:gate-owner",
        messageId: "gate-group",
        content: `确认 ${proposal.proposalId} ${proposal.payloadHash}`,
        isGroup: true,
      })).toBe(false);
    } finally {
      store.close();
    }
  });
});

function createWeatherStore(): WeatherStore {
  const root = mkdtempSync(join(tmpdir(), "kurumi-confirmation-weather-"));
  directories.push(root);
  return new WeatherStore({ stateDirectory: join(root, "state"), now: () => NOW });
}
