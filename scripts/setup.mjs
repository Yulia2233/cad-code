import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,PYTHON} from '../src/paths.mjs';
if(!['darwin','linux'].includes(process.platform))throw Error('Unsupported platform');
if(process.platform==='linux'&&!process.env.CAD_CODE_BWRAP)throw Error('Linux setup requires CAD_CODE_BWRAP');
const args=process.argv.slice(2),i=args.indexOf('--python');const source=i<0?'python3':args[i+1];
const run=(exe,args)=>{const r=spawnSync(exe,args,{stdio:'inherit'});if(r.status!==0)throw Error(exe+' failed ('+r.status+')');};
run(source,['-c',"import sys; assert sys.version_info[:2] in [(3,12),(3,13)], 'Use Python3.12 or3.13 for the SimpleCADAPI CAD wheels'"]);
run(process.env.OPENCODE_BIN||'opencode',['--version']);
if(!fs.existsSync(PYTHON)){fs.mkdirSync(path.dirname(path.dirname(PYTHON)),{recursive:true});run(source,['-m','venv',path.dirname(path.dirname(PYTHON))]);}
if(process.platform==='linux')run('uv',['pip','install','--python',PYTHON,'--index-url','https://mirrors.aliyun.com/pypi/simple','simplecadapi[editor,verify]==2.2.7','manifold3d==3.2.1','scipy']);
else run(PYTHON,['-m','pip','install','simplecadapi[editor,verify]==2.2.7','manifold3d==3.2.1','scipy']);
run(PYTHON,['-c',"import importlib.metadata as m; import simplecadapi; assert m.version('simplecadapi')=='2.2.7'; print('SimpleCADAPI',m.version('simplecadapi'))"]);
const info=spawnSync(PYTHON,['-c',"import sys,json,pathlib; print(json.dumps({'library_roots': [str(pathlib.Path(sys.base_prefix).resolve())]}))"],{encoding:'utf8'});
if(info.status!==0)throw Error('Could not inspect Python runtime');fs.writeFileSync(path.join(ROOT,'.runtime/python-environment.json'),info.stdout);
console.log('Ready. Run '+path.join(ROOT,'cad-code')+' --credentials /path/to/provider.json');
