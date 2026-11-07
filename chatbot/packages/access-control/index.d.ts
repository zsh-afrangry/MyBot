export interface Actor {id:string;key:string;kind:'user';owner:boolean;agentId:string;sessionKey:string;accountId:'default'}
export class AccessError extends Error {code:string;constructor(code?:string)}
export function assertToolAccess(ctx:unknown,cfg:unknown,name:string,args?:unknown):Actor;
export interface Subject {qq:string;role:'owner'|'member';enabled:boolean;permissions:Record<string,boolean>}
export function activeSubject(cfg:unknown,qq:string,permission:string):Subject;
export function primaryOwner(cfg:unknown):Subject;
export function sessionFor(subject:Subject):string;
