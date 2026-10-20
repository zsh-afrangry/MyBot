import fs from 'node:fs';
import path from 'node:path';
import {accessPolicy, authorizedOwner, targetSubject} from '../../../packages/access-control/index.js';
export const CHANNEL='kurumi-qq';
export function account(cfg, id='default') {
 if(id&&id!=='default')throw Error('Unknown QQ account');
 const s=cfg.channels?.[CHANNEL];
 if(!s?.enabled)throw Error('QQ channel disabled');
 if(!/^\d{5,12}$/.test(s.ownerId))throw Error('Missing owner');
 accessPolicy(s);
 for(const [key,protocol] of [['httpUrl','http:'],['wsUrl','ws:']]){
  const u=new URL(s[key]);if(u.hostname!=='127.0.0.1'||u.protocol!==protocol||u.username||u.password||u.search)throw Error('Only loopback OneBot endpoints allowed');
 }
 if(!path.isAbsolute(s.stateDir))throw Error('Absolute isolated stateDir required');
 return {...s,accountId:'default'};
}
export function ownerTarget(to,a){
 return targetSubject(to,a).qq;
}
export function token(a,kind){
 const file=kind==='ws'?a.wsTokenFile:a.httpTokenFile;
 if(!path.isAbsolute(file))throw Error('Absolute token file required');
 const stat=fs.statSync(file);if(stat.mode&0o077)throw Error('Token file must be owner-only');
 const value=fs.readFileSync(file,'utf8').trim();if(!value)throw Error('Missing OneBot credential');return value;
}

export function ownerAuthorized(ctx,cfg,permission){
 return authorizedOwner(ctx,cfg,permission);
}
