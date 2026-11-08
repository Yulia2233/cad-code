import readline from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function parseDataCommand(args){
  if(args[0]==='list'){if(args.length!==1)throw Error('Use cad-code list');return {action:'list'};}
  if(args[0]==='export'){
    const id=args[1];if(!/^ses_[A-Za-z0-9_-]+$/.test(id||''))throw Error('Use cad-code export SESSION_ID [--output FILE|-] [--force]');
    let output,force=false;
    for(let i=2;i<args.length;i++){
      if(['--output','-o'].includes(args[i])){output=args[++i];if(!output||output.startsWith('--'))throw Error(args[i-1]+' requires a file path or -');}
      else if(args[i]==='--force')force=true;
      else throw Error('Use cad-code export SESSION_ID [--output FILE|-] [--force]');
    }
    if(output==='-'&&force)throw Error('--force cannot be used with stdout output');
    return {action:'export',id,output,force};
  }
  if(args[0]!=='delete')return null;
  const [_,scope,id,...flags]=args;
  if(!['workspace','conversation'].includes(scope)||!/^ses_[A-Za-z0-9_-]+$/.test(id||'')||flags.some(x=>x!=='--yes'))throw Error('Use cad-code delete workspace|conversation SESSION_ID [--yes]');
  return {action:'delete',scope,id,yes:flags.includes('--yes')};
}

export async function manageCLI(connection,command){
  if(!connection.website)throw Error('Restart the backend once to enable data management');
  if(command.action==='export'){
    const response=await fetch(connection.website+'/api/sessions/'+encodeURIComponent(command.id)+'/export');
    if(!response.ok){let message='Could not export conversation (HTTP '+response.status+')';try{const value=await response.json();if(value.error)message=value.error;}catch{}throw Error(message);}
    let trajectory;try{trajectory=await response.json();}catch{throw Error('Export endpoint returned invalid JSON');}
    if(!trajectory||trajectory.schema_version!=='cad-code-session-v2'||trajectory.id!==command.id||!Array.isArray(trajectory.messages)||!trajectory.messages.every(x=>x&&typeof x==='object'&&Array.isArray(x.parts))||!Array.isArray(trajectory.tool_media))throw Error('Export endpoint returned an incomplete trajectory');
    const contents=JSON.stringify(trajectory,null,2)+'\n';
    const toolParts=trajectory.messages.flatMap(message=>message.parts).filter(part=>part.type==='tool');
    const toolResults=toolParts.filter(part=>part.state&&(part.state.output!==undefined||part.state.error!==undefined));
    if(command.output==='-'){
      await new Promise((resolve,reject)=>process.stdout.write(contents,error=>error?reject(error):resolve()));
      return;
    }
    const target=path.resolve(command.output||`${command.id}.json`),directory=path.dirname(target),temporary=path.join(directory,'.'+path.basename(target)+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp');
    try{
      fs.writeFileSync(temporary,contents,{flag:'wx',mode:0o600});
      if(command.force)fs.renameSync(temporary,target);
      else{fs.linkSync(temporary,target);fs.unlinkSync(temporary);}
    }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    console.log(`已导出 ${trajectory.messages.length} 条消息、${toolParts.length} 次工具调用（${toolResults.length} 条含结果）、${trajectory.tool_media.length} 份工具媒体：${target}`);
    return;
  }
  const response=await fetch(connection.website+'/api/data');if(!response.ok)throw Error('Could not read data inventory');
  const {items,config_token}=await response.json();
  if(command.action==='list'){
    for(const item of items)console.log(`${item.id}\t对话:${item.hasConversation?'有':'无'}\t工作区:${item.hasWorkspace?'有':'无'}\t${item.files}文件\t${item.bytes}B\t${item.title}`);
    return;
  }
  const selected=items.find(x=>x.id===command.id);if(!selected)throw Error('Session/workspace not found');
  if(command.scope==='conversation'&&!selected.hasConversation)throw Error('Conversation not found; the workspace can be deleted separately');
  if(!command.yes){
    if(!process.stdin.isTTY)throw Error('Deletion requires confirmation in a terminal, or an explicit --yes');
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    try{
      const message=command.scope==='workspace'?'删除工作区文件，保留对话和轨迹':'删除此对话及其子评审轨迹，保留工作区文件';
      const answer=await rl.question(`${message}：${command.id}？输入 yes 确认：`);
      if(answer.trim()!=='yes'){console.log('已取消。');return;}
    }finally{rl.close();}
  }
  const result=await fetch(connection.website+'/api/sessions/'+command.id+'/'+command.scope,{method:'DELETE',headers:{'content-type':'application/json','x-cad-config-token':config_token},body:JSON.stringify({confirm:command.id})});
  const value=await result.json();if(!result.ok)throw Error(value.error||'Deletion failed');
  console.log(command.scope==='workspace'?'工作区已清理，对话和轨迹保留。':'对话和轨迹已删除，工作区文件保留。');
  if(value.unknown?.length)console.log('有 '+value.unknown.length+' 项归属不明或损坏的记录保留，未误删。');
}
