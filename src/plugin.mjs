import {tool} from '@opencode-ai/plugin';
import {executeCode,stopWorkers,prepareSessionWorkspace} from './executor.mjs';
import {sessionDir} from './paths.mjs';
import {saveToolMedia,mediaHash,mediaReceipt} from './tool-media.mjs';
import {compileSessionPrompts,savePromptSnapshot,promptRole} from './prompts.mjs';
export default async function CADCodePlugin({client}) {
  async function reviewParent(sessionID,agent){
    if(agent!=='cad-review')return undefined;
    const r=await client.session.get({path:{id:sessionID}});
    if(r.error||!r.data?.parentID)throw Error('Independent cad-review requires a verified parent session');
    return r.data.parentID;
  }
  return {
    event:async({event})=>{
      if(event.type==='session.created')prepareSessionWorkspace(event.properties.info.id);
    },
    tool:{exec:tool({
      description:'Execute JavaScript orchestration in this CAD task workspace. Write code using await tools.exec_command({cmd:"..."}), text(result.output), tools.apply_patch("*** Begin Patch..."), tools.write_stdin({session_id,...}), image(await tools.view_image({path:"out/model.png"})). ALL_TOOLS lists the actual subtools. Keep dependent actions sequential. Print observations with text(). This is executable JavaScript, not a shell-command array.',
      args:{code:tool.schema.string().describe('Complete JavaScript source, with original newlines.')},
      async execute({code},context){
        context.metadata({title:'执行 CAD 编排',metadata:{code}});
        const parentID=await reviewParent(context.sessionID,context.agent);
        const r=await executeCode(context.sessionID,code,context.abort,parentID?[sessionDir(parentID)+'/out']:[]);
        if(r.content?.some(p=>p.type==='input_image')){
          if(!context.callID)throw Error('ToolMediaAlignmentError: OpenCode did not provide callID');
          const observedOutput=(r.output?r.output+'\n':'')+mediaReceipt(context.callID,r.content);
          saveToolMedia(context.callID,{sessionID:context.sessionID,code,output:observedOutput,content:r.content,failed:Boolean(r.error)});
          // No OpenCode attachment: that route resizes media and turns it into a
          // synthetic user message. The gateway restores this exact tool result.
          let imageIndex=0;const parts=r.content.map(p=>p.type==='input_text'?p:{type:'input_image',index:imageIndex++});
          const metadata={cadMedia:{version:1,sessionID:context.sessionID,callID:context.callID,visibleOutput:r.output,parts,contentHash:mediaHash(JSON.stringify(r.content)),images:r.attachments.map((a,index)=>({index,mime:a.mime,filename:a.filename}))},...(r.error?{cadExecutionError:true}:{})};
          return {output:observedOutput,title:r.error?'CAD 编排返回错误与图片证据':'执行 CAD 编排',metadata};
        }
        if(r.error)throw Error(r.output);return {output:r.output};
      }
    })},
    'chat.params':async(input,out)=>{
      out.temperature=1;
      const modelID=input?.model?.id||input?.model?.api?.id;
      out.options={...out.options,reasoningEffort:modelID==='qwen-v8'?'medium':'high'};
    },
    'chat.headers':async(input,out)=>{out.headers['x-cad-session-id']=input.sessionID;},
    'experimental.chat.system.transform':async(input,out)=>{
      // Only our explicit agent markers opt in. Internal compaction prompts and
      // unrelated agents keep their original instructions.
      const agent=promptRole(out.system);if(!agent)return;
      if(!input.sessionID)throw Error('PromptTemplateError: session context missing');
      prepareSessionWorkspace(input.sessionID);
      const parentID=await reviewParent(input.sessionID,agent);
      const compiled=compileSessionPrompts({sessionID:input.sessionID,model:input.model,parentID,agent});
      savePromptSnapshot(compiled);
      out.system.splice(0,out.system.length,compiled.system,compiled.runtime);
    },
    dispose:async()=>stopWorkers()
  };
}
