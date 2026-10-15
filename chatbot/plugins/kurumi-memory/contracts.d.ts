/** Facts are untrusted reference data; Policy does not establish owner identity. */
export interface Entry {id: string; text: string; updatedAt?: string; source?: string}
export interface Memory {version: 1; revision: number; entries: Entry[]}
export interface Command {action: 'upsert'|'delete'; id?: string; text?: string}
export interface Request {
  raw: string; at: number; messageId?: string; verb?: string;
  used?: boolean; key?: string; result?: object;
}
export interface Policy {
  intent(ctx: object, owner: string, event: object): {verb?: string}|undefined;
  authorize(action: Command['action'], request: Request): void;
  checkText(text: string, request: Request): void;
  checkTarget(args: Command, existing: Entry|undefined, request: Request): void;
}
export interface StoreOptions {workspace: string}
export interface Store {
  read(): Memory;
  /** Compare revision under lock, validate facts, then replace atomically. */
  write(data: {entries: Entry[]}, expectedRevision: number): Memory;
  close(): void;
}
