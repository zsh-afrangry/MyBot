// Current-turn images are staged through Host media storage, never arbitrary URL fetch.
import fs from 'node:fs';
import {localImage,onebot} from './transport.js';
const CDN=new Set(['gchat.qpic.cn','c2cpicdw.qpic.cn','multimedia.nt.qq.com','multimedia.nt.qq.com.cn','p.qpic.cn']);
export function qqImageUrl(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||!CDN.has(url.hostname))throw Error('Unsupported QQ media source');
 return url.href;
}
// With Clash/sing-box fake-IP DNS the QQ CDN hosts resolve to RFC 2544
// (198.18.0.0/15) and the default strict guard rejects them before the proxy
// can route the request.  Allow that range only for the exact CDN host of this
// URL (same approach as personal-weather 6faea7a); no other private range, no
// other host and no redirects.
export function qqMediaFetchPolicy(value){
 const host=new URL(qqImageUrl(value)).hostname;
 return {allowRfc2544BenchmarkRange:true,allowIpv6UniqueLocalRange:true,hostnameAllowlist:[host]};
}
export async function stageImage(segment,a){
 const {saveMediaBuffer,saveResponseMedia}=await import('openclaw/plugin-sdk/media-runtime');
 const d=segment.data??{};
 if(typeof d.file==='string'&&(d.file.startsWith('/')||d.file.startsWith('file://'))){
  const validated=localImage(d.file,a);const bytes=Buffer.from(validated.data.file.slice(9),'base64');
  const saved=await saveMediaBuffer(bytes,undefined,'inbound',8*1024*1024);
  if(!saved.contentType?.startsWith('image/'))throw Error('Not image media');return saved;
 }
 const url=qqImageUrl(d.url);
 const {fetchWithSsrFGuard}=await import('openclaw/plugin-sdk/ssrf-runtime');
 let guarded;
 try{
  guarded=await fetchWithSsrFGuard({url,init:{method:'GET',redirect:'manual'},requireHttps:true,maxRedirects:0,mode:'trusted_env_proxy',policy:qqMediaFetchPolicy(url),timeoutMs:15000,capture:false,auditContext:'kurumi-qq:media'});
  const res=guarded.response;
  if(res.status>=300&&res.status<400)throw Error('QQ media redirect refused');
  const saved=await saveResponseMedia(res,{sourceUrl:url,maxBytes:8*1024*1024,subdir:'inbound'});
  if(!saved.contentType?.startsWith('image/'))throw Error('Not image media');return saved;
 }finally{await guarded?.release();}
}
export async function quoteText(id,a,selfId,peerId=a.ownerId){
 if(!/^-?[1-9]\d*$/.test(String(id)))return null;
 const m=await onebot(a,'get_msg',{message_id:Number(id)});
 const from=String(m.sender?.user_id??m.user_id),to=String(m.target_id);
 if(m.message_type!=='private'||!((from===peerId&&to===String(selfId))||(from===String(selfId)&&to===peerId)))return null;
 return (m.message??[]).filter(x=>x.type==='text').map(x=>String(x.data?.text??'')).join('').slice(0,4000);
}
