export interface Actor {id:string;key:string;kind:'user';owner:boolean;agentId:string;sessionKey:string;accountId:'default'}
export class AccessError extends Error {code:string;constructor(code?:string)}
export function assertToolAccess(ctx:unknown,cfg:unknown,name:string,args?:unknown):Actor;
