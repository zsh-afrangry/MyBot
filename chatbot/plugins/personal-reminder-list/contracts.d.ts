/** Synchronous domain contracts. Transport identity is checked outside Policy. */
export type Action = 'add'|'update'|'complete'|'void'|'reopen'|'schedule'|'pause'|'resume';
export interface ListRequest {
  raw: string; at: number; messageId: string; sessionKey: string; sessionId?: string;
  /** Default-policy admission hints, not transport credentials. */
  actions: ReadonlySet<Action>; continuation?: boolean;
}
export interface ListCommand {
  action: Action; id?: string; query?: string; expectedVersion?: number;
  title?: string; content?: string|null; note?: string|null; ddl?: string|null; times?: string[];
}
export interface Item {
  id: string; title: string; content: string|null; note: string|null; ddl: string|null;
  deadlineMs: number|null; status: 'active'|'completed'|'void'|'expired'; version: number;
  createdAt: string; updatedAt: string;
}
export interface Fields {
  title: string; content: string|null; note: string|null; ddl: string|null; deadlineMs: number|null; status?: Item['status'];
}
export interface Row {
  id: string; title: string; content: string|null; note: string|null; ddl: string|null;
  deadline_ms: number|null; status: Item['status']; version: number; created_ms: number; updated_ms: number;
}
export interface Policy {
  intent(ctx: object, owner: string, event: object, now: number): {actions: Iterable<Action>}|undefined;
  hasListName(raw: string): boolean;
  wantsContinuousEntry(raw: string): boolean;
  isContinuationCandidate(raw: string): boolean;
  isStandaloneReminder(raw: string): boolean;
  authorize(request: ListRequest, action: Action): void;
  checkText(value: string|null, request: ListRequest): void;
  checkFacts(fields: Fields, request: ListRequest, checkDeadline?: boolean): void;
  checkSchedule(request: ListRequest): void;
}
export interface StoreOptions {root: string; ownerId: string; now?: () => number; defaultTimes?: string[]}
export interface Settings {ownerId: string; times: string[]; enabled: boolean; version: number; timezone: string}
export interface Context {messageId?: string; sessionKey?: string; runId?: string}
export interface Rejected {ok: false; error: {code: string; message: string}; candidates?: Item[]}
export interface Changed {ok: true; action: Action; item?: Item; settings?: Settings}
/** All mutations + audit + replay ledger must commit/rollback together. */
export interface Store {
  now(): number; close(): void;
  transaction<T>(work: () => T): T;
  expire(): number;
  settings(): Settings;
  get(args?: {history?: boolean; query?: string}): {ok: true; now: string; timezone: string; settings: Settings; items: Item[]};
  /** Unique target and current expectedVersion MUST be checked in this transaction. */
  select(args: ListCommand): Row|Rejected;
  request(key: string): {payload_hash: string; result_json: string}|undefined;
  recordRequest(key: string, hash: string, result: Changed): void;
  changeSchedule(args: ListCommand, context: Context): Changed;
  addItem(fields: Fields, context: Context): Changed;
  changeItem(args: ListCommand, row: Row, fields: Fields, context: Context): Changed;
  claimDigest(time: string): {slotKey: string; text: string; count: number}|undefined;
  observeDeliveries(job: {id: string; time: string}, runs: object[]): void;
  markUnobserved(): void;
}
