export interface TraceContext {sessionKey?: string | undefined; sessionId?: string | undefined;}
export function createToolTrace(names: string[], now?: () => number): {
  attach(api: any): void;
  resolve(ctx: TraceContext, callId: string, name: string): string | undefined;
};
