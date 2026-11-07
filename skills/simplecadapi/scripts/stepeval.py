#!/usr/bin/env python3
"""Evaluate a STEP-reconstruction notebook against its target STEP: format check, fresh run, geometry comparison.

  python stepeval.py part.py target.step [--out eval/N] [--timeout 600]

Prints ONE JSON line (the full report is also written to <out>/eval.json):
  ok            true when everything below passes: format clean, run succeeded, one solid, riou >= 0.99, complete
  format        list of format problems (empty = clean); see the "Notebook format" section of the workflow
  run           "ok" or {"stage", "error", "source": the failing line, "line", "cell": the feature slug it belongs to}
  solids        number of solids in the product body (must be 1)
  riou          volumetric IoU of the two solids (mesh boolean), 1.0 = identical
  vol_err       |V_candidate - V_target| / V_target
  bbox_err      max abs difference of the bounding boxes, mm
  faces         face counts and surface-type counts of target and candidate
  complete      face count within 10 % (or 2) of the target's and every surface type at >= 80 % of its count:
                a missing fillet/chamfer group or detail shows up here even when riou is already high
  missing       up to 5 regions that the TARGET has and the candidate lacks: {"vol", "centroid", "bbox"}
  extra         up to 5 regions that the CANDIDATE has and the target lacks
The candidate STEP is written to <out>/candidate.step. The target is read only here, never by the notebook.

Needs SimpleCADAPI 2.2.7 (`pip install "simplecadapi[verify]"`) plus numpy and manifold3d.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

RIOU_PASS = 0.99
REL_DEFLECTION = 1.0e-4
ANGULAR_DEG = 8.0
ROLES = {"build", "add", "subtract", "intersect", "modify", "pattern", "annotate"}
FEATURE = re.compile(r"^# ---- feature: ([a-z0-9]+(?:-[a-z0-9]+)*) \((build|add|subtract|intersect|modify|pattern|annotate)"
                     r"(?:, (?:profile|path)=(?:sketch|geometry))*\) ----$")
PARAMS = re.compile(r"^# ---- params(?:: [^-].*)? ----$")
FORBIDDEN = [
    (re.compile(r"\.(step|stp|brep|scadbrep)\b", re.I), "names a STEP/BREP file: the notebook must not read the target"),
    (re.compile(r"\b(load_step|load_brep|copy_step_region|import_step|read_step|STEPControl|inspect\.brep|simplecadapi\.inspect)\w*"),
     "reads geometry from a file or inspects a shape: measure outside the notebook, write numbers as literals"),
    (re.compile(r"\bopen\(|\bPath\(|\bos\.|\bsubprocess\b"), "file or process access in the notebook"),
    (re.compile(r"\bGraphSession\b|@scad\.part\b|@scad\.assemble\b"), "no GraphSession / @scad.part in a notebook: the runtime records each cell"),
    (re.compile(r"\bprint\("), "no print in the notebook"),
]


# ----------------------------------------------------------------------------------------------------------- format
def notebook_id(text):
    m = re.search(r"^# \[tool\.simplecadapi\]\s*$(.*?)^# ///", text, re.M | re.S)
    if not m:
        return None
    m2 = re.search(r'^#\s*id\s*=\s*"([^"]+)"', m.group(1), re.M)
    return m2.group(1) if m2 else None


def cells(text):
    """[(first_line, last_line, header_comment, returned_names, body_text)] for every @app.cell function."""
    tree = ast.parse(text)
    lines = text.splitlines()
    out = []
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        if not any((isinstance(d, ast.Attribute) and d.attr == "cell") or
                   (isinstance(d, ast.Call) and getattr(d.func, "attr", "") == "cell") for d in node.decorator_list):
            continue
        body = lines[node.body[0].lineno - 1 - 3: node.end_lineno] if node.body else []
        first = next((l.strip() for l in lines[node.lineno: node.end_lineno] if l.strip()), "")
        ret = []
        last = node.body[-1] if node.body else None
        if isinstance(last, ast.Return) and last.value is not None:
            v = last.value
            ret = [e.id for e in (v.elts if isinstance(v, ast.Tuple) else [v]) if isinstance(e, ast.Name)]
        out.append((node.lineno, node.end_lineno, first, ret, "\n".join(lines[node.lineno - 1: node.end_lineno])))
    return out


def check_format(text):
    problems = []
    nid = notebook_id(text)
    if not nid:
        problems.append('header: missing "# [tool.simplecadapi]" table with id = "..."')
    if "with app.setup:" not in text:
        problems.append("setup: missing `with app.setup:` (imports go there)")
    try:
        cs = cells(text)
    except SyntaxError as e:
        return [f"syntax error line {e.lineno}: {e.msg}"]
    if not cs:
        return problems + ["no @app.cell"]
    for k, (a, _, head, ret, body) in enumerate(cs):
        last = k == len(cs) - 1
        if last:
            if "scad.Part(" not in body:
                problems.append(f"line {a}: the last cell must make the product scad.Part(part_id=..., body=...)")
            elif nid and f'part_id="{nid}"' not in body.replace("'", '"') and "notebook_id()" not in body:
                problems.append(f"line {a}: product part_id must equal the notebook id {nid!r}")
            continue
        if PARAMS.match(head):
            if re.search(r"scad\.(make|add|extrude|revolve|cut|union|fillet|chamfer|sweep|loft)_", body):
                problems.append(f"line {a}: the params cell holds geometry")
            continue
        m = FEATURE.match(head)
        if not m:
            problems.append(f"line {a}: cell must start with '# ---- feature: <slug> (<role>[, profile=sketch|geometry]) ----' "
                            f"or '# ---- params ----', found {head[:60]!r}")
            continue
        want = m.group(1).replace("-", "_")
        if ret != [want]:
            problems.append(f"line {a}: feature {m.group(1)!r} must return exactly ({want},), returns {tuple(ret)}")
    for pat, why in FORBIDDEN:
        for mm in pat.finditer(text):
            ln = text.count("\n", 0, mm.start()) + 1
            if text.splitlines()[ln - 1].lstrip().startswith("#") and "print" not in why:
                continue
            problems.append(f"line {ln}: {why}")
            break
    return problems


def cell_of_line(text, lineno):
    for a, b, head, _, _ in cells(text):
        if a <= lineno <= b:
            m = FEATURE.match(head)
            return m.group(1) if m else head[:40]
    return None


# ------------------------------------------------------------------------------------------------------------- run
RUNNER = r'''
import json, sys, traceback
from pathlib import Path
nb, out = sys.argv[1], Path(sys.argv[2])
rep = {}
stage = "run"
try:
    from simplecadapi.runtime import run_notebook
    import simplecadapi as scad
    from simplecadapi import exporter
    run = run_notebook(nb, cache=False)
    prod = run.product
    if not isinstance(prod, scad.Part):
        raise TypeError(f"product is {type(prod).__name__}, expected scad.Part")
    stage = "capture (the product is not a valid solid)"
    scad.capture(run.definition, str(out / "candidate.scadpkg"))
    stage = "export"
    exporter.export_product_package_to_step(str(out / "candidate.scadpkg"), str(out / "candidate.step"))
    rep["run"] = "ok"
except BaseException as e:
    tb = traceback.extract_tb(e.__traceback__)
    cell = [f.line for f in tb if "__marimo__cell_" in f.filename and f.line]
    msg = str(e).split("Evidence:")[0].strip()          # drop the SDK's diagnostic-render paths
    rep["run"] = {"stage": stage, "error": f"{type(e).__name__}: {msg[:700]}", "source": cell[-1] if cell else None}
print("@@RESULT@@" + json.dumps(rep))
'''


def run_notebook_fresh(nb, out, timeout):
    with tempfile.NamedTemporaryFile("w", suffix="_runner.py", delete=False) as fh:
        fh.write(RUNNER)
        runner = fh.name
    try:
        r = subprocess.run([sys.executable, "-I", runner, str(nb), str(out)], capture_output=True, text=True,
                           timeout=timeout, cwd=str(Path(nb).parent))
    except subprocess.TimeoutExpired:
        return {"run": {"error": f"timeout after {timeout} s"}}
    finally:
        os.unlink(runner)
    for line in r.stdout.splitlines()[::-1]:
        if line.startswith("@@RESULT@@"):
            return json.loads(line[len("@@RESULT@@"):])
    return {"run": {"error": f"runner crashed (exit {r.returncode}): {(r.stderr or r.stdout)[-600:]}"}}


# --------------------------------------------------------------------------------------------------------- compare
def sdk_solid(path):
    from simplecadapi.inspect import brep
    from simplecadapi._glue.bridge import from_occt
    return from_occt(brep.load_step_rshape(path=str(path)))


def mesh(path, diag):
    import numpy as np
    from simplecadapi.exporter._surface_mesh import tessellate_solid
    v, t = tessellate_solid(sdk_solid(path), linear_deflection=max(diag * REL_DEFLECTION, 1e-6),
                            angular_deflection_degrees=ANGULAR_DEG, relative=False)
    return np.asarray(v, float), np.asarray(t)


def regions(man, centre, limit=5):
    out = []
    for part in man.decompose():
        vol = part.volume()
        if vol <= 0:
            continue
        b = part.bounding_box()
        lo, hi = [x + c for x, c in zip(b[:3], centre)], [x + c for x, c in zip(b[3:], centre)]
        mesh_ = part.to_mesh()
        import numpy as np
        cen = np.asarray(mesh_.vert_properties, float)[:, :3].mean(axis=0) + centre
        out.append({"vol": round(vol, 4), "centroid": [round(float(x), 3) for x in cen],
                    "bbox": [[round(float(x), 3) for x in lo], [round(float(x), 3) for x in hi]]})
    out.sort(key=lambda r: -r["vol"])
    return out[:limit]


def compare(target, cand):
    import numpy as np
    import manifold3d as m3d
    from simplecadapi.inspect import brep
    st, sc = brep.inspect_step_rsummary(path=str(target)), brep.inspect_step_rsummary(path=str(cand))
    diag = st["bounding_box"]["diagonal"]
    (vt, tt), (vc, tc) = mesh(target, diag), mesh(cand, diag)
    centre = (vt.min(axis=0) + vt.max(axis=0)) / 2.0

    def man(v, t):
        m = m3d.Manifold(m3d.Mesh(vert_properties=np.asarray(v - centre, np.float32), tri_verts=np.asarray(t, np.uint32)))
        if m.status() != m3d.Error.NoError:
            raise ValueError(f"mesh is not closed: {m.status()}")
        return m
    a, b = man(vt, tt), man(vc, tc)
    va, vb, inter = a.volume(), b.volume(), (a ^ b).volume()
    bt, bc = st["bounding_box"], sc["bounding_box"]
    bbox_err = max(abs(bt[k][i] - bc[k][i]) for k in ("min", "max") for i in range(3)) if "min" in bt else None
    faces = {"target": st["face_count"], "candidate": sc["face_count"],
             "types_target": st.get("surface_type_statistics"), "types_candidate": sc.get("surface_type_statistics")}
    return {"faces": faces, "riou": round(inter / (va + vb - inter), 5) if va + vb - inter > 0 else 0.0,
            "vol_err": round(abs(vb - va) / max(va, 1e-12), 5),
            "bbox_err": round(bbox_err, 4) if bbox_err is not None else None,
            "missing": regions(a - b, centre), "extra": regions(b - a, centre)}


# ------------------------------------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("notebook")
    ap.add_argument("target")
    ap.add_argument("--out")
    ap.add_argument("--timeout", type=float, default=600)
    a = ap.parse_args()
    nb, target = Path(a.notebook).resolve(), Path(a.target).resolve()
    out = Path(a.out).resolve() if a.out else nb.parent / "eval" / time.strftime("%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    text = nb.read_text()
    rep = {"notebook": str(nb), "format": check_format(text)}
    rep.update(run_notebook_fresh(nb, out, a.timeout))
    if isinstance(rep["run"], dict) and rep["run"].get("source"):
        src = rep["run"]["source"].strip()
        hit = [i + 1 for i, l in enumerate(text.splitlines()) if l.strip() == src]
        if hit:
            rep["run"]["line"] = hit[0]
            rep["run"]["cell"] = cell_of_line(text, hit[0])
    if rep["run"] == "ok":
        try:
            from simplecadapi.inspect import brep
            rep["solids"] = brep.inspect_step_rsummary(path=str(out / "candidate.step"))["body_count"]
            rep.update(compare(target, out / "candidate.step"))
        except Exception as e:  # noqa: BLE001 - reported, not raised
            rep["compare_error"] = f"{type(e).__name__}: {str(e)[:300]}"
            rep["trace"] = traceback.format_exc()[-800:]
    f = rep.get("faces")
    if f:
        tt, tc = f.get("types_target") or {}, f.get("types_candidate") or {}
        rep["complete"] = (abs(f["candidate"] - f["target"]) <= max(2, 0.1 * f["target"])
                           and all(tc.get(k, 0) >= 0.8 * v for k, v in tt.items()))
    rep["ok"] = (not rep["format"] and rep["run"] == "ok" and rep.get("solids") == 1
                 and rep.get("riou", 0) >= RIOU_PASS and rep.get("complete", False))
    rep["candidate_step"] = str(out / "candidate.step") if rep["run"] == "ok" else None
    (out / "eval.json").write_text(json.dumps(rep, indent=1))
    rep.pop("trace", None)
    print(json.dumps(rep, separators=(",", ":")))


if __name__ == "__main__":
    main()
