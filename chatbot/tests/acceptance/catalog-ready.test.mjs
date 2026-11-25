import test from 'node:test';
import assert from 'node:assert/strict';
import {readPluginCatalog,waitForPluginStates} from './catalog-ready.mjs';

test('catalog waits for a replaced plugin generation and returns the next result',async()=>{
 let calls=0;
 const result=await readPluginCatalog(async (method,params)=>{
  assert.equal(method,'tools.catalog');assert.deepEqual(params,{agentId:'main',includePlugins:true});
  if(++calls===1)throw Error('Plugin catalog generation is no longer available');
  return {groups:[]};
 },{timeoutMs:1000,retryDelayMs:1});
 assert.equal(calls,2);assert.deepEqual(result,{groups:[]});
});

test('catalog immediately reports unrelated errors and bounds repeated generation failures',async()=>{
 let calls=0;
 await assert.rejects(readPluginCatalog(async()=>{calls++;throw Error('other failure');}),/other failure/);
 assert.equal(calls,1);
 await assert.rejects(readPluginCatalog(async()=>{throw Error('Plugin catalog generation is no longer available');},{timeoutMs:3,retryDelayMs:1}),/generation is no longer available/);
});

test('plugin readiness waits for the requested runtime state without accepting unloaded services',async()=>{
 let calls=0;
 const result=await waitForPluginStates(async()=>({plugins:[{id:'coding',runtime:{state:++calls===1?'unloaded':'active'}}]}),{coding:['active']},{timeoutMs:1000,retryDelayMs:1});
 assert.equal(calls,2);assert.equal(result.plugins[0].runtime.state,'active');
 await assert.rejects(waitForPluginStates(async()=>({plugins:[]}),{coding:['active']},{timeoutMs:1,retryDelayMs:1}),/did not settle/);
});
