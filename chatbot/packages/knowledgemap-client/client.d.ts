export class BridgeError extends Error { code: string; status: number; toJSON(): object; }
export interface ClientOptions {baseUrl?: string; tokenFile?: string; timeoutMs?: number; fetchImpl?: typeof fetch; trace?: (event: object) => void;}
export interface RequestOptions {method?: 'GET' | 'POST'; query?: Record<string, unknown>; body?: unknown; key?: string; runId?: string; signal?: AbortSignal;}
export class KnowledgeMapClient {
  constructor(options?: ClientOptions);
  request(path: string, options?: RequestOptions): Promise<any>;
  allTasks(options?: {history?: boolean; query?: string; signal?: AbortSignal; runId?: string}): Promise<any[]>;
}
export function requestKey(domain: string, request: {sessionKey: string; messageId: string}): string;
export function clientFromEnvironment(env?: Record<string, string | undefined>): KnowledgeMapClient;
