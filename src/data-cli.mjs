import readline from 'node:readline/promises';

export function parseDataCommand(args){
  if(args[0]==='list'){if(args.length!==1)throw Error('Use cad-code list');return {action:'list'};}
  if(args[0]!=='delete')return null;
  const [_,scope,id,...flags]=args;
  if(!['workspace','conversation'].includes(scope)||!/^ses_[A-Za-z0-9_-]+$/.test(id||'')||flags.some(x=>x!=='--yes'))throw Error('Use cad-code delete workspace|conversation SESSION_ID [--yes]');
  return {action:'delete',scope,id,yes:flags.includes('--yes')};
}

export async function manageCLI(connection,command){
  if(!connection.website)throw Error('Restart the backend once to enable data management');
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
