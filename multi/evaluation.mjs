import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {PYTHON} from '../src/paths.mjs';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function replayClosure(directory) {
  const rows=[];
  function walk(dir) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(entry.isSymbolicLink())throw Error('Delivered source contains a symbolic link');
      if(entry.isDirectory()) {
        if(!entry.name.startsWith('.')&&!['__marimo__','__pycache__'].includes(entry.name))walk(path.join(dir,entry.name));
      } else if(entry.isFile()&&entry.name.endsWith('.py')) {
        const file=path.join(dir,entry.name);rows.push({path:path.relative(directory,file).split(path.sep).join('/'),sha256:hash(file)});
      }
    }
  }
  walk(directory);return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
export async function evaluateAssembly(projectRoot, attempt, {timeout=600}={}) {
  const work=path.join(projectRoot,attempt.attempt_dir);
  const notebook=path.join(work,'out/product.py');
  const originalInputs=path.join(work,'input/assembly-inputs.json');
  const revision=crypto.randomUUID();
  const evalInputs=path.join(work,'input',`assembly-inputs.eval-${revision}.json`);
  const ir=path.join(projectRoot,'assembly.ir.json');
  const out=path.join(work,'evaluation',revision);
  if(attempt.inputs_sha256 && hash(originalInputs)!==attempt.inputs_sha256)throw Error('Original assembly input snapshot was modified');
  const original=JSON.parse(fs.readFileSync(originalInputs));
  if(original.assembly_ir_sha256!==hash(ir))throw Error('Source assembly IR changed');
  for(const row of original.files||[]){const file=path.resolve(path.dirname(originalInputs),row.path);if(!file.startsWith(path.dirname(originalInputs)+path.sep)||fs.realpathSync(file)!==file||hash(file)!==row.sha256)throw Error('Assembly input file hash mismatch: '+row.path);}
  const manifest={...original,replay_files:replayClosure(path.dirname(notebook))};
  if(!manifest.replay_files.some(row=>row.path==='product.py'))throw Error('No product.py in output source tree');
  const encoded=JSON.stringify(manifest,null,2)+'\n';
  if(fs.existsSync(evalInputs)) {
    if(fs.readFileSync(evalInputs,'utf8')!==encoded)throw Error('Evaluation snapshot has changed; create a new assembly attempt');
  } else fs.writeFileSync(evalInputs,encoded,{flag:'wx',mode:0o600});
  const verdictFile=path.join(out,'verdict.json');
  if(!fs.existsSync(verdictFile)) {
    const python=process.env.CAD_CODE_PYTHON||PYTHON;
    const runner=path.join(import.meta.dirname,'assemblyeval.py');
    const args=[runner,'--assembly-ir',ir,'--inputs',evalInputs,'--notebook',notebook,'--out',out,'--timeout',String(timeout)];
    await new Promise((resolve,reject)=>{
      const child=spawn(python,args,{stdio:['ignore','ignore','pipe'],env:{...process.env,CUDA_VISIBLE_DEVICES:''}});
      let errorText='',error;child.stderr.on('data',data=>{errorText=(errorText+data).slice(-4000);});
      child.once('error',value=>{error=value;});
      const timer=setTimeout(()=>child.kill('SIGTERM'),(timeout+90)*1000);
      child.once('close',code=>{clearTimeout(timer);if(error)return reject(error);if(!fs.existsSync(verdictFile))return reject(Error('Assembly evaluation failed without a verdict: '+code+' '+errorText));resolve();});
    });
  }
  const verdict=JSON.parse(fs.readFileSync(verdictFile));
  if(verdict.schema_version!=='assembly-verdict-v1')throw Error('Invalid assembly verdict schema');
  for(const [key,file] of Object.entries({assembly_ir_sha256:ir,notebook_sha256:notebook,inputs_sha256:evalInputs})) {
    if(verdict[key]!==hash(file))throw Error('Assembly verdict hash mismatch: '+key);
  }
  return {verdict,path:path.relative(projectRoot,verdictFile),out:path.relative(projectRoot,out)};
}
