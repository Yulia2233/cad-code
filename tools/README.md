# Session CAD tools

New CLI, web and review sessions receive their own `workspace/<session-id>/tools/` directory. Sources are bundled here; cad-code does not depend on an external research checkout. Existing regular files are preserved on resume; missing files are filled in. Symlinked tool directories/files are rejected. Session copies are editable and are not trusted final benchmark scorers.

| File | Purpose |
|---|---|
| `stepir.py` | Inspect a STEP file and emit compact face/carrier/boundary IR |
| `cadeval.py` | Run a Python module's `build()`, capture/export STEP, compare to a target |
| `families_common.py` | Canonical sketch planes and profile-code helpers |
| `cadthreads.py` | Limit CAD kernel threads |
| `robust_iou.py` | Tessellated mesh IoU and optional surface-distance metrics |
| `frozen/compare.py` | Strict BREP comparison used by cadeval |
| `cad.py` | Interactive notebook/module export, inspect and render helper |

The six reverse-engineering/assessment source files were copied byte-for-byte on 2026-11-05 from the training project's `research/tools/` (original absolute root `/Users/liuyu/Documents/auto-research/step-8B-sft`). Hashes are recorded in `manifest.json`; `cad.py` is cad-code's existing helper. Historical metrics used SimpleCADAPI2.1.4; cad-code runs2.2.5, so these local diagnostics do not establish scores comparable to the frozen server benchmark.

Run with the Python path supplied in the runtime prompt:

```bash
"$CAD_CODE_PYTHON" tools/stepir.py input/target.step --out target.ir.jsonl
"$CAD_CODE_PYTHON" -I tools/cadeval.py eval \
  --code out/rebuild.py --target input/target.step --out out/check-1 \
  --metrics-python "$CAD_CODE_PYTHON"
```

Use a fresh `out/check-N` each time: cadeval removes/recreates its output directory. It accepts library modules exposing `build()`; for marimo notebooks use `tools/cad.py export` instead. `npm run setup` installs the SDK, manifold3d and SciPy. Geometry inspection may read the target; final generated code must reconstruct independently rather than load/copy target geometry. Local writable tool copies do not replace independent final-source replay or a trusted external scorer.
