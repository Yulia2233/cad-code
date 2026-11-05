#!/usr/bin/env python3
"""Local (non-docker) port of the frozen execute.py + compare.py evaluation harness.

Logic is identical to
CAD-SFT/megatron_sft/logs/runs/qwen3-8b-val750-cad-eval-20261016/harness/{execute,compare}.py:
  execute: import candidate.py, call build(), scad.capture(..., include_scene=False),
           export_product_package_to_step
  compare: strict bidirectional boolean material IoU (boolean_tolerance=None); any failure -> IoU 0.
Only the filesystem paths are parameterised. Run it with the cad214 venv (SimpleCADAPI 2.1.4,
the version the historical numbers were measured with).

CLI:
  cadeval.py eval --code cand.py --target target.step --out DIR [--timeout 120] [--cmp-timeout 600]
Prints one JSON line:  {"iou": float, "status": str, ...}
"""
import argparse
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cadthreads  # noqa: E402

HARNESS_COMPARE = Path(os.environ.get("CADEVAL_COMPARE") or (Path(__file__).resolve().parent / "frozen" / "compare.py"))


def _execute_inner(code_path, out_dir):
    """Runs inside a subprocess (mirrors frozen execute.py)."""
    cadthreads.limit()
    started = time.monotonic()
    out = Path(out_dir)
    report = {"import_succeeded": False, "build_succeeded": False,
              "capture_succeeded": False, "export_succeeded": False}
    try:
        work = out / "work"
        work.mkdir(parents=True, exist_ok=True)
        os.chdir(work)
        shutil.copyfile(code_path, work / "candidate.py")
        spec = importlib.util.spec_from_file_location("candidate", str(work / "candidate.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        report["import_succeeded"] = True
        if not callable(getattr(module, "build", None)):
            raise ValueError("generated code defines no callable build()")
        product = module.build()
        report["build_succeeded"] = True
        import simplecadapi as scad
        from simplecadapi import exporter
        scad.capture(product, str(out / "product.scadpkg"), include_scene=False)
        report["capture_succeeded"] = True
        exporter.step.export_product_package_to_step(data=str(out / "product.scadpkg"),
                                                     output_path=str(out / "rebuilt.step"))
        report["export_succeeded"] = True
    except BaseException as error:  # noqa: BLE001 - mirrors frozen harness
        traceback.print_exc()
        report["error_type"] = type(error).__name__
        report["error"] = str(error)[:1500]
    finally:
        report["seconds"] = time.monotonic() - started
        (out / "execution.json").write_text(json.dumps(report, allow_nan=False, indent=2) + "\n")
    return 0 if report["export_succeeded"] else 1


def _compare_inner(target, current, out_json):
    cadthreads.limit()
    spec = importlib.util.spec_from_file_location("frozen_compare", str(HARNESS_COMPARE))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        result = mod.compare(target, current)
    except BaseException as error:  # noqa: BLE001
        traceback.print_exc()
        result = {"status": "comparison_error", "iou": 0.0, "comparison_succeeded": False,
                  "error_type": type(error).__name__, "error": str(error)[:1500]}
        try:
            cand = mod.inspect(current)
            result.update(candidate=cand, candidate_valid=mod.solid(cand))
        except Exception:  # noqa: BLE001
            result["candidate_valid"] = False
    Path(out_json).write_text(json.dumps(result, indent=2, allow_nan=False, default=str) + "\n")
    return 0


def evaluate(code_path, target_step, out_dir, timeout=120, cmp_timeout=600, python=None, metrics_python=None):
    """Execute one candidate and compare against target. Returns a summary dict (iou is 0 on any failure)."""
    python = python or sys.executable
    code_path = Path(code_path).resolve()
    target_step = Path(target_step).resolve()
    out = Path(out_dir).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    summary = {"iou": 0.0, "status": "execution_failed", "build_ok": False, "export_ok": False,
               "valid_cad": False, "compared": False}
    try:
        proc = subprocess.run(
            [python, "-I", str(Path(__file__).resolve()), "_exec", "--code", str(code_path), "--out", str(out)],
            capture_output=True, text=True, timeout=timeout)
        (out / "execute.stderr.txt").write_text(proc.stderr[-6000:])
    except subprocess.TimeoutExpired:
        summary["status"] = "execution_timeout"
        return summary
    try:
        ex = json.loads((out / "execution.json").read_text())
    except Exception:  # noqa: BLE001
        summary["status"] = "no_execution_report"
        return summary
    summary.update(build_ok=ex.get("build_succeeded", False), export_ok=ex.get("export_succeeded", False),
                   exec_error=(ex.get("error_type", "") + ": " + ex.get("error", ""))[:300] if "error" in ex else "")
    if not ex.get("export_succeeded"):
        summary["status"] = "build_failed" if not ex.get("build_succeeded") else "export_failed"
        return summary
    summary.update(riou=0.0, robust_ok=False)
    if metrics_python:
        try:
            rp = subprocess.run([metrics_python, "-I", str(Path(__file__).resolve().parent / "robust_iou.py"), str(target_step),
                                 str(out / "rebuilt.step")], capture_output=True, text=True, timeout=cmp_timeout)
            rj = json.loads(rp.stdout.strip().splitlines()[-1])
            summary.update(riou=float(rj.get("riou", 0.0)), robust_ok=bool(rj.get("ok")), rel_vol_err=rj.get("rel_vol_err"),
                           cd=rj.get("cd"), hd=rj.get("hd"))
        except Exception:  # noqa: BLE001
            pass
    try:
        subprocess.run([python, "-I", str(Path(__file__).resolve()), "_cmp", "--target", str(target_step),
                        "--current", str(out / "rebuilt.step"), "--out", str(out / "comparison.json")],
                       capture_output=True, text=True, timeout=cmp_timeout)
        cmp = json.loads((out / "comparison.json").read_text())
    except subprocess.TimeoutExpired:
        summary["status"] = "compare_timeout"
        return summary
    except Exception:  # noqa: BLE001
        summary["status"] = "no_comparison_report"
        return summary
    summary.update(status=cmp.get("status"), iou=float(cmp.get("iou", 0.0)) if cmp.get("comparison_succeeded") else 0.0,
                   valid_cad=bool(cmp.get("candidate_valid")), compared=bool(cmp.get("comparison_succeeded")),
                   cmp_error=cmp.get("error", "")[:300] if cmp.get("error") else "")
    for k in ("target_volume", "candidate_volume", "intersection_volume", "union_volume"):
        if k in cmp:
            summary[k] = cmp[k]
    if not math.isfinite(summary["iou"]):
        summary["iou"] = 0.0
    return summary


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("eval")
    e.add_argument("--code", required=True)
    e.add_argument("--target", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--timeout", type=int, default=120)
    e.add_argument("--cmp-timeout", type=int, default=600)
    e.add_argument("--metrics-python", default=None)
    x = sub.add_parser("_exec")
    x.add_argument("--code", required=True)
    x.add_argument("--out", required=True)
    c = sub.add_parser("_cmp")
    c.add_argument("--target", required=True)
    c.add_argument("--current", required=True)
    c.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.cmd == "_exec":
        raise SystemExit(_execute_inner(a.code, a.out))
    if a.cmd == "_cmp":
        raise SystemExit(_compare_inner(a.target, a.current, a.out))
    res = evaluate(a.code, a.target, a.out, a.timeout, a.cmp_timeout, metrics_python=a.metrics_python)
    print(json.dumps(res, allow_nan=False))


if __name__ == "__main__":
    main()
