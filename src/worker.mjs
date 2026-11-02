// Executed inside the macOS process sandbox. JSON lines on stdin/stdout are RPC.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {inside} from './paths.mjs';
const cwd = process.env.CAD_CODE_WORK;
const readOnlyRoots=JSON.parse(process.env.CAD_CODE_READONLY||'[]');
const sessions = new Map();
let nextSession = 1;
function record(event) {fs.appendFileSync(path.join(cwd, '.cad-events.jsonl'), JSON.stringify({time:new Date().toISOString(),...event})+'\n');}
function stop(job,force=false) {try {process.kill(-job.child.pid,force?'SIGKILL':'SIGTERM');} catch(e){if(e.code!=='ESRCH')record({kind:'command_stop_error',id:job.id,error:e.message});}}
function sliceOutput(job, maxTokens=10000) {
  const output = job.output.slice(job.cursor);job.cursor=job.output.length;
  const cap = Math.max(256, Math.min(100000, Number(maxTokens)||10000))*4;
  return output.length > cap ? output.slice(0,cap)+`\n[Output clipped: ${output.length-cap} characters; complete command output is saved in .cad-events.jsonl]` : output;
}
async function observe(job, args) {
  const start=Date.now(), wait=Math.max(1,Math.min(30000,Number(args.yield_time_ms)||10000));
  if (!job.done) await Promise.race([job.finished,new Promise(r=>setTimeout(r,wait))]);
  return {output:sliceOutput(job,args.max_output_tokens),exit_code:job.done?job.exitCode:null,...(!job.done?{session_id:job.id}:{}),wall_time_seconds:(Date.now()-start)/1000};
}
const descriptions = [
  {name:'exec_command',description:'Run a shell command in the CAD workspace. Arguments: cmd:string, workdir?:string, yield_time_ms?:number (default10000, max30000), max_output_tokens?:number, login?:boolean. Returns output/exit_code or session_id for a running process. Use text(result) to preserve session IDs. Noninteractive stdin is EOF.'},
  {name:'write_stdin',description:'Poll or write to a running command. Arguments: session_id:number, chars?:string, yield_time_ms?:number, max_output_tokens?:number.'},
  {name:'apply_patch',description:'Apply an exact *** Begin Patch / Add File / Update File / Delete File / *** End Patch patch. Pass the complete patch as one string.'},
  {name:'view_image',description:'Load a PNG/JPEG without resizing. Arguments: path:string, detail?:"original"|"high"|"low"|"auto". Returns image_url and detail. Emit it with const r=await tools.view_image({path:"out/model.png"}); image(r.image_url, r.detail). A read without image() does not show an image.'}
];
const tools = {
  async exec_command(args) {
    if (!args || typeof args.cmd!=='string') throw Error('exec_command requires cmd:string');
    if (args.tty) throw Error('PTY mode is not implemented in this local prototype; use a noninteractive command and poll session_id.');
    const work=inside(cwd,args.workdir||'.');
    const id=nextSession++;
    const child=spawn(args.shell||'/bin/bash',[args.login?'-lc':'-c',args.cmd],{cwd:work,env:process.env,detached:true,stdio:['pipe','pipe','pipe']});
    const job={id,child,output:'',cursor:0,done:false,exitCode:null};
    job.finished=new Promise(resolve=>{
      child.on('error',e=>{job.output+=e.message;job.done=true;job.exitCode=127;resolve();});
      child.on('close',(code,signal)=>{job.done=true;job.exitCode=code??(signal?130:1);clearTimeout(job.timer);record({kind:'command_complete',id,cmd:args.cmd,output:job.output,exit_code:job.exitCode});resolve();});
    });
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',x=>{job.output+=x;record({kind:'command_chunk',id,stream:'stdout',text:x});});
    child.stderr.on('data',x=>{job.output+=x;record({kind:'command_chunk',id,stream:'stderr',text:x});});
    // Tools are noninteractive by default. Heredocs are interpreted by the shell.
    child.stdin.end();
    job.timer=setTimeout(()=>stop(job),120000);job.timer.unref();sessions.set(id,job);
    return await observe(job,args);
  },
  async write_stdin(args) {
    const job=sessions.get(Number(args.session_id));if(!job)throw Error('Unknown session_id');
    if(args.chars==='\u0003')stop(job);
    else if(args.chars)throw Error('This noninteractive process has stdin=EOF; use a new command or Ctrl-C.');
    return await observe(job,args);
  },
  async apply_patch(patch) {return applyPatch(patch);},
  async view_image(args) {
    let p;try{p=inside(cwd,args.path);}catch(e){p=readOnlyRoots.map(root=>{try{return inside(root,args.path);}catch{return null;}}).find(Boolean);if(!p)throw e;}
    const type=/\.png$/i.test(p)?'image/png':/\.jpe?g$/i.test(p)?'image/jpeg':null;
    if(!type)throw Error('Only PNG and JPEG are supported');
    const b=fs.readFileSync(p);if(b.length>12*1024*1024)throw Error('Image exceeds12MiB');
    if(args.detail!==undefined&&!['original','high','low','auto'].includes(args.detail))throw Error('Unsupported image detail');
    return {image_url:`data:${type};base64,${b.toString('base64')}`,filename:path.basename(p),...(args.detail?{detail:args.detail}:{})};
  }
};
function applyPatch(patch) {
  if(typeof patch!=='string'||!patch.startsWith('*** Begin Patch\n')||!patch.trimEnd().endsWith('*** End Patch'))throw Error('Invalid patch framing');
  const lines=patch.replace(/\r\n/g,'\n').split('\n'),changes=[];
  for(let i=1;i<lines.length;) {
    const m=lines[i].match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);if(!m){if(lines[i]==='*** End Patch')break;throw Error('Unexpected patch line: '+lines[i]);}
    const [,kind,name]=m,p=inside(cwd,name);i++;
    const body=[];while(i<lines.length&&(!lines[i].startsWith('*** ')||lines[i]==='*** End of File'))body.push(lines[i++]);
    if(kind==='Add'){
      if(fs.existsSync(p))throw Error('Add target already exists: '+name);
      if(body.some(x=>!x.startsWith('+')))throw Error('Every Add File line must start with +');
      changes.push({p,name,text:body.map(x=>x.slice(1)).join('\n')+'\n'});
    } else if(kind==='Delete') {if(!fs.existsSync(p))throw Error('Delete target missing');changes.push({p,name,remove:true});}
    else {
      let source=fs.readFileSync(p,'utf8'),hunks=[],hunk=[];
      for(const line of body){if(line.startsWith('@@')){if(hunk.length)hunks.push(hunk);hunk=[];}else if(line!=='*** End of File')hunk.push(line);}
      if(hunk.length)hunks.push(hunk);
      for(const h of hunks){
        if(h.some(x=>!/^[-+ ]/.test(x)))throw Error('Invalid Update File hunk');
        const before=h.filter(x=>x[0]!=='+' ).map(x=>x.slice(1)).join('\n');
        const after=h.filter(x=>x[0]!=='-').map(x=>x.slice(1)).join('\n');
        if(!before||source.indexOf(before)<0)throw Error('Patch context not found: '+name);
        if(source.indexOf(before)!==source.lastIndexOf(before))throw Error('Ambiguous patch context: '+name);
        source=source.replace(before,after);
      }
      changes.push({p,name,text:source});
    }
  }
  for(const change of changes){if(change.remove)fs.unlinkSync(change.p);else{fs.mkdirSync(path.dirname(change.p),{recursive:true});fs.writeFileSync(change.p,change.text);}}
  return {output:changes.map(x=>(x.remove?'Deleted ':'Wrote ')+x.name).join('\n')};
}
async function execute({id,code}) {
  const output=[],attachments=[],content=[],views=new Map(),timers=new Set(),pending=new Set();let closed=false,fatal=false,imageBytes=0;
  const text=value=>{const body=typeof value==='string'?value:JSON.stringify(value);output.push(body);content.push({type:'input_text',text:body});};
  const image=(value,detail)=>{
    const url=typeof value==='string'?value:value?.image_url;
    if(!/^data:image\/(png|jpeg);base64,/.test(url||''))throw Error('image() requires a view_image result');
    const hint=views.get(url),selectedDetail=detail??value?.detail??hint?.detail;
    if(selectedDetail!==undefined&&!['original','high','low','auto'].includes(selectedDetail))throw Error('Unsupported image detail');
    const bytes=Buffer.from(url.split(',')[1],'base64').length;
    if(attachments.length>=16||imageBytes+bytes>48*1024*1024)throw Error('ImageOutputBudgetExceeded: maximum16 images and48MiB per exec; no image was resized or silently dropped');
    imageBytes+=bytes;
    content.push({type:'input_image',image_url:url,...(selectedDetail?{detail:selectedDetail}:{})});
    attachments.push({type:'file',mime:url.slice(5,url.indexOf(';')),url,filename:value?.filename||hint?.filename||'image.png'});
  };
  try {
    record({kind:'exec_start',id,code});
    const scopedTools=Object.fromEntries(Object.entries(tools).map(([name,fn])=>[name,async(...args)=>{
      if(closed)throw Error('exec context already completed');
      const p=fn(...args);pending.add(p);try{const result=await p;if(name==='view_image')views.set(result.image_url,result);return result;}finally{pending.delete(p);}
    }]));
    const schedule=(fn,ms,...args)=>{if(closed)throw Error('exec context already completed');const id=setTimeout(()=>{timers.delete(id);if(!closed)fn(...args);},ms);timers.add(id);return id;};
    const context=vm.createContext({tools:scopedTools,ALL_TOOLS:descriptions,text,image,console:{log:text},setTimeout:schedule,clearTimeout:id=>{timers.delete(id);clearTimeout(id);}});
    const script=new vm.Script('(async()=>{\n'+code+'\n})()',{filename:'agent-exec.js'});
    let timeout;
    try {await Promise.race([script.runInContext(context,{timeout:2000}),new Promise((_,reject)=>{timeout=setTimeout(()=>{fatal=true;reject(Error('exec timed out after120seconds; execution worker will be terminated'));},120000);})]);}
    finally {clearTimeout(timeout);}
    if(pending.size){fatal=true;throw Error('Unawaited subtool calls remain; await all tool calls before exec completes');}
    const result={output:output.join('\n')||(attachments.length?'':'(completed; use text() to print tool results)'),attachments,content};
    record({kind:'exec_complete',id,...result});return {id,result};
  }catch(e){const error=e.name+': '+e.message;content.push({type:'input_text',text:error});const result={output:output.join('\n')+'\n'+error,attachments,content,error:true};record({kind:'exec_error',id,...result});return {id,result,fatal};}
  finally{closed=true;for(const timer of timers)clearTimeout(timer);}
}
const input=readline.createInterface({input:process.stdin});
let chain=Promise.resolve();
input.on('line',line=>{chain=chain.then(async()=>{let request;try{request=JSON.parse(line);const response=await execute(request);process.stdout.write(JSON.stringify(response)+'\n',()=>{if(response.fatal)process.exit(1);});}catch(e){process.stdout.write(JSON.stringify({id:request?.id,result:{error:true,output:e.name+': '+e.message}})+'\n');}});});
input.on('close',()=>{for(const job of sessions.values())stop(job,true);process.exit(0);});
process.on('exit',()=>{for(const job of sessions.values())stop(job,true);});
