import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,RUNTIME,WORKSPACE,PYTHON,SKILL} from './paths.mjs';

export const MAIN_PROMPT_MARKER='[CAD_CODE_TEMPLATE_ROLE:cad-code]';
export const REVIEW_PROMPT_MARKER='[CAD_CODE_TEMPLATE_ROLE:cad-review]';
const known=new Set(['MODEL_NAME','MODEL_ID','WORKING_DIRECTORY','WORKSPACE_ROOT','IS_GIT_REPO','PLATFORM','CURRENT_DATE','SESSION_WORKSPACE','PYTHON','SKILL_DIR','TOOLS_DIR','INPUT_FILE_LIST','PARENT_OUT']);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

function placeholders(template){
  const names=[];
  for(const m of template.matchAll(/\{\{([^{}]*)\}\}/g)){
    if(!/^[A-Z][A-Z0-9_]*$/.test(m[1]))throw Error('PromptTemplateError: invalid placeholder '+m[0]);
    names.push(m[1]);
  }
  if(template.replace(/\{\{[^{}]*\}\}/g,'').includes('{{'))throw Error('PromptTemplateError: unclosed placeholder');
  return names;
}
export function renderTemplate(template,values){
  if(typeof template!=='string'||!template.trim())throw Error('PromptTemplateError: empty template');
  for(const name of placeholders(template))if(!Object.hasOwn(values,name)||values[name]===undefined||values[name]===null)throw Error('PromptTemplateError: missing value '+name);
  // A single literal pass: dynamic values are never interpreted as a template,
  // JavaScript or replacement patterns such as $&.
  return template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g,(_,name)=>String(values[name]));
}
function section(markdown,heading){
  const lines=markdown.replace(/\r\n/g,'\n').split('\n'),matches=lines.map((line,i)=>line===heading?i:-1).filter(i=>i>=0);
  if(matches.length!==1)throw Error('PromptTemplateError: missing or duplicate section '+heading);
  const start=matches[0]+1,level=heading.match(/^#+/)[0].length;
  let end=start;while(end<lines.length&&!new RegExp('^#{1,'+level+'} ').test(lines[end]))end++;
  return lines.slice(start,end).join('\n');
}
function englishBlock(text,expectedFences,label){
  const blocks=[...text.matchAll(/^```text\n([\s\S]*?)^```\s*$/gm)];
  if(blocks.length!==expectedFences||!blocks[0][1].trim())throw Error('PromptTemplateError: missing or duplicate English text block in '+label);
  return blocks[0][1].trimEnd();
}
export function extractRuntimeTemplates(markdown){
  return {
    base:englishBlock(section(markdown,'## English'),1,'English'),
    inputFiles:englishBlock(section(markdown,'### Explicitly supplied session files / 本会话显式提供的文件'),2,'input files'),
    review:englishBlock(section(markdown,'### Independent cad-review session / 独立 cad-review 会话'),2,'cad-review')
  };
}
export function loadPromptTemplates(templateDir=path.join(ROOT,'docs')){
  const system=fs.readFileSync(path.join(templateDir,'system-prompt.en.md'),'utf8').trimEnd();
  const markdown=fs.readFileSync(path.join(templateDir,'runtime-prompt.md'),'utf8');
  const runtime=extractRuntimeTemplates(markdown);
  for(const template of [system,...Object.values(runtime)])for(const name of placeholders(template))if(!known.has(name))throw Error('PromptTemplateError: unknown placeholder '+name);
  return {system,...runtime,templateHashes:{system:sha(system),runtime:sha(markdown)}};
}
function dateText(now){
  const values=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',weekday:'short',month:'short',day:'2-digit',year:'numeric'}).formatToParts(now).map(x=>[x.type,x.value]));
  return `${values.weekday} ${values.month} ${values.day} ${values.year}`;
}
function checkedSession(id,workspace){
  if(!/^ses_[A-Za-z0-9_-]+$/.test(id||''))throw Error('PromptTemplateError: invalid session ID');
  return path.join(workspace,id);
}
export function compileSessionPrompts({sessionID,model,parentID,agent='cad-code',now=new Date(),root=ROOT,runtime=RUNTIME,workspace=WORKSPACE,python=PYTHON,skill=SKILL,templateDir=path.join(root,'docs')}={}){
  if(!['cad-code','cad-review'].includes(agent))throw Error('PromptTemplateError: unsupported agent role');
  const cwd=checkedSession(sessionID,workspace),providerID=model?.providerID,modelID=model?.id;
  if(!providerID||!modelID||!(model.api?.id||modelID))throw Error('PromptTemplateError: missing actual model identity');
  const templates=loadPromptTemplates(templateDir),inputs=path.join(cwd,'input');
  const names=fs.existsSync(inputs)?fs.readdirSync(inputs,{withFileTypes:true}).filter(x=>x.isFile()).map(x=>x.name).sort():[];
  const values={MODEL_NAME:model.api?.id||modelID,MODEL_ID:`${providerID}/${modelID}`,WORKING_DIRECTORY:cwd,WORKSPACE_ROOT:cwd,IS_GIT_REPO:fs.existsSync(path.join(cwd,'.git'))?'yes':'no',PLATFORM:process.platform,CURRENT_DATE:dateText(now),SESSION_WORKSPACE:cwd,PYTHON:python,SKILL_DIR:skill,TOOLS_DIR:path.join(root,'tools'),INPUT_FILE_LIST:names.map(name=>JSON.stringify('input/'+name)).join(', '),PARENT_OUT:agent==='cad-review'?path.join(checkedSession(parentID,workspace),'out'):''};
  const additions=[];
  if(names.length)additions.push(renderTemplate(templates.inputFiles,values));
  if(agent==='cad-review'){
    additions.push(renderTemplate(templates.review,values));
    additions.push('Scope of this independent cad-review session: inspect the supplied evidence only. Use the available exec tool for read-only inspection and report actual findings. Do not start a new modeling workflow, modify parent artifacts, ask the user questions, or delegate another task. Review instructions take precedence over the general modeling workflow above.');
  }
  return {system:renderTemplate(templates.system,values),runtime:[renderTemplate(templates.base,values),...additions].join('\n\n'),values,templateHashes:templates.templateHashes,agent,sessionID,snapshotRoot:path.join(runtime,'prompt-snapshots')};
}
export function savePromptSnapshot(compiled){
  const directory=path.join(compiled.snapshotRoot,compiled.sessionID);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,Date.now()+'-'+crypto.randomUUID()+'.json');
  fs.writeFileSync(file,JSON.stringify({createdAt:new Date().toISOString(),sessionID:compiled.sessionID,agent:compiled.agent,templateHashes:compiled.templateHashes,values:compiled.values,segments:[compiled.system,compiled.runtime]},null,2),{mode:0o600});
  return file;
}
export function promptRole(system){
  const roles=new Set();
  for(const text of system){
    if(typeof text!=='string')continue;
    const first=text.split('\n',1)[0].trim();
    if(first===REVIEW_PROMPT_MARKER)roles.add('cad-review');
    if(first===MAIN_PROMPT_MARKER)roles.add('cad-code');
  }
  if(roles.size>1)throw Error('PromptTemplateError: ambiguous agent markers');
  return roles.values().next().value||null;
}
