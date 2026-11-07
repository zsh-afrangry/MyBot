export type NoticeRequest = {subjectId:string;agentId:string;sessionKey:string;to:string;accountId:string};
export type ComposeInput = {facts:unknown;request:NoticeRequest;sourceTool:string;instructions:string;required?:string[];check?:()=>void;signal?:AbortSignal};
export type Composer = (input:ComposeInput)=>Promise<{text:string;runId:string}>;
export function createAssistantComposer(options:{runtime:unknown;config:()=>any;timeoutMs?:number}):Composer;
export function assistantText(result:unknown,options?:{required?:string[];maxChars?:number}):string;
export function visibleAssistantReply(payload:any,info:{kind:string}):boolean;
export function withFacts(text:string,facts:string[]):string;
export function requestAssistantNotice(method:string,params:Record<string,unknown>,options?:{env?:NodeJS.ProcessEnv;request?:(method:string,params:Record<string,unknown>)=>Promise<any>}):Promise<{text?:string}>;
