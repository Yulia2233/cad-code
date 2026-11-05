import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {ROOT,REPO,RUNTIME,PYTHON,SKILL,sessionDir} from './paths.mjs';
import {prepareSessionWorkspace} from './workspace.mjs';
export {prepareSessionWorkspace} from './workspace.mjs';
const workers=new Map();
const quote=s=>JSON.stringify(s);
export function sandboxProfile(work,readOnlyRoots=[]) {
  const nodePath=fs.realpathSync(process.env.CAD_CODE_NODE||process.execPath);
  const pythonRoot=path.dirname(path.dirname(PYTHON));
  const envInfo=path.join(RUNTIME,'python-environment.json');let libraryRoots=[];try{libraryRoots=JSON.parse(fs.readFileSync(envInfo)).library_roots||[];}catch{}
  const read=['/System','/Library','/usr','/bin','/sbin','/dev','/opt/homebrew','/private/etc','/private/var/db',path.dirname(nodePath),path.join(ROOT,'src'),path.join(ROOT,'tools'),pythonRoot,...(fs.existsSync(pythonRoot)?[fs.realpathSync(pythonRoot)]:[]),path.join(REPO,'envs/cad226'),SKILL,work,...libraryRoots,...readOnlyRoots];
  return `(version 1)\n(deny default)\n(allow process-fork)\n(allow process-exec)\n(allow signal (target self) (target children))\n(allow sysctl-read)\n(allow mach-lookup)\n(allow file-read-metadata)\n(allow file-read* (literal "/") ${read.map(x=>'(subpath '+quote(x)+')').join(' ')})\n(allow file-write* (subpath ${quote(work)}) (literal "/dev/null") (literal "/dev/tty"))\n`;
}
function worker(sessionID,readOnlyRoots=[]) {
  if(workers.has(sessionID))return workers.get(sessionID);
  const work=prepareSessionWorkspace(sessionID);
  for(const d of ['.tmp','.home'])fs.mkdirSync(path.join(work,d),{recursive:true});
  const env={PATH:path.dirname(PYTHON)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(work,'.home'),TMPDIR:path.join(work,'.tmp'),LANG:'en_US.UTF-8',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',OMP_NUM_THREADS:'2',MPLCONFIGDIR:path.join(work,'.tmp/mpl'),SIMPLECAD_VTK_RENDER_LOCK:path.join(work,'.tmp/vtk-render.lock'),CAD_CODE_WORK:work,CAD_CODE_READONLY:JSON.stringify(readOnlyRoots),CAD_CODE_PYTHON:PYTHON,CAD_CODE_SKILL:SKILL};
  const child=spawn('/usr/bin/sandbox-exec',['-p',sandboxProfile(work,readOnlyRoots),process.env.CAD_CODE_NODE||process.execPath,path.join(ROOT,'src/worker.mjs')],{cwd:work,env,stdio:['pipe','pipe','pipe']});
  const w={child,pending:new Map(),seq:0,stderr:''};workers.set(sessionID,w);
  child.stderr.on('data',b=>{w.stderr+=b;});
  readline.createInterface({input:child.stdout}).on('line',line=>{
    let r;try{r=JSON.parse(line);}catch{return;}
    if(r.fatal){if(workers.get(sessionID)===w)workers.delete(sessionID);child.stdin.end();}
    const p=w.pending.get(r.id);if(p){clearTimeout(p.timer);w.pending.delete(r.id);p.resolve(r.result);}
  });
  const fail=e=>{if(workers.get(sessionID)===w)workers.delete(sessionID);for(const p of w.pending.values()){clearTimeout(p.timer);p.reject(e);}w.pending.clear();};
  child.stdin.on('error',fail);
  child.on('error',fail);child.on('close',(code,signal)=>fail(Error(`CAD execution worker stopped (${code??signal}): `+w.stderr.slice(-1500))));
  return w;
}
export async function executeCode(sessionID,code,signal,readOnlyRoots=[]) {
  if(typeof code!=='string'||!code.trim())throw Error('exec requires nonempty code');
  const w=worker(sessionID,readOnlyRoots),id=++w.seq;
  return await new Promise((resolve,reject)=>{
    const abort=()=>{w.child.stdin.end();reject(Error('Execution cancelled'));};
    if(signal?.aborted)return abort();
    const timer=setTimeout(()=>{w.child.kill();reject(Error('Execution worker deadline exceeded'));},125000);
    const done=v=>{signal?.removeEventListener('abort',abort);resolve(v);};
    w.pending.set(id,{resolve:done,reject,timer});signal?.addEventListener('abort',abort,{once:true});
    w.child.stdin.write(JSON.stringify({id,code})+'\n');
  });
}
export function stopSession(id){const w=workers.get(id);if(w){workers.delete(id);w.child.stdin.end();}}
export function stopWorkers(){for(const w of workers.values())w.child.stdin.end();}
const cancellationDir=path.join(RUNTIME,'cancel');fs.mkdirSync(cancellationDir,{recursive:true});
const watcher=fs.watch(cancellationDir,(_,id)=>{if(typeof id==='string'&&/^ses_[\w-]+$/.test(id))stopSession(id);});watcher.unref();
