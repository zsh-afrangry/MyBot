import fs from 'node:fs';
const state='/home/afrangry/.openclaw-fusion';
process.env.OPENCLAW_STATE_DIR=state;
process.env.OPENCLAW_CONFIG_PATH=`${state}/openclaw.json`;
const env=JSON.parse(fs.readFileSync(`${state}/runtime-env.json`));Object.assign(process.env,env);
const {callGatewayFromCli}=await import('openclaw/plugin-sdk/gateway-runtime');
export const rpc=(method,params={},timeout=90000)=>callGatewayFromCli(method,{url:'ws://127.0.0.1:18890',token:env.OPENCLAW_GATEWAY_TOKEN,timeout:String(timeout),json:true},params);
