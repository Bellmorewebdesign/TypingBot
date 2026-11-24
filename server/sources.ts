import { mkdir, readdir, stat, rename, rm, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile),limit=500000000,active=new Set<string>();
const error=(m,status=400)=>Object.assign(Error(m),{status});
const idPattern=/^[a-f0-9-]{36}$/;
function dir(id){if(!idPattern.test(id))throw error('Invalid source collection.');return join('data','sources',id);}
export async function upload(req,id,name){
  const path=dir(id);
  if(!/\.(pdf|txt|md)$/i.test(name)||name.length>150)throw error('Use a PDF, TXT or Markdown file.');
  if(active.has(id))throw error('Another file is uploading.',409);
  active.add(id);const key=randomUUID(),temp=join(tmpdir(),'typingbot-'+key);
  try{
    await mkdir(path,{recursive:true});
    let total=0;
    for(const file of await readdir(path)) total+=(await stat(join(path,file))).size;
    await pipeline(req,new Transform({transform(chunk,enc,cb){total+=chunk.length;cb(total>limit?error('500 MB project limit reached.',413):null,chunk);}}),createWriteStream(temp,{flags:'wx'}));
    const safe=name.replace(/[^a-z0-9 ._-]/gi,'_');
    // Copy across filesystems via stream, publish only complete files.
    const dest=join(path,key+'_'+safe);
    const {copyFile}=await import('node:fs/promises');
    try{await copyFile(temp,dest+'.part');await rename(dest+'.part',dest);}finally{await rm(dest+'.part',{force:true});}
    return {name:safe};
  }finally{active.delete(id);await rm(temp,{force:true});}
}
export async function excerpts(id,brief) {
  if(!id)return '';
  const path=dir(id),words=new Set(brief.toLowerCase().match(/[a-z0-9]{3,}/g)||[]);
  let best=[];
  for(const file of (await readdir(path).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(f=>!f.endsWith('.part'))){
    const filename=file.slice(37),full=join(path,file);
    let src='';
    if(/\.pdf$/i.test(file)){
      try{src=(await exec('pdftotext',['-f','1','-l','40',full,'-'],{timeout:15000,maxBuffer:3e6})).stdout;}catch{throw error('Unable to read PDF '+filename+'. Try pasted reference text.');}
    }else{
      const {open}=await import('node:fs/promises');const f=await open(full);
      try{const buf=Buffer.alloc(512000);const {bytesRead}=await f.read(buf,0,buf.length,0);src=buf.toString('utf8',0,bytesRead);}finally{await f.close();}
    }
    if(!src.trim())throw error('No readable text in '+filename+'. Paste an excerpt.');
    let page=0;
    for(const body of src.split('\f')){page++;for(let i=0;i<body.length;i+=1400){
      const t=body.slice(i,i+1400);if(!t.trim())continue;
      const low=t.toLowerCase(),score=[...words].reduce((n,w)=>n+Number(low.includes(w)),0);
      best.push({score,text:filename+(/\.pdf$/i.test(file)?' p.'+page:'')+'\n'+t});best.sort((a,b)=>b.score-a.score);best.length=Math.min(best.length,4);
    }}
  }
  return best.map(e=>e.text).join('\n\n');
}
