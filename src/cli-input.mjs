import fs from 'node:fs';
import path from 'node:path';
import {WORKSPACE,sessionDir} from './paths.mjs';

function assertNoSymlinks(absolute) {
  const parsed=path.parse(absolute);let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    if(fs.lstatSync(current).isSymbolicLink())throw Error('Refusing symlink in import path: '+current);
  }
}
function secureDirectory(directory) {
  if(!fs.existsSync(directory))fs.mkdirSync(directory,{recursive:true,mode:0o700});
  assertNoSymlinks(directory);
  if(!fs.statSync(directory).isDirectory())throw Error('Import directory is not a directory');
}
function destination(input,name) {
  const ext=path.extname(name),stem=name.slice(0,name.length-ext.length);
  for(let n=1;n<=10000;n++){
    const filename=n===1?name:`${stem}-${n}${ext}`,absolute=path.join(input,filename);
    try{return {absolute,filename,fd:fs.openSync(absolute,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600)};}
    catch(e){if(e.code!=='EEXIST')throw e;}
  }
  throw Error('Too many files with the same import name');
}

/** Copy explicit CLI file inputs into one session; never move/overwrite source files.
 * Returns input-relative paths ready to append to the task message.
 * Symlinks in source/destination paths are rejected, as are directories/special files.
 */
export function importFiles(sessionID,paths,{maxBytes=32*1024*1024}={}) {
  const work=sessionDir(sessionID);
  if(!Array.isArray(paths)||!paths.length)return [];
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw Error('Invalid import size limit');
  const sources=[],created=[];
  try{
    for(const original of paths){
      if(typeof original!=='string'||!original.trim())throw Error('Input file path is empty');
      const absolute=path.resolve(original);assertNoSymlinks(absolute);
      const fd=fs.openSync(absolute,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);sources.push({fd,absolute});
      const stat=fs.fstatSync(fd);if(!stat.isFile())throw Error('Input must be a regular file: '+original);
      if(stat.size>maxBytes)throw Error(`Input exceeds ${Math.round(maxBytes/1024/1024)} MiB: ${path.basename(absolute)}`);
    }
    secureDirectory(WORKSPACE);secureDirectory(work);const input=path.join(work,'input');secureDirectory(input);
    for(const source of sources){
      const target=destination(input,path.basename(source.absolute));created.push(target.absolute);
      try{
        const buffer=Buffer.alloc(64*1024);let bytes,total=0;
        while((bytes=fs.readSync(source.fd,buffer,0,buffer.length,null))>0){
          total+=bytes;if(total>maxBytes)throw Error('Input grew beyond import size limit');
          let offset=0;while(offset<bytes)offset+=fs.writeSync(target.fd,buffer,offset,bytes-offset);
        }
      }finally{fs.closeSync(target.fd);}
    }
    return created.map(p=>'input/'+path.basename(p));
  }catch(e){for(const p of created){try{fs.unlinkSync(p);}catch{}}throw e;}
  finally{for(const {fd} of sources){try{fs.closeSync(fd);}catch{}}}
}
