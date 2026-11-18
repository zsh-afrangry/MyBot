import {mdToPlain,splitForQQ} from './vendor/md-to-plain.js';
// Short conversational paragraphs become 2–3 messages. Reports and code retain their structure.
export function presentForQQ(raw,max=1200,natural=true){
 const text=mdToPlain(raw),paragraphs=text.split(/\n\n/u);
 const structured=/```|^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)|https?:\/\//mu.test(raw);
 if(natural&&!structured&&text.length<=600&&paragraphs.length>=2&&paragraphs.length<=3&&paragraphs.every(p=>p.trim().length>0&&p.length<=Math.min(max,240)))return {pieces:paragraphs,paced:true};
 return {pieces:splitForQQ(text,max),paced:false};
}
