import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {executeCode,stopSession} from '../src/executor.mjs';
import {ROOT,PYTHON,SKILL,sessionDir} from '../src/paths.mjs';

test('Linux worker denies host, sibling, input writes and network; nested notebook replay hides target and builds CAD',
  {skip:process.platform!=='linux',timeout:240000},async()=>{
  const id='ses_linuxprobe_'+crypto.randomBytes(8).toString('hex'),work=sessionDir(id),sibling=sessionDir(id+'_other');
  const secret=path.join(ROOT,'.runtime','linux-probe-'+crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(path.join(work,'input'),{recursive:true});fs.mkdirSync(sibling,{recursive:true});
  fs.writeFileSync(path.join(work,'input/target.step'),'INPUT_SENTINEL');
  fs.writeFileSync(path.join(work,'input/target.ir.jsonl'),'IR_SENTINEL');
  fs.writeFileSync(path.join(sibling,'answer'),'OTHER_CASE_SENTINEL');fs.writeFileSync(secret,'SECRET_SENTINEL',{mode:0o600});
  let requests=0;const server=http.createServer((req,res)=>{requests++;res.end('HOST_NETWORK');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const exec=async cmd=>{
    let r=await executeCode(id,`text(await tools.exec_command({cmd:${JSON.stringify(cmd)},yield_time_ms:30000,max_output_tokens:6000}));`);
    assert.equal(r.error,undefined,r.output);let v=JSON.parse(r.output),output=v.output;
    while(v.exit_code===null){r=await executeCode(id,`text(await tools.write_stdin({session_id:${v.session_id},yield_time_ms:1000,max_output_tokens:6000}));`);v=JSON.parse(r.output);output+=v.output;}
    return {...v,output};
  };
  try{
    const probe=`import os,pathlib,socket\nfrom pathlib import Path\nPath('writable').write_text('OK')\nassert Path('input/target.step').read_text()=='INPUT_SENTINEL'\nfor p in ${JSON.stringify([secret,path.join(sibling,'answer')])}:\n try: Path(p).read_text(); raise AssertionError('HOST_READ_ALLOWED')\n except (FileNotFoundError,PermissionError): pass\ntry: Path('input/target.step').write_text('BAD'); raise AssertionError('INPUT_WRITE_ALLOWED')\nexcept (PermissionError,OSError): pass\ntry: os.kill(${process.pid},0); raise AssertionError('HOST_PID_VISIBLE')\nexcept ProcessLookupError: pass\ns=socket.socket(); s.settimeout(1)\ntry: s.connect(('127.0.0.1',${server.address().port})); raise AssertionError('NETWORK_ALLOWED')\nexcept OSError: pass\nprint('WORKER_ISOLATION_OK')`;
    let result=await exec(`"$CAD_CODE_PYTHON" -I - <<'PY'\n${probe}\nPY`);
    assert.equal(result.exit_code,0,result.output);assert.match(result.output,/WORKER_ISOLATION_OK/);assert.equal(requests,0);
    const nb=['# /// script','# dependencies = ["simplecadapi"]','#','# [tool.simplecadapi]','# id = "model"','# revision = "1.0.0"','# ///',
      'import marimo','app = marimo.App()','with app.setup:','    import simplecadapi as scad',
      '@app.cell','def _():','    # ---- feature: post (build) ----','    post = scad.make_cylinder_rsolid(radius=5.0, height=12.0)','    return (post,)',
      '@app.cell','def _(post):','    model = scad.Part(part_id="model", body=post)','    return (model,)','if __name__ == "__main__":','    app.run()',''].join('\n');
    fs.writeFileSync(path.join(work,'model.py'),nb);
    const evalscript=path.join(SKILL,'scripts/stepeval.py');
    result=await exec(`"$CAD_CODE_PYTHON" ${evalscript} model.py /dev/null --out eval/0; "$CAD_CODE_PYTHON" ${evalscript} model.py eval/0/candidate.step --out eval/1`);
    assert.equal(result.exit_code,0,result.output);
    const score=JSON.parse(result.output.trim().split('\n').filter(x=>x.startsWith('{')).at(-1));
    assert.equal(score.ok,true,result.output);assert.equal(score.riou,1);
    const runner=path.join(work,'.tmp/replay-probe.py'),out=path.join(work,'replay-probe-out');fs.mkdirSync(out);
    fs.writeFileSync(runner,`from pathlib import Path\nfor p in ${JSON.stringify([path.join(work,'input/target.step'),path.join(work,'input/target.ir.jsonl'),path.join(work,'eval/0/candidate.step'),secret])}:\n try: Path(p).read_bytes(); raise AssertionError('REPLAY_HOST_READ_ALLOWED')\n except (FileNotFoundError,PermissionError): pass\nprint('REPLAY_TARGET_DENIED')\n`);
    const replay=spawnSync(PYTHON,['-I',path.join(ROOT,'src/linux-sandbox.py'),'notebook','--notebook',path.join(work,'model.py'),'--out',out,'--runner',runner],{env:process.env,encoding:'utf8'});
    assert.equal(replay.status,0,replay.stdout+replay.stderr);assert.match(replay.stdout,/REPLAY_TARGET_DENIED/);
    assert.equal(fs.readFileSync(path.join(work,'input/target.step'),'utf8'),'INPUT_SENTINEL');
  }finally{
    stopSession(id);await new Promise(r=>setTimeout(r,250));await new Promise(r=>server.close(r));
    for(const p of [work,sibling])fs.rmSync(p,{recursive:true,force:true});fs.unlinkSync(secret);
  }
});
