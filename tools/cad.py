"""Small verified SDK entry points available to the local CAD agent."""
import argparse, importlib.util, json
from pathlib import Path
import simplecadapi as scad
from simplecadapi import exporter
from simplecadapi.inspect import brep

def main():
    ap=argparse.ArgumentParser();sub=ap.add_subparsers(dest='command',required=True)
    p=sub.add_parser('export');p.add_argument('code');p.add_argument('--out',default='out')
    p=sub.add_parser('render');p.add_argument('step');p.add_argument('--out',default='out/model.png')
    p=sub.add_parser('inspect');p.add_argument('step')
    a=ap.parse_args()
    if a.command=='export':
        code=Path(a.code).resolve();out=Path(a.out).resolve();out.mkdir(parents=True,exist_ok=True)
        if '[tool.simplecadapi]' in code.read_text():
            from simplecadapi.runtime import run_notebook
            result=run_notebook(str(code)).definition
        else:
            spec=importlib.util.spec_from_file_location('cad_code_model',code);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
            result=m.build()
        pkg=out/'product.scadpkg';scad.capture(result,str(pkg))
        step=out/'model.step';exporter.step.export_product_package_to_step(data=str(pkg),output_path=str(step))
        summary=brep.inspect_step_rsummary(path=str(step))
        if not summary.get('valid') or summary.get('volume',0)<=0:raise RuntimeError('Exported STEP is not valid positive-volume CAD')
        info={'step':str(step),'valid':summary['valid'],'volume':summary['volume'],'faces':summary.get('face_count'),'material_body_count':summary.get('material_body_count')}
        try:
            stl=out/'model.stl';exporter.stl.export_product_package_to_stl(data=str(pkg),output_path=str(stl));info['stl']=str(stl)
        except (AttributeError,TypeError) as e:info['stl_error']=str(e)
        (out/'validation.json').write_text(json.dumps(info,ensure_ascii=False,indent=2));print(json.dumps(info,ensure_ascii=False))
    elif a.command=='render':
        out=Path(a.out);out.parent.mkdir(parents=True,exist_ok=True)
        print(brep.render_step_views_rpath(step_path=str(Path(a.step).resolve()),output_path=str(out.resolve())))
    else:print(json.dumps(brep.inspect_step_rsummary(path=str(Path(a.step).resolve())),ensure_ascii=False,default=str))

if __name__=='__main__':main()
