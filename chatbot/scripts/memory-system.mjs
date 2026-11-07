#!/usr/bin/env node
// Operator-only memory migration/rollback. Preview default; --apply changes private SQLite and notice.
// Stop Fusion writers before --apply. Backups stay in the operator-selected unified private backup root.
import {migrateMemoryV3,rollbackMemoryV3} from '../plugins/kurumi-memory/system/migration.js';
import {spawnSync} from 'node:child_process';
const args=Object.fromEntries(process.argv.slice(2).map(v=>{if(v==='--apply')return ['apply',true];const m=/^--([a-z-]+)=(.+)$/.exec(v);if(!m)throw Error('Use --workspace= --owner= --backup-root= [--apply --expected-hash=] or --rollback= --expected-revision=');return [m[1],m[2]];}));
if(Object.keys(args).some(k=>!['workspace','owner','backup-root','apply','expected-hash','rollback','expected-revision'].includes(k)))throw Error('Unknown memory operator option');
if(args.apply && args.workspace==='/home/afrangry/.openclaw-fusion/workspace' && spawnSync('systemctl',['--user','is-active','--quiet','kurumi-fusion.service']).status===0)throw Error('Stop Fusion writers before applying memory migration/rollback');
const options={workspace:args.workspace,ownerId:args.owner,backupRoot:args['backup-root'],apply:args.apply===true};
const result=args.rollback?rollbackMemoryV3({...options,backup:args.rollback,expectedRevision:Number(args['expected-revision'])}):migrateMemoryV3({...options,expectedStateHash:args['expected-hash']});
console.log(JSON.stringify(result,null,2));
