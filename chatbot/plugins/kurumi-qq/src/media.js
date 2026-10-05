// Current-turn images are staged through Host media storage, never arbitrary URL fetch.
import fs from 'node:fs';
import {localImage,onebot} from './transport.js';
const CDN=new Set(['gchat.qpic.cn','c2cpicdw.qpic.cn','multimedia.nt.qq.com','multimedia.nt.qq.com.cn','p.qpic.cn']);
export function qqImageUrl(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||!CDN.has(url.hostname))throw Error('Unsupported QQ media source');
 return url.href;
}
export async function stageImage(segment,a){
 const {saveMediaBuffer,saveRemoteMedia}=await import('openclaw/plugin-sdk/media-runtime');
 const d=segment.data??{};
 if(typeof d.file==='string'&&(d.file.startsWith('/')||d.file.startsWith('file://'))){
  const validated=localImage(d.file,a);const bytes=Buffer.from(validated.data.file.slice(9),'base64');
  const saved=await saveMediaBuffer(bytes,undefined,'inbound',8*1024*1024);
  if(!saved.contentType?.startsWith('image/'))throw Error('Not image media');return saved;
 }
 const url=qqImageUrl(d.url);
 const saved=await saveRemoteMedia({url,requireHttps:true,maxRedirects:0,maxBytes:8*1024*1024,timeoutMs:15000,subdir:'inbound'});
 if(!saved.contentType?.startsWith('image/'))throw Error('Not image media');return saved;
}
export async function quoteText(id,a,selfId){
 if(!/^-?[1-9]\d*$/.test(String(id)))return null;
 const m=await onebot(a,'get_msg',{message_id:Number(id)});
 const from=String(m.sender?.user_id??m.user_id),to=String(m.target_id);
 if(m.message_type!=='private'||!((from===a.ownerId&&to===String(selfId))||(from===String(selfId)&&to===a.ownerId)))return null;
 return (m.message??[]).filter(x=>x.type==='text').map(x=>String(x.data?.text??'')).join('').slice(0,4000);
}
