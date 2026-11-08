#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT,RUNTIME,WORKSPACE} from './paths.mjs';
import {importFiles} from './cli-input.mjs';
import {configureCLI} from './config-cli.mjs';
import {savedProviderFile} from './provider-config.mjs';
import {parseDataCommand,manageCLI} from './data-cli.mjs';
const argv=process.argv.slice(2);
if(argv[0]==='ask'){
  try{const {askCLI}=await import('./ask-cli.mjs');await askCLI(argv.slice(1));}
  catch(e){console.error(e.message);process.exitCode=e.exitCode||1;}
  process.exit(process.exitCode||0);
}
if(argv.includes('--help')||argv.includes('-h')){
  console.log(`CAD Code · OpenCode terminal agent\n\n  ./cad-code                         打开交互终端\n  ./cad-code --continue              继续上次会话\n  ./cad-code --session ses_...        打开指定会话\n  ./cad-code --file target.step      复制输入文件并打开终端\n  ./cad-code ask "问题"              独立单轮请求，只输出答案\n  ./cad-code run "任务"              执行一项任务并显示工具与思考\n  ./cad-code --mini                  使用紧凑终端界面\n  ./cad-code config                  配置 Base URL、模型名和隐藏的 API key\n  ./cad-code config --show           查看地址与密钥是否已配置\n  ./cad-code config --thinking on|off 控制模型思考\n  ./cad-code list                    列出对话与工作区\n  ./cad-code export SESSION_ID       导出完整对话/工具轨迹 JSON\n  ./cad-code delete workspace ID     清理工作区，保留轨迹\n  ./cad-code delete conversation ID  删除对话/轨迹，保留文件\n  ./cad-code --credentials PATH      指定已有API配置文件\n  ./cad-code --web                   启动网页；CLI可同时连接\n\n默认模型 qwen-v8；完整 SimpleCADAPI2.2.7 skill。\n会话保存在 cad-code/.runtime，建模文件在 cad-code/workspace/<会话ID>/。`);process.exit(0);
}
if(argv[0]==='config'){try{await configureCLI(argv.slice(1));}catch(e){console.error(e.message);process.exitCode=1;}process.exit(process.exitCode||0);}
const pass=[],inputFiles=[];let credentials;
for(let i=0;i<argv.length;i++){
  if(argv[i]==='--credentials'||argv[i]==='--file'||argv[i]==='-f'){
    const flag=argv[i],value=argv[++i];if(!value||value.startsWith('--'))throw Error(flag+' requires a path');
    if(flag==='--credentials')credentials=path.resolve(value);else inputFiles.push(path.resolve(value));
  }else pass.push(argv[i]);
}
const dataCommand=parseDataCommand(pass);if(dataCommand&&inputFiles.length)throw Error('Data management cannot import files');
if(pass.includes('--continue')&&pass.includes('--session'))throw Error('Choose --continue or --session');
const mode=dataCommand?'data':pass[0]==='run'?'run':pass.includes('--web')?'web':'tui';
if(mode!=='web'&&mode!=='data'&&!credentials&&!process.env.CAD_CODE_CREDENTIALS&&!savedProviderFile()){
  if(process.stdin.isTTY)await configureCLI([]);
  else throw Error('Provide --credentials PATH, run cad-code config, or open cad-code --web to configure API.');
}
fs.mkdirSync(RUNTIME,{recursive:true});
const link=path.join(RUNTIME,'cli-connection.json');let connection,server,ownsBackend=false;
async function existing(){try{const x=JSON.parse(fs.readFileSync(link));process.kill(x.pid,0);const r=await fetch(x.url+'/global/health',{headers:{authorization:'Basic '+Buffer.from('opencode:'+x.password).toString('base64')},signal:AbortSignal.timeout(1200)});if(r.ok)return x;}catch{}return null;}
connection=await existing();
if(connection&&credentials)throw Error('A CAD Code backend is already running. Stop it before changing API credentials.');
if(!connection){
  const lock=path.join(RUNTIME,'startup.lock');let acquired=false;
  for(let i=0;i<140;i++){
    try{fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'pid'),String(process.pid));acquired=true;break;}
    catch(e){if(e.code!=='EEXIST')throw e;let stale=false;try{const pid=Number(fs.readFileSync(path.join(lock,'pid')));try{process.kill(pid,0);}catch{stale=true;}}catch{stale=Date.now()-fs.statSync(lock).mtimeMs>2000;}if(stale){fs.rmSync(lock,{recursive:true,force:true});continue;}connection=await existing();if(connection)break;await new Promise(r=>setTimeout(r,250));}
  }
  if(!connection&&!acquired)throw Error('Another CAD Code instance is still starting. Try again shortly.');
  if(acquired){
    const log=fs.openSync(path.join(RUNTIME,'launcher.log'),'a');
    server=spawn(process.execPath,[path.join(ROOT,'src/server.mjs'),'--managed-cli','--web',...(credentials?['--credentials',credentials]:[])],{cwd:ROOT,env:process.env,stdio:['ignore',log,log]});ownsBackend=true;
    const release=()=>{try{if(fs.readFileSync(path.join(lock,'pid'),'utf8')===String(process.pid))fs.rmSync(lock,{recursive:true,force:true});}catch{}};
    server.on('exit',release);process.on('exit',release);
  }
}
let child,stopping=false;
function cleanup(){if(stopping)return;stopping=true;if(child&&!child.killed)child.kill('SIGTERM');if(ownsBackend)server.kill('SIGTERM');}
process.on('SIGTERM',cleanup);process.on('SIGINT',()=>{if(!child)cleanup();});
const fatal=e=>{console.error(e?.message||String(e));process.exitCode=1;cleanup();setTimeout(()=>process.exit(1),100);};
process.on('uncaughtException',fatal);process.on('unhandledRejection',fatal);
for(let i=0;!connection&&i<120;i++){
  if(server.exitCode!==null)throw Error('CAD backend startup failed. See cad-code/.runtime/launcher.log');
  try{const x=JSON.parse(fs.readFileSync(link));if(x.pid===server.pid){connection=x;break;}}catch{}
  await new Promise(r=>setTimeout(r,250));
}
if(!connection){cleanup();throw Error('CAD backend startup timed out. See .runtime/launcher.log');}
if(dataCommand){
  try{await manageCLI(connection,dataCommand);}finally{cleanup();if(ownsBackend)await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.on('exit',resolve);setTimeout(resolve,2000);});}
  process.exit(0);
}
if(inputFiles.length){
  const oc=async(route,method='GET',body)=>{const r=await fetch(connection.url+route,{method,headers:{authorization:'Basic '+Buffer.from('opencode:'+connection.password).toString('base64'),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('OpenCode '+r.status);return await r.json();};
  let sessionID;const i=pass.indexOf('--session');
  if(i>=0){sessionID=pass[i+1];await oc('/session/'+sessionID);}
  else if(pass.includes('--continue')){const list=await oc('/session');sessionID=list.filter(x=>!x.parentID).sort((a,b)=>b.time.updated-a.time.updated)[0]?.id;if(!sessionID)throw Error('No previous session');pass.splice(pass.indexOf('--continue'),1);pass.push('--session',sessionID);}
  else{const s=await oc('/session','POST',{title:'CAD 输入 · '+path.basename(inputFiles[0])});sessionID=s.id;pass.push('--session',sessionID);}
  const imports=importFiles(sessionID,inputFiles);console.log('输入已复制到 '+path.join(WORKSPACE,sessionID)+': '+imports.join(', '));
  if(mode==='run')pass.push('\nThe input files have been copied to the session workspace: '+imports.join(', ')+ '. Use these relative paths.');
}
console.log('\n  CAD Code · '+(connection.model||'qwen-v8')+' · SimpleCADAPI2.2.7 · 思考'+(connection.thinking===false?'关闭':'开启')+'\n  exec(code) · 本地CAD工作区 · Ctrl+C/Esc 按OpenCode界面操作\n');
const env={...process.env,OPENCODE_SERVER_PASSWORD:connection.password,OPENCODE_SERVER_USERNAME:'opencode',OPENCODE_CONFIG:path.join(RUNTIME,'opencode.json'),OPENCODE_CONFIG_DIR:path.join(RUNTIME,'xdg/config'),XDG_CONFIG_HOME:path.join(RUNTIME,'xdg/config'),XDG_DATA_HOME:path.join(RUNTIME,'xdg/data'),XDG_STATE_HOME:path.join(RUNTIME,'xdg/state'),XDG_CACHE_HOME:path.join(RUNTIME,'xdg/cache'),OPENCODE_DISABLE_CLAUDE_CODE:'true'};
let command;
if(mode==='run')command=['run','--attach',connection.url,'--dir',WORKSPACE,'--agent','cad-code','--model','cad-local/'+(connection.routingModel||connection.model||'qwen-v8'),'--thinking',...pass.slice(1)];
else if(mode==='web'){
  console.log('可选网页: '+connection.website+'\n按Ctrl+C退出。');
  if(!ownsBackend)process.exit(0);
  process.on('SIGINT',cleanup);await new Promise(resolve=>server.on('exit',resolve));process.exit(0);
}else{
  const kv=path.join(RUNTIME,'xdg/state/opencode/kv.json');fs.mkdirSync(path.dirname(kv),{recursive:true});let preferences={};try{preferences=JSON.parse(fs.readFileSync(kv));}catch{}preferences.thinking_mode='show';const temp=kv+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(preferences),{mode:0o600});fs.renameSync(temp,kv);
  command=['attach',connection.url,'--dir',WORKSPACE,...pass];
}
child=spawn(process.env.OPENCODE_BIN||'opencode',command,{cwd:WORKSPACE,env,stdio:'inherit'});
const code=await new Promise(resolve=>{child.on('error',e=>{console.error(e.message);resolve(1);});child.on('exit',c=>resolve(c??0));});
cleanup();if(ownsBackend)await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.on('exit',resolve);setTimeout(resolve,2000);});
process.exit(code);
