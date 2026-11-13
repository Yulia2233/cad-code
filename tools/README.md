# Scorer support (not session tools)

Sessions no longer receive a `tools/` directory. The CAD scripts an agent uses are the skill's own, run read-only by path:

```bash
"$CAD_CODE_PYTHON" skills/simplecadapi/scripts/stepir.py input/target.step --out target.ir.jsonl
"$CAD_CODE_PYTHON" skills/simplecadapi/scripts/stepeval.py part.py input/target.step --out eval/1
```

(the runtime prompt gives the absolute path of `skills/simplecadapi/scripts`).

The legacy scoring helpers are used by bench_cli's independent scorer:

| File | Purpose |
|---|---|
| `cadeval.py` | replay a plain module's `build()`, export STEP, strict B-rep IoU (legacy `rebuild.py` / `final.py` candidates) |
| `robust_iou.py` | tessellated mesh IoU and surface distances (works on SimpleCADAPI 2.2.5 and 2.2.7) |
| `frozen/compare.py` | strict BREP comparison used by cadeval |
| `cadthreads.py` | limit CAD kernel threads |

Notebook candidates are replayed by `bench_cli/src/replay_notebook.py`. The former session helpers (`cad.py`, `families_common.py`,
and copies of `stepir.py` / `stepeval.py`) were moved to `.runtime/tools-backup/` on 2026-11-07.

`assembly_delivery.py` is an assembly-only build helper, referenced by the separate assembly runtime prompt. It builds a source assembly with SimpleCADAPI 2.2.7, exports its package and STEP, and reports real constraint residuals. Its report explicitly leaves independent acceptance pending; `multi/assemblyeval.py` performs that check in a separate source-only replay. Normal single-part sessions and prompts do not use this helper.
