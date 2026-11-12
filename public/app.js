/* CAD Code local UI. Dynamic content is rendered with text nodes, never HTML. */
const $ = id => document.getElementById(id);
const state = {id:null,sessions:[],data:null,config:null,folds:new Map(),messageFingerprint:'',fileFingerprint:'',questionFingerprint:'',selectedFile:null,previewFingerprint:'',requestGeneration:0,polling:false,sending:false,creating:null,pendingUntil:0,uploads:[]};
const fmtSize = n => n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
const readable = value => typeof value==='string'?value:JSON.stringify(value,null,2);
function el(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function showError(error){$('errorText').textContent=error?.message||String(error);$('errorBanner').hidden=false;}
function clearError(){$('errorBanner').hidden=true;}
async function api(url,options={}) {
  const response=await fetch(url,{...options,headers:{...(options.body&&typeof options.body==='string'?{'content-type':'application/json'}:{}),...options.headers}});
  const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
  if(!response.ok)throw Error(typeof value==='object'?(value.error||'请求失败'):text||'请求失败');
  return value;
}
const post=(url,value)=>api(url,{method:'POST',body:JSON.stringify(value)});
function online(ok){$('connection').className='connection '+(ok?'online':'offline');$('connection').replaceChildren(el('i'),document.createTextNode(ok?'本机已连接':'连接中断'));}
function fileURL(file,download=false,id=state.id){return '/api/sessions/'+encodeURIComponent(id)+'/file?path='+encodeURIComponent(file)+(download?'&download=1':'');}
function assetLink(href,label){
  let p=href;
  if(p.includes('/'+state.id+'/'))p=p.split('/'+state.id+'/').pop();
  p=p.replace(/^\.\//,'');
  const known=state.data?.files?.find(x=>x.path===p);
  const a=el('a',null,label);
  if(known){a.href=fileURL(p);a.addEventListener('click',e=>{e.preventDefault();selectFile(p);});}
  else if(/^https?:\/\//i.test(href)){a.href=href;a.target='_blank';a.rel='noopener noreferrer';}
  else {a.href='#';a.addEventListener('click',e=>e.preventDefault());a.title=href;}
  return a;
}
function inline(node,text){
  const re=/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;let last=0,m;
  while((m=re.exec(text))){node.append(document.createTextNode(text.slice(last,m.index)));const x=m[0];
    if(x.startsWith('`'))node.append(el('code',null,x.slice(1,-1)));
    else if(x.startsWith('**'))node.append(el('strong',null,x.slice(2,-2)));
    else {const l=x.match(/^\[([^\]]+)\]\(([^)]+)\)$/);node.append(assetLink(l[2],l[1]));}
    last=re.lastIndex;
  }
  node.append(document.createTextNode(text.slice(last)));
}
function markdown(text){
  const out=document.createDocumentFragment(),blocks=String(text).split(/(```[^\n]*\n[\s\S]*?```)/g);
  for(const block of blocks){
    if(block.startsWith('```')){const c=block.replace(/^```[^\n]*\n/,'').replace(/```$/,'');out.append(el('pre',null,c));continue;}
    for(const paragraph of block.split(/\n\s*\n/)){if(!paragraph.trim())continue;const h=paragraph.match(/^(#{1,4})\s+(.+)$/);const p=el(h?'h'+Math.min(4,h[1].length+1):'p');inline(p,h?h[2]:paragraph);out.append(p);}
  }
  return out;
}
function fold(key,label,meta,content,{open=false,className=''}={}){
  const d=el('details','fold '+className);d.dataset.foldKey=key;d.open=state.folds.has(key)?state.folds.get(key):open;
  const s=el('summary');s.append(el('span','fold-label',label));if(meta)s.append(el('span','fold-meta',meta));d.append(s,content);
  d.addEventListener('toggle',()=>state.folds.set(key,d.open));return d;
}
function saveFolds(){for(const d of document.querySelectorAll('details[data-fold-key]'))state.folds.set(d.dataset.foldKey,d.open);}
function dateText(s){const n=s.time?.updated||s.time?.created||s.updatedAt||s.createdAt;return n?new Date(n).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';}
function renderSessions(){
  $('sessionCount').textContent=state.sessions.length;
  const root=$('sessionList');root.replaceChildren();
  if(!state.sessions.length){root.append(el('p','empty-files','新建任务开始建模'));return;}
  for(const session of state.sessions){const b=el('button','session-item'+(session.id===state.id?' active':''));b.title=session.title||'CAD 任务';b.append(el('strong',null,session.title||'CAD 任务'),el('small',null,dateText(session)));b.addEventListener('click',()=>chooseSession(session.id));root.append(b);}
}
async function loadSessions(){const value=await api('/api/sessions');state.sessions=(Array.isArray(value)?value:value.data||[]).filter(x=>!x.parentID).sort((a,b)=>(b.time?.updated||b.time?.created||0)-(a.time?.updated||a.time?.created||0));renderSessions();}
function setBusy(busy){$('taskStatus').textContent=busy?'处理中':'就绪';$('taskStatus').className='task-status'+(busy?' busy':'');$('runningIndicator').hidden=!busy;$('stopButton').hidden=!busy;$('sendButton').disabled=state.sending||busy;}
function busy(){return state.sending||Date.now()<state.pendingUntil||['busy','retry'].includes(state.data?.status?.type);}
function resetView(){state.messageFingerprint='';state.fileFingerprint='';state.questionFingerprint='';state.previewFingerprint='';state.selectedFile=null;state.data=null;$('messages').replaceChildren();$('questions').replaceChildren();$('fileList').replaceChildren(el('p','empty-files','还没有文件'));$('fileCount').textContent='0';$('previewImage').hidden=true;$('previewCode').hidden=true;$('previewEmpty').hidden=false;$('previewCaption').hidden=true;$('welcome').hidden=false;}
async function chooseSession(id){
  if(id===state.id)return;
  saveFolds();state.id=id;state.requestGeneration++;state.pendingUntil=0;state.uploads=[];renderUploadChips();resetView();
  location.hash=encodeURIComponent(id);localStorage.setItem('cad-code-session',id);renderSessions();
  const s=state.sessions.find(x=>x.id===id);$('sessionTitle').textContent=s?.title||'CAD 任务';$('exportSession').href='/api/sessions/'+id+'/export';$('exportSession').hidden=false;
  await refresh();
}
async function newSession(){
  if(state.creating)return state.creating;
  state.creating=(async()=>{const s=await post('/api/sessions',{title:'CAD 任务 · '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})});await loadSessions();await chooseSession(s.id);$('prompt').focus();return s;})();
  try{return await state.creating;}catch(e){showError(e);throw e;}finally{state.creating=null;}
}
function toolPart(part,index){
  const s=part.state||{},id=part.id||'tool-'+index,status=s.metadata?.cadExecutionError?'error':s.status||'pending';
  const toolName=part.tool||'工具',box=el('div','tool-sections');
  const input=typeof s.input==='object'&&s.input!==null&&typeof s.input.code==='string'?s.input.code:readable(s.input||{});
  box.append(fold(id+'-input','调用参数',input.length.toLocaleString()+' 字符',el('pre',null,input)));
  const media=s.metadata?.cadMedia;
  if(s.output!==undefined||s.error){const output=s.error||(media?media.visibleOutput:s.output),body=el('div');
    if(media?.parts){for(const p of media.parts){if(p.type==='input_text')body.append(el('pre',null,p.text));else if(p.type==='input_image'){const image=el('img','tool-result-image');image.src='/api/sessions/'+encodeURIComponent(part.sessionID||state.id)+'/tool-image?call='+encodeURIComponent(media.callID)+'&index='+p.index;image.alt=media.images?.[p.index]?.filename||'工具返回原图';body.append(image);}}}
    else body.append(el('pre',null,readable(output)));
    box.append(fold(id+'-output',s.error||s.metadata?.cadExecutionError?'错误结果':'调用结果',typeof output==='string'?output.length.toLocaleString()+' 字符':'',body,{open:status==='error'}));}
  for(const a of [...(s.attachments||[]),...(part.attachments||[])])if(a.mime?.startsWith('image/')&&/^(data:image\/|\/api\/)/.test(a.url||'')){const image=el('img','tool-result-image');image.src=a.url;image.alt=a.filename||'工具返回图像';box.append(image);}
  if(!media?.parts)for(const a of media?.images||[]){const image=el('img','tool-result-image');image.src='/api/sessions/'+encodeURIComponent(part.sessionID||state.id)+'/tool-image?call='+encodeURIComponent(media.callID)+'&index='+a.index;image.alt=a.filename||'工具返回原图';box.append(image);}
  const outer=fold(id+'-outer',toolName,({completed:'已完成',error:'执行错误',running:'正在执行',pending:'等待执行'})[status]||status,box,{open:status==='running'||status==='error',className:'tool-fold'});
  const summary=outer.querySelector('summary');summary.insertBefore(el('span','tool-state '+status),summary.firstChild);return outer;
}
function renderMessages(messages){
  const fingerprint=JSON.stringify(messages);if(fingerprint===state.messageFingerprint)return;
  const scroller=$('conversationScroll'),nearBottom=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<100,oldTop=scroller.scrollTop;
  saveFolds();state.messageFingerprint=fingerprint;$('messages').replaceChildren();
  let visible=0;
  for(let index=0;index<messages.length;index++){
    const message=messages[index],info=message.info||{},parts=message.parts||[],isUser=info.role==='user';
    if(!parts.some(p=>['text','reasoning','tool','file'].includes(p.type))&&!info.error)continue;
    const article=el('article','message '+(isUser?'user':'assistant'));const head=el('div','message-head');head.append(el('span','avatar',isUser?'你':'C'),el('span',null,isUser?'你':'CAD Code'));
    if(info.time?.created)head.append(el('span','message-time',new Date(info.time.created).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})));
    const body=el('div','message-body');
    for(let j=0;j<parts.length;j++){
      const p=parts[j],id=p.id||`${info.id||index}-${j}`;
      if(p.type==='text'&&p.text?.trim())body.append(markdown(p.text));
      if(p.type==='reasoning'&&p.text?.trim()){
        const content=el('div','fold-content',p.text);body.append(fold(id,'思考过程','接口返回内容',content,{className:'reasoning-fold'}));
      }
      if(p.type==='tool')body.append(toolPart(p,j));
      if(p.type==='file'){
        const label=p.filename||p.mime||'附件';
        if(p.mime?.startsWith('image/')&&/^data:image\//.test(p.url||'')){const image=el('img','tool-result-image');image.src=p.url;image.alt=label;body.append(image);}
        else body.append(el('span','attachment-link','▧ '+label));
      }
    }
    if(info.error){const e=info.error;body.append(el('div','message-error',e.data?.message||e.message||readable(e)));}
    if(!body.childNodes.length)continue;article.append(head,body);$('messages').append(article);visible++;
  }
  $('welcome').hidden=visible>0;
  requestAnimationFrame(()=>{if(nearBottom)scroller.scrollTop=scroller.scrollHeight;else scroller.scrollTop=oldTop;});
}
async function selectFile(file){
  state.selectedFile=file;state.previewFingerprint='';renderFiles(state.data?.files||[]);await updatePreview();
}
function renderFiles(files){
  const fingerprint=JSON.stringify(files)+state.selectedFile;if(fingerprint===state.fileFingerprint)return;state.fileFingerprint=fingerprint;
  $('fileCount').textContent=files.length;$('fileList').replaceChildren();
  if(!files.length){$('fileList').append(el('p','empty-files','还没有文件'));return;}
  for(const f of files){const row=el('div','file-row'+(f.path===state.selectedFile?' selected':'')),ext=f.path.split('.').pop().toUpperCase();
    row.append(el('span','file-glyph',ext.slice(0,4)));const b=el('button');b.title=f.path;b.append(el('strong',null,f.path.split('/').pop()),el('small',null,fmtSize(f.size)+(f.path.includes('/')?' · '+f.path.split('/').slice(0,-1).join('/') : '')));b.addEventListener('click',()=>selectFile(f.path));
    const download=el('a',null,'↓');download.href=fileURL(f.path,true);download.title='下载 '+f.path;download.setAttribute('aria-label',download.title);row.append(b,download);$('fileList').append(row);
  }
}
async function updatePreview(){
  const files=state.data?.files||[];
  if(!state.selectedFile){const png=files.find(f=>/\.(png|jpe?g)$/i.test(f.path)&&!f.path.startsWith('input/'));if(png)state.selectedFile=png.path;}
  const f=files.find(x=>x.path===state.selectedFile);if(!f)return;
  const fp=state.id+f.path+f.mtime;if(fp===state.previewFingerprint)return;state.previewFingerprint=fp;
  const id=state.id;const isImage=/\.(png|jpe?g)$/i.test(f.path),isText=/\.(py|md|txt|json|jsonl|yaml|yml|toml|js|ts)$/i.test(f.path);
  $('previewEmpty').hidden=true;$('previewImage').hidden=true;$('previewCode').hidden=true;$('previewCaption').hidden=false;$('previewPath').textContent=f.path;$('previewPath').title=f.path;$('previewDownload').href=fileURL(f.path,true);
  if(isImage){$('previewImage').src=fileURL(f.path)+'&v='+f.mtime;$('previewImage').alt=f.path;$('previewImage').hidden=false;}
  else if(isText){$('previewCode').hidden=false;$('previewCode').textContent='读取文件…';try{const r=await fetch(fileURL(f.path));if(!r.ok)throw Error('读取文件失败');const text=await r.text();if(state.id===id&&state.selectedFile===f.path)$('previewCode').textContent=text;}catch(e){if(state.id===id)$('previewCode').textContent=e.message;}}
  else {$('previewCode').hidden=false;$('previewCode').textContent=f.path+'\n\n'+fmtSize(f.size)+'\n\n此格式可下载后使用 CAD 软件查看。';}
  renderFiles(files);
}
function renderQuestions(items){
  const questions=items.filter(x=>x.sessionID===state.id),fingerprint=JSON.stringify(questions);
  if(fingerprint===state.questionFingerprint)return;state.questionFingerprint=fingerprint;$('questions').replaceChildren();
  for(const request of questions){
    const form=el('form','question-card');form.append(el('h3',null,'需要你确认'));const groups=[];
    for(let i=0;i<(request.questions||[]).length;i++){
      const q=request.questions[i],field=el('fieldset','question-item'),legend=el('legend');legend.append(el('span','question-header',q.header||'确认 '+(i+1)),document.createTextNode(q.question||''));field.append(legend);const choices=[];
      for(const option of q.options||[]){const label=el('label','question-option'),input=el('input');input.type=q.multiple?'checkbox':'radio';input.name=request.id+'-'+i;input.value=option.label;const copy=el('span');copy.append(el('strong',null,option.label));if(option.description)copy.append(el('small',null,option.description));label.append(input,copy);field.append(label);choices.push(input);}
      const free=el('input','question-free');free.type='text';free.placeholder='或输入你的具体要求';free.setAttribute('aria-label',(q.header||'确认 '+(i+1))+' 自定义回答');field.append(free);groups.push({choices,free,multiple:q.multiple});form.append(field);
    }
    const submit=el('button','question-submit','确认并继续');submit.type='submit';const error=el('p','question-error');error.hidden=true;form.append(submit,error);
    form.addEventListener('submit',async e=>{e.preventDefault();const answers=groups.map(g=>{const chosen=g.choices.filter(c=>c.checked).map(c=>c.value),free=g.free.value.trim();return free?(g.multiple?[...chosen,free]:[free]):chosen;});if(answers.some(x=>!x.length)){error.textContent='请回答每一项后再继续。';error.hidden=false;return;}submit.disabled=true;try{await post('/api/questions/'+encodeURIComponent(request.id)+'/reply',{answers});state.pendingUntil=Date.now()+2000;state.questionFingerprint='';await refresh();}catch(e){error.textContent=e.message;error.hidden=false;submit.disabled=false;}});
    $('questions').append(form);
  }
}
async function refresh(){
  if(!state.id)return;const id=state.id,generation=state.requestGeneration;
  try{const [data,questions]=await Promise.all([api('/api/sessions/'+id),api('/api/questions')]);if(generation!==state.requestGeneration||id!==state.id)return;
    state.data=data;renderMessages(data.messages||[]);renderFiles(data.files||[]);renderQuestions(Array.isArray(questions)?questions:questions.data||[]);await updatePreview();setBusy(busy());online(true);
    const session=state.sessions.find(x=>x.id===id);if(session)$('sessionTitle').textContent=session.title||'CAD 任务';
  }catch(e){online(false);showError(e);}
}
function renderUploadChips(){$('uploadChips').replaceChildren(...state.uploads.map(x=>el('span','upload-chip',x)));$('uploadChips').hidden=!state.uploads.length;}
async function submit(event){
  event?.preventDefault();const text=$('prompt').value.trim();if(!text||state.sending||busy())return;
  state.sending=true;$('sendButton').disabled=true;clearError();
  try{if(!state.id)await newSession();const uploaded=state.uploads.length?'\n\n本次上传文件（相对工作目录）：\n'+state.uploads.map(x=>'- '+x).join('\n'):'';await post('/api/sessions/'+state.id+'/send',{text:text+uploaded});$('prompt').value='';state.uploads=[];renderUploadChips();state.pendingUntil=Date.now()+3000;await refresh();}
  catch(e){showError(e);}finally{state.sending=false;setBusy(busy());}
}
async function upload(files){
  // BEGIN MULTISOLID ADDITIVE UPLOAD
  if(files?.length===1&&/\.st(?:ep|p)$/i.test(files[0].name)&&!state.data?.messages?.length){
    try{
      const routed=await api('/api/multisolid/dispatch?name='+encodeURIComponent(files[0].name),{method:'POST',headers:{'content-type':'application/octet-stream'},body:files[0]});
      if(routed.kind==='multi'){location.assign(routed.workbench_url);return;}
      if(routed.kind==='single'&&routed.session_id){
        await loadSessions();
        state.id=null;
        await chooseSession(routed.session_id);
        $('prompt').focus();
        return;
      }
    }catch(error){showError(error);return;}
  }
  // END MULTISOLID ADDITIVE UPLOAD
  if(!files?.length)return;$('uploadButton').disabled=true;clearError();
  try{if(!state.id)await newSession();const id=state.id;for(const file of files){if(file.size>32*1024*1024)throw Error('文件超过32MB：'+file.name);const value=await api('/api/sessions/'+id+'/upload?name='+encodeURIComponent(file.name),{method:'POST',headers:{'content-type':'application/octet-stream'},body:file});if(id===state.id&&!state.uploads.includes(value.path))state.uploads.push(value.path);}renderUploadChips();await refresh();$('prompt').focus();}
  catch(e){showError(e);}finally{$('uploadButton').disabled=false;$('fileInput').value='';}
}
let dataToken='';
async function openDataManager(){
  const data=await api('/api/data');dataToken=data.config_token;$('dataItems').replaceChildren();
  for(const item of data.items){
    const card=el('div','data-item');card.append(el('strong',null,item.title),el('code',null,item.id));
    card.append(el('small',null,(item.hasConversation?'对话已保存':'无对话记录')+' · '+(item.hasWorkspace?item.files+' 个文件 · '+fmtSize(item.bytes):'无工作区文件')));
    const actions=el('div','data-actions'),workspace=el('button',null,'清理工作区'),conversation=el('button','danger-button','删除对话与轨迹');
    workspace.disabled=!item.hasWorkspace;conversation.disabled=!item.hasConversation;
    workspace.addEventListener('click',()=>deleteSessionData(item,'workspace'));conversation.addEventListener('click',()=>deleteSessionData(item,'conversation'));
    actions.append(workspace,conversation);card.append(actions);$('dataItems').append(card);
  }
  if(!data.items.length)$('dataItems').append(el('p',null,'没有已保存的对话或工作区。'));
  if(!$('dataDialog').open)$('dataDialog').showModal();
}
async function deleteSessionData(item,scope){
  const message=scope==='workspace'?'删除此工作区的输入、代码、模型和缓存文件？对话、思考、工具记录和轨迹保留。':'删除此对话及其子评审的消息、思考和工具轨迹？工作区中的代码、模型和输入文件保留。';
  if(!window.confirm(message+'\n\n'+item.title+'\n'+item.id))return;
  $('dataNotice').textContent='处理中…';$('dataNotice').className='';
  try{
    const result=await api('/api/sessions/'+item.id+'/'+scope,{method:'DELETE',headers:{'x-cad-config-token':dataToken},body:JSON.stringify({confirm:item.id})});
    if(scope==='conversation'&&(result.deleted_sessions||[item.id]).includes(state.id)){
      state.id=null;state.requestGeneration++;state.pendingUntil=0;state.uploads=[];resetView();renderUploadChips();localStorage.removeItem('cad-code-session');history.replaceState(null,'',location.pathname);$('sessionTitle').textContent='开始一个 CAD 任务';$('exportSession').hidden=true;setBusy(false);
    }else if(scope==='workspace'&&item.id===state.id){state.selectedFile=null;state.previewFingerprint='';$('previewImage').hidden=true;$('previewCode').hidden=true;$('previewEmpty').hidden=false;$('previewCaption').hidden=true;await refresh();}
    await loadSessions();await openDataManager();
    $('dataNotice').textContent=(scope==='workspace'?'工作区已清理，对话和轨迹保留。':'对话和轨迹已删除，工作区文件保留。')+(result.unknown?.length?'有 '+result.unknown.length+' 项归属不明的记录保留。':'');
  }catch(error){$('dataNotice').textContent=error.message;$('dataNotice').className='error';}
}
$('dataSettings').addEventListener('click',()=>{$('dataNotice').textContent='';openDataManager().catch(showError);});
$('closeData').addEventListener('click',()=>$('dataDialog').close());
let providerToken='';
async function openProviderSettings(){
  const config=await api('/api/provider');providerToken=config.config_token;
  $('providerThinking').checked=config.thinking!==false;$('providerURL').value=config.base_url;$('providerKey').value='';$('providerKey').required=!config.api_key_configured;
  $('providerKey').placeholder=config.api_key_configured?'已配置；留空保持原密钥':'输入 API key';
  $('providerKeyHint').textContent=config.api_key_configured?'密钥已保存在本机；留空不会修改，填写新密钥将替换。':'密钥仅保存在本机，不会显示在配置响应中。';
  $('providerModel').value=config.model||state.config?.model||'qwen-v8';$('providerModelList').replaceChildren();$('providerNotice').textContent='';$('providerNotice').className='';
  if(!$('providerDialog').open)$('providerDialog').showModal();
}
$('apiSettings').addEventListener('click',()=>openProviderSettings().catch(showError));
$('loadProviderModels').addEventListener('click',async()=>{
  $('loadProviderModels').disabled=true;$('providerNotice').textContent='获取模型列表…';$('providerNotice').className='';
  try{const result=await api('/api/provider/models',{method:'POST',headers:{'x-cad-config-token':providerToken},body:JSON.stringify({base_url:$('providerURL').value,api_key:$('providerKey').value,model:$('providerModel').value||'qwen-v8'})});
    $('providerModelList').replaceChildren(...result.models.map(id=>{const option=el('option');option.value=id;return option;}));
    $('providerNotice').textContent=result.models.length?'已获取 '+result.models.length+' 个模型，点击模型 ID 输入框选择。':'接口未列出模型，请直接填写模型 ID。';$('providerModel').focus();
  }catch(error){$('providerNotice').textContent=error.message;$('providerNotice').className='error';}
  finally{$('loadProviderModels').disabled=false;}
});
for(const id of ['closeProvider','cancelProvider'])$(id).addEventListener('click',()=>$('providerDialog').close());
$('providerDialog').addEventListener('close',()=>{$('providerKey').value='';providerToken='';});
$('providerForm').addEventListener('submit',async event=>{
  event.preventDefault();$('saveProvider').disabled=true;$('providerNotice').textContent='保存中…';$('providerNotice').className='';
  try{
    const saved=await api('/api/provider',{method:'PUT',headers:{'x-cad-config-token':providerToken},body:JSON.stringify({base_url:$('providerURL').value,api_key:$('providerKey').value,model:$('providerModel').value,thinking:$('providerThinking').checked})});
    $('modelName').textContent=saved.model;if(state.config){state.config.model=saved.model;state.config.thinking=saved.thinking;}
    $('modelOptions').textContent='temperature 1 · 256k · vision · 思考'+(saved.thinking?'开启':'关闭');
    $('providerKey').value='';$('providerKey').required=false;$('providerKey').placeholder='已配置；留空保持原密钥';
    $('providerKeyHint').textContent='密钥已保存在本机；留空不会修改，填写新密钥将替换。';
    $('providerNotice').textContent='配置已保存，下一次模型请求生效。';
    if(state.config)state.config.providerConfigured=true;
  }catch(error){$('providerNotice').textContent=error.message;$('providerNotice').className='error';}
  finally{$('saveProvider').disabled=false;}
});
$('newSession').addEventListener('click',()=>newSession().catch(()=>{}));$('composer').addEventListener('submit',submit);
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();submit();}});
$('stopButton').addEventListener('click',async()=>{if(!state.id)return;$('stopButton').disabled=true;try{await post('/api/sessions/'+state.id+'/stop',{});state.pendingUntil=0;await refresh();}catch(e){showError(e);}finally{$('stopButton').disabled=false;}});
$('uploadButton').addEventListener('click',()=>$('fileInput').click());$('fileInput').addEventListener('change',()=>upload($('fileInput').files));$('dismissError').addEventListener('click',clearError);
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();newSession().catch(()=>{});}});
for(const b of document.querySelectorAll('[data-example]'))b.addEventListener('click',()=>{$('prompt').value=b.dataset.example;$('prompt').focus();});
window.addEventListener('hashchange',()=>{const id=decodeURIComponent(location.hash.slice(1));if(/^ses_[\w-]+$/.test(id))chooseSession(id);});
function displayConfig(config){
  state.config=config;$('modelName').textContent=config.model;$('skillName').textContent=config.skill;
  $('modelOptions').textContent='temperature '+config.temperature+' · '+Math.round(config.context/1024)+'k · '+(config.vision?'vision':'text')+' · 思考'+(config.thinking===false?'关闭':'开启');
}
async function init(){
  try{displayConfig(await api('/api/config'));await loadSessions();online(true);if(state.config.providerConfigured===false)await openProviderSettings();const hash=decodeURIComponent(location.hash.slice(1)),saved=localStorage.getItem('cad-code-session');const id=[hash,saved].find(x=>state.sessions.some(s=>s.id===x));if(id)await chooseSession(id);}
  catch(e){online(false);showError(e);}
  let iteration=0;
  setInterval(async()=>{if(state.polling)return;state.polling=true;try{await refresh();if(++iteration%5===0){await loadSessions();displayConfig(await api('/api/config'));}}catch(e){online(false);}finally{state.polling=false;}},1000);
}
init();
