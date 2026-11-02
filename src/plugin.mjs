import {tool} from '@opencode-ai/plugin';
import {executeCode,stopWorkers} from './executor.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {PYTHON,SKILL,ROOT,sessionDir} from './paths.mjs';
export default async function CADCodePlugin({client}) {
  async function reviewRoots(sessionID){try{const r=await client.session.get({path:{id:sessionID}});return r.data?.parentID?[sessionDir(r.data.parentID)+'/out']:[];}catch{return [];}}
  return {
    tool:{exec:tool({
      description:'Execute JavaScript orchestration in this CAD task workspace. Write code using await tools.exec_command({cmd:"..."}), text(result.output), tools.apply_patch("*** Begin Patch..."), tools.write_stdin({session_id,...}), image(await tools.view_image({path:"out/model.png"})). ALL_TOOLS lists the actual subtools. Keep dependent actions sequential. Print observations with text(). This is executable JavaScript, not a shell-command array.',
      args:{code:tool.schema.string().describe('Complete JavaScript source, with original newlines.')},
      async execute({code},context){context.metadata({title:'执行 CAD 编排',metadata:{code}});const r=await executeCode(context.sessionID,code,context.abort,await reviewRoots(context.sessionID));if(r.error)throw Error(r.output);return r;}
    })},
    'chat.params':async(_,out)=>{out.temperature=1;out.options={...out.options,reasoningEffort:'high'};},
    'experimental.chat.system.transform':async(input,out)=>{
      if(!input.sessionID)return;
      const inputs=path.join(sessionDir(input.sessionID),'input');if(fs.existsSync(inputs))out.system.push('Files explicitly supplied for this session: '+fs.readdirSync(inputs).map(x=>'input/'+x).join(', ')+'. Read them only within this session workspace.');
      const roots=await reviewRoots(input.sessionID);if(roots.length)out.system.push('Independent review session. Parent output artifacts are read-only at '+roots.join(', ')+'. Use image(await tools.view_image({path:"'+roots[0]+'/model.png"})) to inspect the actual rendered evidence. State actual findings; do not inherit the parent model\'s verdict.');
      out.system.push(`CAD runtime for this session:\n- Current writable workspace: ${sessionDir(input.sessionID)}. All shell commands run here. Input files are under input/.\n- Python3.12, SimpleCADAPI2.2.5: ${PYTHON}. Use this Python and its sibling sca command.\n- Read the complete SimpleCADAPI skill router: ${SKILL}/SKILL.md; select its workflow and read exact API references before unfamiliar operations. The full skill supports parts, assemblies, STEP reconstruction, inspection and exports.\n- Use exec(code) for computation and file operations; it exposes tools.exec_command, tools.write_stdin, tools.apply_patch, tools.view_image, text(), image(), ALL_TOOLS. Use the native question/todowrite/task tools when the selected workflow needs them. JavaScript bindings do not persist between exec calls; process session IDs do.\n- Print observations with text(r.output) or text(r). For rendered images use image(await tools.view_image({path:"out/model.png"})). Shell stdin is EOF; PTY is not implemented. A running command returns session_id: poll it with write_stdin.\n- Optional verified helper: ${PYTHON} ${ROOT}/tools/cad.py export model.py --out out; render out/model.step --out out/model.png; inspect out/model.step. It supports the full skill's marimo notebooks through run_notebook, as well as library modules exposing build().\n- Follow the skill's notebook/feature-tree convention. For STEP reverse engineering, delivered source must model independently and must not copy target geometry.\n- Build/export/inspect and render actual artifacts. Then inspect the image, fix real errors, and finish with a concise Chinese reply linking the actual relative artifact paths. Do not claim success before tool verification. Do not repeat unchanged failures.\n- This is an interactive CAD session, not a scored benchmark. Explain missing dimensions or actual execution limitations honestly.`);
    },
    dispose:async()=>stopWorkers()
  };
}
