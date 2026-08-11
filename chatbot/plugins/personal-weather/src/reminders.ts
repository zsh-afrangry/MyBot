import { createHash, randomUUID } from "node:crypto";

import {
  REMINDER_SUBJECT_ID,
  REMINDER_TIMEZONE,
  type ReminderDelivery,
  type ReminderProposalKind,
  type ReminderStatus,
  type ReminderStore,
  type StoredReminder,
  type StoredReminderProposal,
} from "./reminder-store.js";

const PROPOSAL_TTL_SECONDS = 24 * 60 * 60;
const MIN_LEAD_SECONDS = 60;
const MAX_HORIZON_SECONDS = 366 * 24 * 60 * 60;
const MAX_CONTENT_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

export interface TrustedReminderContext {
  delivery: ReminderDelivery;
}

export interface ReminderCreateProposeInput {
  schema_version: 1;
  request: {
    kind: "reminder.create";
    content: string;
    schedule: {
      local_date_time: string;
      timezone: "Asia/Shanghai";
    };
  };
}

export interface ReminderCancelProposeInput {
  schema_version: 1;
  request: {
    kind: "reminder.cancel";
    reminder_id: string;
  };
}

export interface ReminderUpdateProposeInput {
  schema_version: 1;
  request: {
    kind: "reminder.update";
    reminder_id: string;
    content?: string;
    schedule?: {
      local_date_time: string;
      timezone: "Asia/Shanghai";
    };
  };
}

export interface ReminderCommitInput {
  proposal_id: string;
  payload_hash: string;
}

export interface ReminderCronScheduler {
  add(input: ReminderCronAddInput): Promise<{ jobId: string }>;
  remove(input: { jobId: string }): Promise<void>;
  /** Update the existing managed Cron job in place. Optional for test or
   * recovery adapters; production Gateway schedulers provide it. */
  update?(input: ReminderCronUpdateInput): Promise<void>;
}

export interface ReminderCronAddInput {
  reminderId: string;
  scheduledAtUtc: number;
  delivery: ReminderDelivery;
  eventKey: string;
  /** Attempt-specific declaration key; absent for the first attempt. */
  declarationKey?: string;
}

export interface ReminderCronUpdateInput {
  jobId: string;
  scheduledAtUtc: number;
}

export type ReminderFailure = {
  ok: false;
  error: {
    code:
      | "invalid_input"
      | "unsupported_request"
      | "proposal_not_found"
      | "proposal_hash_mismatch"
      | "proposal_expired"
      | "proposal_unavailable"
      | "proposal_context_mismatch"
      | "reminder_not_found"
      | "reminder_unavailable"
      | "scheduler_failed";
    message: string;
  };
};

export interface ReminderProposalResult {
  ok: true;
  schemaVersion: 1;
  proposalId: string;
  payloadHash: string;
  status: "pending";
  kind: "reminder_create" | "reminder_cancel" | "reminder_update";
  previewText: string;
  canonicalFacts: {
    kind: "reminder.create" | "reminder.cancel" | "reminder.update";
    content?: string;
    schedule?: {
      atUtc: number;
      localDateTime: string;
      timezone: "Asia/Shanghai";
      recurrence: "once";
    };
    reminderId?: string;
    previousContent?: string;
    previousSchedule?: {
      atUtc: number;
      localDateTime: string;
      timezone: "Asia/Shanghai";
      recurrence: "once";
    };
  };
  derivedEffects: Array<{
    kind: "reminder.schedule" | "reminder.cancel" | "reminder.update";
    target: "owner_qq_private";
  }>;
  requiresConfirmation: true;
  expiresAtUtc: number;
  persistedAs: "reminder_proposals";
}

export interface ReminderStateResult {
  ok: true;
  schemaVersion: 1;
  asOfUtc: number;
  activeReminders: Array<{
    reminderId: string;
    status: ReminderStatus;
    content: string;
    scheduledAtUtc: number;
    localDateTime: string;
    timezone: "Asia/Shanghai";
    dispatchedAtUtc: number | null;
    failureCode: string | null;
    retryStatus: "scheduling" | "scheduled" | "pending" | "delivered" | "cancelled" | "exhausted" | "unknown";
    attemptCount: number;
    nextRetryAtUtc: number | null;
  }>;
  capabilities: {
    proposalPreview: true;
    proposalCommit: true;
    confirmationCancel: true;
    confirmationUpdate: true;
    recurrence: false;
    directCronAccess: false;
    directQqSend: false;
    retryPolicy: "definite_delivery_failure_only";
  };
}

export interface ReminderCommitResult {
  ok: true;
  schemaVersion: 1;
  proposalId: string;
  kind: "reminder_create" | "reminder_cancel" | "reminder_update";
  status: "scheduled" | "cancelled" | "updated" | "update_unknown" | "scheduling_failed";
  idempotent: boolean;
  reminder: {
    reminderId: string;
    content: string;
    scheduledAtUtc: number;
    localDateTime: string;
    timezone: "Asia/Shanghai";
    state: ReminderStatus;
  };
  warnings: string[];
}

export function getReminderState(store: ReminderStore): ReminderStateResult {
  const asOfUtc = store.getNowUtc();
  return {
    ok: true,
    schemaVersion: 1,
    asOfUtc,
    activeReminders: store.listActiveSummaries().map((reminder) => ({
      reminderId: reminder.reminderId,
      status: reminder.status,
      content: reminder.content,
      scheduledAtUtc: reminder.scheduledAtUtc,
      localDateTime: formatShanghaiDateTime(reminder.scheduledAtUtc),
      timezone: REMINDER_TIMEZONE,
      dispatchedAtUtc: reminder.dispatchedAtUtc,
      failureCode: reminder.failureCode,
      retryStatus: reminder.retryStatus,
      attemptCount: reminder.attemptCount,
      nextRetryAtUtc: reminder.nextRetryAtUtc,
    })),
    capabilities: {
      proposalPreview: true,
      proposalCommit: true,
      confirmationCancel: true,
      confirmationUpdate: true,
      recurrence: false,
      directCronAccess: false,
      directQqSend: false,
      retryPolicy: "definite_delivery_failure_only",
    },
  };
}

export function proposeReminderCreate(
  store: ReminderStore,
  rawInput: unknown,
  context: TrustedReminderContext,
): ReminderProposalResult | ReminderFailure {
  const parsed = parseCreateInput(rawInput, store.getNowUtc());
  if (!parsed.ok) return parsed;
  const nowUtc = store.getNowUtc();
  const payload = {
    schemaVersion: 1,
    kind: "reminder.create" as const,
    content: parsed.input.content,
    schedule: {
      atUtc: parsed.input.scheduledAtUtc,
      localDateTime: parsed.input.localDateTime,
      timezone: REMINDER_TIMEZONE as "Asia/Shanghai",
      recurrence: "once" as const,
    },
    sourceKind: "owner_text" as const,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadHash = sha256(payloadJson);
  const proposalId = randomUUID();
  const expiresAtUtc = nowUtc + PROPOSAL_TTL_SECONDS;
  store.createPendingProposal({
    proposalId,
    kind: "reminder_create",
    payloadJson,
    payloadHash,
    requestContextHash: requestContextHash("reminder_create", payloadHash, context.delivery),
    delivery: context.delivery,
    expiresAtUtc,
    atUtc: nowUtc,
  });
  return {
    ok: true,
    schemaVersion: 1,
    proposalId,
    payloadHash,
    status: "pending",
    kind: "reminder_create",
    previewText: [
      "主人，已生成一份待确认提醒提案：",
      `- 时间：${payload.schedule.localDateTime}（${REMINDER_TIMEZONE}，一次）`,
      `- 内容：${payload.content}`,
      "- 投递：仅主人 QQ 私聊",
      "请在本次私聊明确确认；确认后才会创建受限的定时任务。",
    ].join("\n"),
    canonicalFacts: {
      kind: "reminder.create",
      content: payload.content,
      schedule: payload.schedule,
    },
    derivedEffects: [{ kind: "reminder.schedule", target: "owner_qq_private" }],
    requiresConfirmation: true,
    expiresAtUtc,
    persistedAs: "reminder_proposals",
  };
}

export function proposeReminderCancellation(
  store: ReminderStore,
  rawInput: unknown,
  context: TrustedReminderContext,
): ReminderProposalResult | ReminderFailure {
  const parsed = parseCancelInput(rawInput);
  if (!parsed.ok) return parsed;
  const reminder = store.getReminder(parsed.reminderId);
  if (!reminder) return failure("reminder_not_found", "未找到该提醒，不能生成取消提案。");
  const retryStatus = store.getRetryStatus(reminder.reminderId);
  if (!canCancel(reminder.status, retryStatus)) {
    if (retryStatus === "unknown") {
      return failure("reminder_unavailable", "该提醒的定时或投递结果不确定，不能自动取消；请先人工核对 Gateway 状态。");
    }
    return failure("reminder_unavailable", "该提醒已经投递、正在投递或已取消，不能再取消。");
  }
  if (!sameDelivery(reminder.delivery, context.delivery)) {
    return failure("proposal_context_mismatch", "该提醒只能在原主人 QQ 私聊上下文中取消。");
  }
  const nowUtc = store.getNowUtc();
  const payload = {
    schemaVersion: 1,
    kind: "reminder.cancel" as const,
    reminderId: reminder.reminderId,
    sourceKind: "owner_text" as const,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadHash = sha256(payloadJson);
  const proposalId = randomUUID();
  const expiresAtUtc = nowUtc + PROPOSAL_TTL_SECONDS;
  store.createPendingProposal({
    proposalId,
    kind: "reminder_cancel",
    payloadJson,
    payloadHash,
    requestContextHash: requestContextHash("reminder_cancel", payloadHash, context.delivery),
    delivery: context.delivery,
    expiresAtUtc,
    atUtc: nowUtc,
  });
  return {
    ok: true,
    schemaVersion: 1,
    proposalId,
    payloadHash,
    status: "pending",
    kind: "reminder_cancel",
    previewText: [
      "主人，已生成一份待确认的取消提醒提案：",
      `- 原时间：${formatShanghaiDateTime(reminder.scheduledAtUtc)}（${REMINDER_TIMEZONE}）`,
      `- 原内容：${reminder.content}`,
      "- 影响：仅取消这条尚未投递的主人私聊提醒",
      "请在本次私聊明确确认；确认后才会移除受限的定时任务。",
    ].join("\n"),
    canonicalFacts: { kind: "reminder.cancel", reminderId: reminder.reminderId },
    derivedEffects: [{ kind: "reminder.cancel", target: "owner_qq_private" }],
    requiresConfirmation: true,
    expiresAtUtc,
    persistedAs: "reminder_proposals",
  };
}

export function proposeReminderUpdate(
  store: ReminderStore,
  rawInput: unknown,
  context: TrustedReminderContext,
): ReminderProposalResult | ReminderFailure {
  const parsed = parseUpdateInput(rawInput, store.getNowUtc());
  if (!parsed.ok) return parsed;
  const reminder = store.getReminder(parsed.reminderId);
  if (!reminder) return failure("reminder_not_found", "未找到该提醒，不能生成修改提案。");
  if (!sameDelivery(reminder.delivery, context.delivery)) {
    return failure("proposal_context_mismatch", "该提醒只能在原主人 QQ 私聊上下文中修改。");
  }
  const retryStatus = store.getRetryStatus(reminder.reminderId);
  if (!canUpdate(reminder, retryStatus)) {
    if (retryStatus === "unknown") {
      return failure("reminder_unavailable", "该提醒的定时或投递结果不确定，不能修改；请先人工核对 Gateway 状态。");
    }
    return failure("reminder_unavailable", "只有尚未投递且状态确定的提醒才能修改。");
  }

  const nextContent = parsed.content ?? reminder.content;
  const nextScheduledAtUtc = parsed.scheduledAtUtc ?? reminder.scheduledAtUtc;
  const nextLocalDateTime = parsed.localDateTime ?? formatShanghaiDateTime(nextScheduledAtUtc);
  const contentChanged = nextContent !== reminder.content;
  const scheduleChanged = nextScheduledAtUtc !== reminder.scheduledAtUtc;
  if (!contentChanged && !scheduleChanged) {
    return failure("invalid_input", "修改内容与原提醒完全相同，无需生成提案。");
  }

  const nowUtc = store.getNowUtc();
  const payload = {
    schemaVersion: 1,
    kind: "reminder.update" as const,
    reminderId: reminder.reminderId,
    base: {
      content: reminder.content,
      scheduledAtUtc: reminder.scheduledAtUtc,
      cronJobId: reminder.cronJobId,
      retryStatus: "scheduled" as const,
    },
    next: {
      content: nextContent,
      schedule: {
        atUtc: nextScheduledAtUtc,
        localDateTime: nextLocalDateTime,
        timezone: REMINDER_TIMEZONE as "Asia/Shanghai",
        recurrence: "once" as const,
      },
    },
    sourceKind: "owner_text" as const,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadHash = sha256(payloadJson);
  const proposalId = randomUUID();
  const expiresAtUtc = nowUtc + PROPOSAL_TTL_SECONDS;
  store.createPendingProposal({
    proposalId,
    kind: "reminder_update",
    payloadJson,
    payloadHash,
    requestContextHash: requestContextHash("reminder_update", payloadHash, context.delivery),
    delivery: context.delivery,
    expiresAtUtc,
    atUtc: nowUtc,
  });
  return {
    ok: true,
    schemaVersion: 1,
    proposalId,
    payloadHash,
    status: "pending",
    kind: "reminder_update",
    previewText: [
      "主人，已生成一份待确认的提醒修改提案：",
      `- 原时间：${formatShanghaiDateTime(reminder.scheduledAtUtc)}（${REMINDER_TIMEZONE}）`,
      `- 新时间：${nextLocalDateTime}（${REMINDER_TIMEZONE}）`,
      `- 原内容：${reminder.content}`,
      `- 新内容：${nextContent}`,
      "- 影响：在原有受限定时任务上原地更新，不会创建第二条提醒",
      "请在本次私聊明确确认；确认后才会应用修改。",
    ].join("\n"),
    canonicalFacts: {
      kind: "reminder.update",
      reminderId: reminder.reminderId,
      content: nextContent,
      schedule: payload.next.schedule,
      previousContent: reminder.content,
      previousSchedule: {
        atUtc: reminder.scheduledAtUtc,
        localDateTime: formatShanghaiDateTime(reminder.scheduledAtUtc),
        timezone: REMINDER_TIMEZONE,
        recurrence: "once",
      },
    },
    derivedEffects: [{ kind: "reminder.update", target: "owner_qq_private" }],
    requiresConfirmation: true,
    expiresAtUtc,
    persistedAs: "reminder_proposals",
  };
}

export async function commitReminderProposal(
  store: ReminderStore,
  rawInput: unknown,
  context: TrustedReminderContext,
  scheduler: ReminderCronScheduler,
): Promise<ReminderCommitResult | ReminderFailure> {
  const parsed = parseCommitInput(rawInput);
  if (!parsed.ok) return parsed;
  const nowUtc = store.getNowUtc();
  const proposal = store.getProposal(parsed.input.proposalId);
  if (!proposal) return failure("proposal_not_found", "未找到可确认的提醒提案。");
  if (proposal.payloadHash !== parsed.input.payloadHash) {
    return failure("proposal_hash_mismatch", "提案内容已变化，请以最新预览为准。" );
  }
  if (!sameDelivery(proposal.delivery, context.delivery)) {
    return failure("proposal_context_mismatch", "该提案只能在生成它的主人 QQ 私聊中确认。");
  }
  const expectedContextHash = requestContextHash(proposal.kind, proposal.payloadHash, context.delivery);
  if (proposal.requestContextHash !== expectedContextHash) {
    return failure("proposal_context_mismatch", "该提案的确认上下文无效，请重新生成。" );
  }
  if (proposal.status === "committed") {
    return committedProposalResult(store, proposal, true);
  }
  if (proposal.status !== "pending") {
    return failure("proposal_unavailable", "该提醒提案已不可确认，请重新生成。" );
  }
  if (proposal.expiresAtUtc <= nowUtc) {
    store.expireProposal(proposal.proposalId, nowUtc);
    store.insertAudit({
      action: "reminder_proposal.expired",
      entityType: "reminder_proposal",
      entityId: proposal.proposalId,
      proposalId: proposal.proposalId,
      summary: { kind: proposal.kind },
      atUtc: nowUtc,
    });
    return failure("proposal_expired", "该提醒提案已过期，未创建任何定时任务。" );
  }
  if (proposal.kind === "reminder_create") return commitCreateProposal(store, proposal, scheduler, nowUtc);
  if (proposal.kind === "reminder_cancel") return commitCancelProposal(store, proposal, scheduler, nowUtc);
  return commitUpdateProposal(store, proposal, scheduler, nowUtc);
}

async function commitCreateProposal(
  store: ReminderStore,
  proposal: StoredReminderProposal,
  scheduler: ReminderCronScheduler,
  nowUtc: number,
): Promise<ReminderCommitResult | ReminderFailure> {
  const facts = parseStoredCreatePayload(proposal.payloadJson);
  if (!facts) return failure("proposal_unavailable", "提案的提醒内容无效，请重新生成。" );
  if (facts.scheduledAtUtc < nowUtc + MIN_LEAD_SECONDS) {
    return failure("proposal_unavailable", "提醒时间已太近或已过去，请重新生成一条未来提醒。" );
  }
  const reminderId = randomUUID();
  const eventKey = `personal-reminder:${reminderId}:${facts.scheduledAtUtc}`;
  store.createSchedulingReminder({
    reminderId,
    content: facts.content,
    scheduledAtUtc: facts.scheduledAtUtc,
    timezone: REMINDER_TIMEZONE,
    delivery: proposal.delivery,
    eventKey,
    proposalId: proposal.proposalId,
    payloadHash: proposal.payloadHash,
    atUtc: nowUtc,
  });

  try {
    const scheduled = await scheduler.add({
      reminderId,
      scheduledAtUtc: facts.scheduledAtUtc,
      delivery: proposal.delivery,
      eventKey,
    });
    store.markReminderScheduled({ reminderId, cronJobId: scheduled.jobId, atUtc: store.getNowUtc() });
    const reminder = store.getReminder(reminderId);
    if (!reminder) throw new Error("Scheduled reminder could not be read");
    return createCommitResult(proposal.proposalId, "reminder_create", reminder, false, "scheduled", []);
  } catch {
    // cron.add may have succeeded before its response was lost. This is an
    // uncertain registration outcome, so R2D must not auto-send a duplicate.
    store.markReminderSchedulingUnknown({ reminderId, code: "cron_add_unknown", atUtc: store.getNowUtc() });
    const reminder = store.getReminder(reminderId);
    if (!reminder) throw new Error("Failed reminder could not be read");
    return createCommitResult(
      proposal.proposalId,
      "reminder_create",
      reminder,
      false,
      "scheduling_failed",
      ["定时任务注册结果不确定，未自动重试以避免重复提醒；请稍后查看状态或人工确认。"],
    );
  }
}

async function commitCancelProposal(
  store: ReminderStore,
  proposal: StoredReminderProposal,
  scheduler: ReminderCronScheduler,
  nowUtc: number,
): Promise<ReminderCommitResult | ReminderFailure> {
  const facts = parseStoredCancelPayload(proposal.payloadJson);
  if (!facts) return failure("proposal_unavailable", "提案的取消目标无效，请重新生成。" );
  const reminder = store.getReminder(facts.reminderId);
  const retryStatus = reminder ? store.getRetryStatus(reminder.reminderId) : undefined;
  if (!reminder || !canCancel(reminder.status, retryStatus)) {
    if (retryStatus === "unknown") {
      return failure("reminder_unavailable", "该提醒的定时或投递结果不确定，不能自动取消；请先人工核对 Gateway 状态。");
    }
    return failure("reminder_unavailable", "该提醒已不可取消，未修改任何状态。" );
  }
  if (reminder.cronJobId) {
    try {
      await scheduler.remove({ jobId: reminder.cronJobId });
    } catch {
      return failure("scheduler_failed", "未能安全移除定时任务，因此没有取消这条提醒。" );
    }
  }
  if (!store.commitCancellationProposal({
    proposalId: proposal.proposalId,
    payloadHash: proposal.payloadHash,
    reminderId: reminder.reminderId,
    atUtc: nowUtc,
  })) {
    return failure("proposal_unavailable", "取消提案状态发生变化，未完成取消。" );
  }
  const cancelled = store.getReminder(reminder.reminderId);
  if (!cancelled) throw new Error("Cancelled reminder could not be read");
  return createCommitResult(proposal.proposalId, "reminder_cancel", cancelled, false, "cancelled", []);
}

async function commitUpdateProposal(
  store: ReminderStore,
  proposal: StoredReminderProposal,
  scheduler: ReminderCronScheduler,
  nowUtc: number,
): Promise<ReminderCommitResult | ReminderFailure> {
  const facts = parseStoredUpdatePayload(proposal.payloadJson);
  if (!facts || !facts.base.cronJobId) {
    return failure("proposal_unavailable", "提案的修改目标无效，请重新生成。");
  }
  if (facts.next.scheduledAtUtc < nowUtc + MIN_LEAD_SECONDS) {
    return failure("proposal_unavailable", "新的提醒时间已太近或已过去，请重新生成一条未来修改提案。");
  }
  const reminder = store.getReminder(facts.reminderId);
  const retryStatus = reminder ? store.getRetryStatus(facts.reminderId) : undefined;
  if (!reminder || !canUpdate(reminder, retryStatus) || !sameUpdateBase(reminder, facts.base)) {
    if (retryStatus === "unknown") {
      return failure("reminder_unavailable", "该提醒的状态不确定，不能修改；请先人工核对 Gateway 状态。");
    }
    return failure("reminder_unavailable", "该提醒已发生变化或不可修改，未提交任何更新。");
  }
  const scheduleChanged = facts.next.scheduledAtUtc !== reminder.scheduledAtUtc;
  const applied = store.applyReminderUpdate({
    proposalId: proposal.proposalId,
    payloadHash: proposal.payloadHash,
    reminderId: reminder.reminderId,
    expectedContent: facts.base.content,
    expectedScheduledAtUtc: facts.base.scheduledAtUtc,
    expectedCronJobId: facts.base.cronJobId,
    nextContent: facts.next.content,
    nextScheduledAtUtc: facts.next.scheduledAtUtc,
    scheduleChanged,
    atUtc: nowUtc,
  });
  if (!applied) return failure("proposal_unavailable", "修改提案与当前提醒状态不一致，未提交任何更新。");

  if (scheduleChanged) {
    if (!scheduler.update) {
      store.markReminderUpdateUnknown({ reminderId: reminder.reminderId, code: "cron_update_unavailable", atUtc: store.getNowUtc() });
      const updated = store.getReminder(reminder.reminderId);
      if (!updated) throw new Error("Updated reminder could not be read");
      return createCommitResult(proposal.proposalId, "reminder_update", updated, false, "update_unknown", [
        "本地修改已保存，但当前调度适配器不支持原地更新时间；结果不确定，已阻止后续自动修改，请人工核对 Gateway。",
      ]);
    }
    try {
      await scheduler.update({ jobId: facts.base.cronJobId, scheduledAtUtc: facts.next.scheduledAtUtc });
      if (!store.markReminderUpdateConfirmed({ reminderId: reminder.reminderId, atUtc: store.getNowUtc() })) {
        store.markReminderUpdateUnknown({ reminderId: reminder.reminderId, code: "local_update_confirmation_failed", atUtc: store.getNowUtc() });
        const updated = store.getReminder(reminder.reminderId);
        if (!updated) throw new Error("Updated reminder could not be read");
        return createCommitResult(proposal.proposalId, "reminder_update", updated, false, "update_unknown", [
          "Gateway 已返回成功，但本地确认状态失败，结果不确定；已阻止后续自动修改，请人工核对 Gateway。",
        ]);
      }
    } catch {
      store.markReminderUpdateUnknown({ reminderId: reminder.reminderId, code: "cron_update_unknown", atUtc: store.getNowUtc() });
      const updated = store.getReminder(reminder.reminderId);
      if (!updated) throw new Error("Updated reminder could not be read");
      return createCommitResult(proposal.proposalId, "reminder_update", updated, false, "update_unknown", [
        "本地修改已保存，但 Gateway 更新时间结果不确定，未自动重试以避免重复提醒；请人工核对 Gateway。",
      ]);
    }
  }
  const updated = store.getReminder(reminder.reminderId);
  if (!updated) throw new Error("Updated reminder could not be read");
  return createCommitResult(proposal.proposalId, "reminder_update", updated, false, "updated", []);
}

function committedProposalResult(
  store: ReminderStore,
  proposal: StoredReminderProposal,
  idempotent: boolean,
): ReminderCommitResult | ReminderFailure {
  if (!proposal.resultReminderId) {
    return failure("proposal_unavailable", "该已确认提案缺少提醒记录，不能重复确认。" );
  }
  const reminder = store.getReminder(proposal.resultReminderId);
  if (!reminder) return failure("proposal_unavailable", "该已确认提案的提醒记录不完整。" );
  const status = proposal.kind === "reminder_cancel"
    ? "cancelled"
    : proposal.kind === "reminder_update"
      ? store.getRetryStatus(reminder.reminderId) === "unknown" ? "update_unknown" : "updated"
    : reminder.status === "scheduled"
      ? "scheduled"
      : "scheduling_failed";
  return createCommitResult(proposal.proposalId, proposal.kind, reminder, idempotent, status, []);
}

function createCommitResult(
  proposalId: string,
  kind: ReminderProposalKind,
  reminder: StoredReminder,
  idempotent: boolean,
  status: ReminderCommitResult["status"],
  warnings: string[],
): ReminderCommitResult {
  return {
    ok: true,
    schemaVersion: 1,
    proposalId,
    kind,
    status,
    idempotent,
    reminder: {
      reminderId: reminder.reminderId,
      content: reminder.content,
      scheduledAtUtc: reminder.scheduledAtUtc,
      localDateTime: formatShanghaiDateTime(reminder.scheduledAtUtc),
      timezone: REMINDER_TIMEZONE,
      state: reminder.status,
    },
    warnings,
  };
}

function parseCreateInput(rawInput: unknown, nowUtc: number):
  | { ok: true; input: { content: string; localDateTime: string; scheduledAtUtc: number } }
  | ReminderFailure {
  if (!isRecord(rawInput) || rawInput.schema_version !== 1 || !isRecord(rawInput.request)) {
    return failure("invalid_input", "提醒提案格式无效。" );
  }
  const request = rawInput.request;
  if (request.kind !== "reminder.create" || !isRecord(request.schedule)) {
    return failure("unsupported_request", "首版只支持创建一次性提醒。" );
  }
  if (request.schedule.timezone !== REMINDER_TIMEZONE || typeof request.schedule.local_date_time !== "string") {
    return failure("invalid_input", "首版提醒必须使用 Asia/Shanghai 和明确的本地日期时间。" );
  }
  const content = normalizeContent(request.content);
  if (!content) return failure("invalid_input", "提醒内容需为 1 至 200 个可见字符。" );
  const parsedTime = parseShanghaiLocalDateTime(request.schedule.local_date_time);
  if (!parsedTime) return failure("invalid_input", "提醒时间必须是有效的 YYYY-MM-DDTHH:mm。" );
  if (parsedTime.atUtc < nowUtc + MIN_LEAD_SECONDS) {
    return failure("invalid_input", "提醒时间必须至少在当前时间 1 分钟之后。" );
  }
  if (parsedTime.atUtc > nowUtc + MAX_HORIZON_SECONDS) {
    return failure("invalid_input", "首版提醒最多可设置到 366 天内。" );
  }
  return {
    ok: true,
    input: {
      content,
      localDateTime: parsedTime.localDateTime,
      scheduledAtUtc: parsedTime.atUtc,
    },
  };
}

function parseCancelInput(rawInput: unknown): { ok: true; reminderId: string } | ReminderFailure {
  if (!isRecord(rawInput) || rawInput.schema_version !== 1 || !isRecord(rawInput.request)) {
    return failure("invalid_input", "取消提醒提案格式无效。" );
  }
  if (rawInput.request.kind !== "reminder.cancel" || typeof rawInput.request.reminder_id !== "string") {
    return failure("unsupported_request", "取消提案只能引用一条既有提醒。" );
  }
  const reminderId = rawInput.request.reminder_id.toLowerCase();
  return UUID_PATTERN.test(reminderId)
    ? { ok: true, reminderId }
    : failure("invalid_input", "提醒标识格式无效。" );
}

function parseUpdateInput(rawInput: unknown, nowUtc: number):
  | { ok: true; reminderId: string; content?: string; localDateTime?: string; scheduledAtUtc?: number }
  | ReminderFailure {
  if (!isRecord(rawInput) || rawInput.schema_version !== 1 || !isRecord(rawInput.request)) {
    return failure("invalid_input", "修改提醒提案格式无效。");
  }
  const request = rawInput.request;
  if (request.kind !== "reminder.update" || typeof request.reminder_id !== "string") {
    return failure("unsupported_request", "修改提案只能引用一条既有提醒。");
  }
  const reminderId = request.reminder_id.toLowerCase();
  if (!UUID_PATTERN.test(reminderId)) return failure("invalid_input", "提醒标识格式无效。");
  const hasContent = Object.prototype.hasOwnProperty.call(request, "content");
  const content = hasContent ? normalizeContent(request.content) : undefined;
  if (hasContent && !content) return failure("invalid_input", "提醒内容需为 1 至 200 个可见字符。");
  let localDateTime: string | undefined;
  let scheduledAtUtc: number | undefined;
  if (Object.prototype.hasOwnProperty.call(request, "schedule")) {
    if (!isRecord(request.schedule)
      || request.schedule.timezone !== REMINDER_TIMEZONE
      || typeof request.schedule.local_date_time !== "string") {
      return failure("invalid_input", "修改时间必须使用 Asia/Shanghai 和明确的本地日期时间。");
    }
    const parsedTime = parseShanghaiLocalDateTime(request.schedule.local_date_time);
    if (!parsedTime) return failure("invalid_input", "修改时间必须是有效的 YYYY-MM-DDTHH:mm。");
    if (parsedTime.atUtc < nowUtc + MIN_LEAD_SECONDS) {
      return failure("invalid_input", "修改时间必须至少在当前时间 1 分钟之后。");
    }
    if (parsedTime.atUtc > nowUtc + MAX_HORIZON_SECONDS) {
      return failure("invalid_input", "首版提醒最多可设置到 366 天内。");
    }
    localDateTime = parsedTime.localDateTime;
    scheduledAtUtc = parsedTime.atUtc;
  }
  if (!hasContent && scheduledAtUtc === undefined) {
    return failure("invalid_input", "至少要提供新的提醒内容或时间。");
  }
  return {
    ok: true,
    reminderId,
    ...(content !== undefined ? { content } : {}),
    ...(localDateTime !== undefined ? { localDateTime } : {}),
    ...(scheduledAtUtc !== undefined ? { scheduledAtUtc } : {}),
  };
}

function parseCommitInput(rawInput: unknown): { ok: true; input: { proposalId: string; payloadHash: string } } | ReminderFailure {
  if (!isRecord(rawInput) || typeof rawInput.proposal_id !== "string" || typeof rawInput.payload_hash !== "string") {
    return failure("invalid_input", "确认参数格式无效。" );
  }
  const proposalId = rawInput.proposal_id.toLowerCase();
  const payloadHash = rawInput.payload_hash.toLowerCase();
  if (!UUID_PATTERN.test(proposalId) || !/^[a-f0-9]{64}$/u.test(payloadHash)) {
    return failure("invalid_input", "确认标识或内容校验码格式无效。" );
  }
  return { ok: true, input: { proposalId, payloadHash } };
}

function parseStoredCreatePayload(raw: string): { content: string; scheduledAtUtc: number } | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.kind !== "reminder.create" || typeof parsed.content !== "string" || !isRecord(parsed.schedule)) {
      return undefined;
    }
    const scheduledAtUtc = parsed.schedule.atUtc;
    if (typeof scheduledAtUtc !== "number" || !Number.isSafeInteger(scheduledAtUtc) || scheduledAtUtc < 0) {
      return undefined;
    }
    const content = normalizeContent(parsed.content);
    return content ? { content, scheduledAtUtc } : undefined;
  } catch {
    return undefined;
  }
}

function parseStoredCancelPayload(raw: string): { reminderId: string } | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) && parsed.kind === "reminder.cancel" && typeof parsed.reminderId === "string" && UUID_PATTERN.test(parsed.reminderId)
      ? { reminderId: parsed.reminderId.toLowerCase() }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStoredUpdatePayload(raw: string): {
  reminderId: string;
  base: { content: string; scheduledAtUtc: number; cronJobId: string; retryStatus: "scheduled" };
  next: { content: string; scheduledAtUtc: number };
} | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.kind !== "reminder.update"
      || typeof parsed.reminderId !== "string" || !UUID_PATTERN.test(parsed.reminderId)
      || !isRecord(parsed.base) || !isRecord(parsed.next) || !isRecord(parsed.next.schedule)) return undefined;
    const baseContent = normalizeContent(parsed.base.content);
    const nextContent = normalizeContent(parsed.next.content);
    const baseScheduledAtUtc = parsed.base.scheduledAtUtc;
    const nextScheduledAtUtc = parsed.next.schedule.atUtc;
    const cronJobId = parsed.base.cronJobId;
    if (!baseContent || !nextContent
      || typeof baseScheduledAtUtc !== "number" || !Number.isSafeInteger(baseScheduledAtUtc) || baseScheduledAtUtc < 0
      || typeof nextScheduledAtUtc !== "number" || !Number.isSafeInteger(nextScheduledAtUtc) || nextScheduledAtUtc < 0
      || typeof cronJobId !== "string" || cronJobId.length < 1 || cronJobId.length > 500
      || parsed.base.retryStatus !== "scheduled") return undefined;
    return {
      reminderId: parsed.reminderId.toLowerCase(),
      base: { content: baseContent, scheduledAtUtc: baseScheduledAtUtc, cronJobId, retryStatus: "scheduled" },
      next: { content: nextContent, scheduledAtUtc: nextScheduledAtUtc },
    };
  } catch {
    return undefined;
  }
}

function parseShanghaiLocalDateTime(value: string): { localDateTime: string; atUtc: number } | undefined {
  const match = LOCAL_DATETIME_PATTERN.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  if (!yearText || !monthText || !dayText || !hourText || !minuteText) return undefined;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    calendarCheck.getUTCFullYear() !== year
    || calendarCheck.getUTCMonth() !== month - 1
    || calendarCheck.getUTCDate() !== day
    || calendarCheck.getUTCHours() !== hour
    || calendarCheck.getUTCMinutes() !== minute
  ) return undefined;
  const atUtc = Math.floor(Date.parse(`${value}:00+08:00`) / 1000);
  return Number.isSafeInteger(atUtc) && atUtc >= 0 ? { localDateTime: value, atUtc } : undefined;
}

function normalizeContent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.length >= 1 && normalized.length <= MAX_CONTENT_LENGTH ? normalized : undefined;
}

function canCancel(
  status: ReminderStatus,
  retryStatus: "scheduling" | "scheduled" | "pending" | "delivered" | "cancelled" | "exhausted" | "unknown" | undefined,
): boolean {
  // A scheduling attempt has an indeterminate Gateway outcome; allowing a
  // concurrent cancel could leave an untracked Cron job. Wait for reconciliation
  // to resolve it before offering cancellation.
  if (retryStatus === undefined || retryStatus === "unknown" || retryStatus === "scheduling") return false;
  if (status === "scheduled") return retryStatus === "scheduled";
  return status === "failed" && (retryStatus === "pending" || retryStatus === "exhausted");
}

function canUpdate(
  reminder: StoredReminder,
  retryStatus: "scheduling" | "scheduled" | "pending" | "delivered" | "cancelled" | "exhausted" | "unknown" | undefined,
): boolean {
  return reminder.status === "scheduled" && retryStatus === "scheduled" && Boolean(reminder.cronJobId);
}

function sameUpdateBase(
  reminder: StoredReminder,
  base: { content: string; scheduledAtUtc: number; cronJobId: string; retryStatus: "scheduled" },
): boolean {
  return reminder.content === base.content
    && reminder.scheduledAtUtc === base.scheduledAtUtc
    && reminder.cronJobId === base.cronJobId;
}

function sameDelivery(left: ReminderDelivery, right: ReminderDelivery): boolean {
  return left.channel === right.channel && left.to === right.to && left.accountId === right.accountId;
}

function requestContextHash(kind: ReminderProposalKind, payloadHash: string, delivery: ReminderDelivery): string {
  return sha256(`${REMINDER_SUBJECT_ID}|${kind}|${payloadHash}|${delivery.channel}|${delivery.to}|${delivery.accountId ?? ""}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function failure(code: ReminderFailure["error"]["code"], message: string): ReminderFailure {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatShanghaiDateTime(atUtc: number): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: REMINDER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = new Map(formatter.formatToParts(new Date(atUtc * 1000)).map((part) => [part.type, part.value]));
  return `${parts.get("year") ?? ""}-${parts.get("month") ?? ""}-${parts.get("day") ?? ""} ${parts.get("hour") ?? ""}:${parts.get("minute") ?? ""}`;
}
