import {loadProviderFile,savedProviderFile,validateProvider,qwenModel} from './provider-config.mjs';

class AskError extends Error {}

const HELP=`CAD Code · independent single-turn CLI

  ./cad-code ask '问题'
  printf '问题' | ./cad-code ask
  ./cad-code ask --model qwen-v8 --thinking off '问题'

Options:
  --credentials PATH       使用指定 API 配置文件
  --model ID               本次使用的模型，不修改已保存配置
  --thinking on|off        本次思考开关，默认沿用已保存配置
  --show-thinking          将接口返回的思考写到 stderr
  --timeout SECONDS        请求超时，默认 300 秒
  --max-output-tokens N    输出预算，默认 16384（包含思考）
  --                       后面的单个参数作为原文问题

直接调用提供商 API；每次只有一条 user 输入，无额外提示词、工具或历史。
默认 stdout 只输出最终答案；不启动 OpenCode，不建立会话或工作区。
配置优先级：--credentials > CAD_CODE_CREDENTIALS > 已保存配置。
CAD_CODE_WIRE_API=responses（默认）或 chat，选择提供商接口。
`;

function parseArgs(args){
  const options={timeout:300,maxOutputTokens:16384,showThinking:false};
  let literal=false;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(!literal&&arg==='--'){literal=true;continue;}
    if(!literal&&['--help','-h'].includes(arg)){options.help=true;continue;}
    if(!literal&&arg==='--show-thinking'){options.showThinking=true;continue;}
    if(!literal&&['--credentials','--model','--thinking','--timeout','--max-output-tokens'].includes(arg)){
      const value=args[++i];
      if(value===undefined||value.startsWith('--'))throw new AskError(arg+' requires a value');
      if(arg==='--credentials')options.credentials=value;
      if(arg==='--model')options.model=value;
      if(arg==='--thinking'){
        if(!['on','off'].includes(value))throw new AskError('--thinking must be on or off');
        options.thinking=value==='on';
      }
      if(arg==='--timeout'){
        const n=Number(value);if(!Number.isFinite(n)||n<=0||n>3600)throw new AskError('--timeout must be greater than 0 and at most 3600 seconds');
        options.timeout=n;
      }
      if(arg==='--max-output-tokens'){
        const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>262144)throw new AskError('--max-output-tokens must be an integer from 1 to 262144');
        options.maxOutputTokens=n;
      }
      continue;
    }
    if(!literal&&arg.startsWith('-'))throw new AskError('Unknown ask option; use cad-code ask --help, or -- before a literal question');
    if(options.question!==undefined)throw new AskError('Supply one question argument in quotes, or pipe the question on stdin');
    options.question=arg;
  }
  return options;
}

async function readQuestion(input){
  if(input.isTTY)throw new AskError('Supply a question: cad-code ask "问题", or pipe it on stdin');
  let size=0;const chunks=[];
  for await(const chunk of input){
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;if(size>4*1024*1024)throw new AskError('Question exceeds the 4 MiB input limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requestBody(provider,question,wireAPI,maxOutputTokens){
  const {model,thinking}=provider,qwen=qwenModel(model);
  const effort=qwen?(thinking?'medium':'low'):(thinking?'high':'none');
  const common={model,temperature:1,stream:false,store:false,
    ...(qwen?{chat_template_kwargs:{enable_thinking:thinking}}:{})};
  if(wireAPI==='responses')return {...common,input:[{role:'user',content:[{type:'input_text',text:question}]}],
    max_output_tokens:maxOutputTokens,reasoning:{effort}};
  return {...common,messages:[{role:'user',content:question}],max_tokens:maxOutputTokens,reasoning_effort:effort};
}

function responseText(data,wireAPI){
  if(!data||typeof data!=='object'||Array.isArray(data)||data.error)throw new AskError('Model API returned an invalid or failed response');
  let text='',thinking='';
  if(wireAPI==='responses'){
    if(data.status!=='completed')throw new AskError('Model response did not complete; no final answer was printed');
    if(!Array.isArray(data.output))throw new AskError('Model API response has no output array');
    for(const item of data.output){
      if(item.type==='function_call'||item.type?.endsWith('_call'))throw new AskError('Model requested a tool; single-turn mode does not execute tools');
      if(item.type==='reasoning'){
        const full=(item.content||[]).filter(x=>x.type==='reasoning_text'&&typeof x.text==='string');
        const parts=full.length?full:(item.summary||[]).filter(x=>x.type==='summary_text'&&typeof x.text==='string');
        thinking+=parts.map(x=>x.text).join('');
      }
      if(item.type==='message'){
        if(item.role!=='assistant'||!Array.isArray(item.content)||(item.status&&item.status!=='completed'))throw new AskError('Model API returned an invalid assistant message');
        for(const part of item.content){
          if(part.type==='output_text'&&typeof part.text==='string')text+=part.text;
          else if(part.type==='refusal'&&typeof part.refusal==='string')text+=part.refusal;
        }
      }
    }
  }else{
    if(!Array.isArray(data.choices)||data.choices.length!==1)throw new AskError('Model API must return one choice');
    const {message,finish_reason}=data.choices[0];
    if(finish_reason!=='stop')throw new AskError('Model response did not finish normally; no final answer was printed');
    if(!message||message.role!=='assistant')throw new AskError('Model API returned an invalid assistant message');
    if(message.tool_calls?.length||message.function_call)throw new AskError('Model requested a tool; single-turn mode does not execute tools');
    text=typeof message.content==='string'?message.content:typeof message.refusal==='string'?message.refusal:'';
    thinking=typeof message.reasoning_content==='string'?message.reasoning_content:
      typeof message.reasoning==='string'?message.reasoning:'';
  }
  if(!text.trim())throw new AskError('Model API returned no final text; no answer was printed');
  return {text,thinking};
}

async function write(stream,text){
  await new Promise((resolve,reject)=>stream.write(text,error=>error?reject(error):resolve()));
}

export async function askCLI(args,{input=process.stdin,output=process.stdout,error=process.stderr,env=process.env}={}){
  const options=parseArgs(args);
  if(options.help){await write(output,HELP);return;}
  const wireAPI=env.CAD_CODE_WIRE_API||'responses';
  if(!['responses','chat'].includes(wireAPI))throw new AskError('CAD_CODE_WIRE_API must be responses or chat');
  const question=options.question??await readQuestion(input);
  if(!question.trim())throw new AskError('Question must not be empty');
  if(Buffer.byteLength(question)>4*1024*1024)throw new AskError('Question exceeds the 4 MiB input limit');
  let file,provider;
  try{file=options.credentials||env.CAD_CODE_CREDENTIALS||savedProviderFile();}
  catch{throw new AskError('Could not read saved API configuration; use --credentials PATH or cad-code config');}
  if(!file)throw new AskError('Configure API first with cad-code config, or use --credentials PATH');
  try{provider=loadProviderFile(file);}
  catch{throw new AskError('Could not load API configuration; check the file or run cad-code config');}
  provider=validateProvider({...provider,...(options.model!==undefined?{model:options.model}:{}),
    ...(options.thinking!==undefined?{thinking:options.thinking}:{})});
  const controller=new AbortController();let interrupted=false,timedOut=false;
  const interrupt=()=>{interrupted=true;controller.abort();};
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.timeout*1000);
  try{
    let response;
    try{response=await fetch(provider.baseURL+(wireAPI==='responses'?'/responses':'/chat/completions'),{
      method:'POST',headers:{authorization:'Bearer '+provider.apiKey,'content-type':'application/json'},
      body:JSON.stringify(requestBody(provider,question,wireAPI,options.maxOutputTokens)),
      signal:controller.signal,redirect:'error'});}
    catch{throw new AskError('Could not connect to model API');}
    if(!response.ok){await response.body?.cancel();throw new AskError('Model API request failed (HTTP '+response.status+'); provider response omitted');}
    if(!(response.headers.get('content-type')||'').includes('json')){await response.body?.cancel();throw new AskError('Model API did not return JSON');}
    let size=0;const chunks=[];
    for await(const chunk of response.body){size+=chunk.length;if(size>16*1024*1024)throw new AskError('Model API response exceeds 16 MiB');chunks.push(chunk);}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AskError('Model API returned invalid JSON');}
    const answer=responseText(data,wireAPI);
    if(options.showThinking&&answer.thinking)await write(error,answer.thinking+(answer.thinking.endsWith('\n')?'':'\n'));
    await write(output,answer.text+(answer.text.endsWith('\n')?'':'\n'));
  }catch(e){
    if(interrupted){const error=new AskError('Request cancelled');error.exitCode=130;throw error;}
    if(timedOut)throw new AskError('Model API request timed out');
    // Transport exceptions may contain upstream details. Only our own errors are displayed.
    if(!(e instanceof AskError))throw new AskError('Could not read model API response');
    throw e;
  }finally{clearTimeout(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
}
