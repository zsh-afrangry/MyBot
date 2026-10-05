// Authorized synthetic ingress -> actual Host/model -> actual owner-only QQ egress.
// This is not evidence of a human-originated live QQ inbound message.
import fs from 'node:fs';
import {rpc,ready} from './rpc.mjs';
await ready();
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
import {freshMessageId} from './lib/fresh-id.mjs';
const cfg=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/openclaw.json'));
const a=account(cfg),login=await onebot(a,'get_login_info',{});
const event={post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:freshMessageId(),time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'这是开发者授权的合成入站测试，不是用户实际发来的新消息。请仅回复这一句：【融合验收】OpenClaw 已通过新的 QQ 频道生成这条回复。不要调用工具，不要增加其他内容。'}}]};
const report={boundary:'Synthetic owner event via operator.admin test RPC; real installed Gateway, model and real QQ output; not live human inbound',startedAt:new Date().toISOString()};
try{report.result=await rpc('kurumi-qq.testInbound',{event});report.repeat=await rpc('kurumi-qq.testInbound',{event});}catch(e){report.error=e.message;process.exitCode=1;}
fs.writeFileSync('/home/afrangry/kurumi-fusion/docs/verification/fusion/01-native-inbound.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
