// Synthetic input references only staged test media, with actual model/QQ egress.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {rpc,ready} from './rpc.mjs';
await ready();
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot,sendPayload} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
import {freshMessageId} from './lib/fresh-id.mjs';
const cfg=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/openclaw.json')),a=account(cfg);
const login=await onebot(a,'get_login_info',{});
const db=new DatabaseSync(`${a.stateDir}/channel.sqlite`,{readOnly:true});const prior=db.prepare("SELECT message_id FROM outbound WHERE status='sent' ORDER BY at LIMIT 1").get();db.close();
const report={boundary:'Synthetic quoted/image input -> real model; staged local image. Real QQ output, not live human image upload.',startedAt:new Date().toISOString()};
try{
 const event={post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:freshMessageId(),time:Math.floor(Date.now()/1000),message:[{type:'reply',data:{id:prior.message_id}},{type:'text',data:{text:'这是授权的合成引用与图片验收。请以【融合验收】开头，用一句话复述引用消息的核心内容，再用一句话描述实际图片中的形状或文字；如果图片未实际加载就如实说未看到。不要调用工具，不要增加其他内容。'}},{type:'image',data:{file:`${a.mediaRoot}/snowluma-logo.png`}}]};
 report.inbound=await rpc('kurumi-qq.testInbound',{event});
 report.imageSend=await sendPayload({cfg,to:`user:${a.ownerId}`,text:'【融合验收】新频道原生图片与引用投递测试。',mediaUrl:`${a.mediaRoot}/snowluma-logo.png`,replyToId:prior.message_id,key:'live-media-20261005'});
}catch(e){report.error=e.message;process.exitCode=1;}
fs.writeFileSync('/home/afrangry/kurumi-fusion/docs/verification/fusion/03-native-media.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
