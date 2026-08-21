import { createHash, randomUUID } from "node:crypto";

import type { SearchErrorCode } from "./errors.js";

export interface SearchQuotaSnapshot {
  minuteCount: number;
  dayCount: number;
  inFlight: number;
}

export interface SearchAuditEvent {
  event: "personal-search.audit";
  requestId: string;
  queryHash: string;
  queryLength: number;
  provider: "deepseek-search";
  elapsedMs: number;
  resultCount: number;
  status: "OK" | SearchErrorCode;
  quota: SearchQuotaSnapshot;
}

export function createSearchAuditEvent(input: {
  query: string;
  elapsedMs: number;
  resultCount: number;
  status: "OK" | SearchErrorCode;
  quota: SearchQuotaSnapshot;
}): SearchAuditEvent {
  return {
    event: "personal-search.audit",
    requestId: randomUUID(),
    queryHash: hashSearchQuery(input.query),
    queryLength: [...input.query].length,
    provider: "deepseek-search",
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    resultCount: Math.max(0, Math.floor(input.resultCount)),
    status: input.status,
    quota: {
      minuteCount: input.quota.minuteCount,
      dayCount: input.quota.dayCount,
      inFlight: input.quota.inFlight,
    },
  };
}

export function hashSearchQuery(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}
