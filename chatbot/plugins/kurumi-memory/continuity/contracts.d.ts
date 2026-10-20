/** Document 25 P2. Backends own persistence; policies do not establish identity. */
export interface Source {origin:'current_owner'|'legacy_explicit'; messageId:string; sessionKey:string; sessionId:string; runId:string; at:string; rawHash:string; evidence:string}
export interface Fact {id:string; text:string; kind:'fact'|'preference'; createdAt:string; updatedAt:string; source:Source}
export interface Summary extends Omit<Fact,'kind'> {kind:'interaction_summary'; expiresAt:string}
export interface State {version:2; ownerId:string; revision:number; generation:number; facts:Fact[]; summaries:Summary[]; barriers:object[]; receipts:object[]; importedFrom:object|null}
export interface StoreOptions {workspace:string; ownerId:string; readonly?:boolean}
export interface Store {read():State; write(next:State,expectedRevision:number):State; close():void}
export interface Policy {evidence(text:string,request:object):string; fact(text:string,evidence:string):string; summary(text:string):string}
