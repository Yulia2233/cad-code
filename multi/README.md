# Multi-solid reconstruction and assembly

This extension keeps STEPIR v6.3, SimpleCADAPI 2.2.7, the single-part prompt, the original executor, and `cad-code-session-v2` exports. The original CLI and Web upload have additive routing blocks. A one-solid STEP continues through the original route; multiple solids create a project containing one ordinary reconstruction session per unique part and a separately requested assembly session.

## Setup

Use the existing CAD Code setup and credentials. Do not write keys into project configuration. `CAD_CODE_PYTHON` must name the 2.2.7 virtual-environment interpreter, preserving its symlink path. Set `CAD_CODE_MULTISOLID_PART_PROMPT` to the unchanged single-part `prompt_v63.md`. Only installed tool paths are substituted; task instructions are preserved.

The bundled preprocessing module and assembly skill are pinned in `multi/vendor-manifest.json`. The assembly skill is under `tools/assembly-skill`; it is loaded only by assembly sessions. The normal skill under `skills/simplecadapi` is unchanged. In assembly copies only, the notebook adapter changes a product's identity to `scad.notebook_id()`, uses `make_part_rpart` to record the part in the graph, and adds controller-generated occurrence connector frames. Original child notebooks, modeling operations, and single-part histories are preserved.

```sh
export CAD_CODE_PYTHON=/path/to/cad-code/.runtime/python/bin/python
export CAD_CODE_MULTISOLID_PART_PROMPT=/path/to/prompt_v63.md
./cad-code --file part-or-assembly.step run "existing single-part task"
./cad-code prepare --file assembly.step --out projects/demo
./cad-code run-parts --project projects/demo --parallel 4
./cad-code status --project projects/demo --json
./cad-code assemble --project projects/demo --wait --timeout 600
./cad-code export --project projects/demo --out exports/demo
./cad-code-multi --web
```

`cad-code-multi` provides the same project subcommands. Default workbench port is 8773 (`CAD_CODE_MULTI_PORT`). It binds only localhost. It supports upload, per-part attempt selection, concurrency, manual assembly, conversation/tool display, follow-up, and verified artifact downloads. The original Web upload routes a new multi-solid task to this workbench.

`assemble --parts` accepts a JSON array of `{part_id,attempt_id}` rows. Without it, the CLI uses saved selections or the latest completed attempt with runnable Python and STEP. Geometry below the acceptance threshold remains visible; assembly evaluation makes the final decision. Assembly never starts automatically after parts unless an explicit caller chooses to do so.

## Project and recovery

`project.json` uses `cad-code-project-v1`, with `unique_parts[].attempts[]`, full occurrence mappings, revision numbers, and assembly attempts. `assembly.ir.json` binds each representative STEP/IR to source placements. `input/assembly-inputs.json` is the selected snapshot; adapted child notebooks live in `out/parts/<part-id>/model.py`.

## Bounded assembly reasoning and static default

The controller validates the complete input snapshot, then creates `input/assembly-context-index.json` and hash-registered `input/assembly-index/` pages. Part pages contain at most 48 definitions, occurrence pages 96 placements, and the candidate list exposes at most 64 relations. The agent starts with this index and queries only relevant local evidence; it does not need every child notebook or STEPIR in its context. Full inputs remain available for independent replay and historical trajectory schemas stay compatible.

Before the assembly turn, the controller generates `out/product.py`: one `scad.use()` per unique definition, every source occurrence at its recorded pose, one grounded reference, and a fixed spanning star. Each edge has occurrence-specific connector frames, including when multiple occurrences reuse one definition. The source-only scaffold can be built and exported without asking the agent to enumerate all parts. A default fixed edge is an explicit static assumption, not a claim that the original mechanical interface was fixed. The agent may replace a fixed edge only with an evidenced motion joint and must keep complete occurrence coverage.

Current candidate discovery is limited: the preprocessor produces nearest-neighbor AABB distance bounds, not inferred revolute/prismatic mates. These bounds are not presented as motion candidates. Without explicit mate suggestions, new projects therefore keep the complete fixed baseline; paging and the sparse review policy do not by themselves discover moving parts. Neighbor discovery still compares all pairs; the retained relation output, not preprocessing CPU complexity, is bounded.

For a static scaffold, the assembly runtime supplies a standard `tools/assembly_delivery.py` command. It builds the existing source notebook, measures actual constraint residuals, exports the package and STEP, and writes factual build observations to `out/assembly-report.json`. It never claims independent acceptance or infers physical joint intent. The controller still runs source-only independent replay and geometry acceptance after the agent turn. This avoids agent-written packaging scripts and repeated successful checks while preserving real tool observations in the raw trajectory.

Part queues have 1–40 slots and one runtime-wide lease. A second active project queue is rejected, preventing project concurrency from multiplying the limit. The batch wrapper processes projects sequentially while each project uses the selected slots. `resume --project ...` recovers owned sessions and export/evaluation stages without resending ambiguous submissions. `--retry-failed` allows bounded new attempts. `stop --project ...` stops only recorded project-owned sessions. On Linux, launch long-running services/queues in tmux.

Each part is independently evaluated with the unchanged `stepeval.py`; an agent-written verdict is ignored. The evaluated `candidate.step` is the canonical part delivery. The originally submitted STEP is retained separately.

## Assembly evaluation

The trusted controller creates a separate evaluation input manifest with SHA256s for every delivered Python source. It runs a fresh source-only replay with sandbox-exec on macOS or bubblewrap on Linux. Source STEP, IR, sibling projects, old packages/caches, and network are unavailable during replay. Files are read-only except an independent scratch/output directory. Original single-part sandbox code is unchanged.

After replay, the trusted parent reopens the package, regenerates the STEP, and checks each source occurrence's ID, definition ID, placement and geometry. Missing small components cannot be hidden by overall IoU. `assembly-verdict-v1` separates `geometry_pass`, coverage, constraints, and `mate_status`. Static placement is the default for floating or ambiguous parts; it is reported as `source_placement`. A completed conversation alone is not a passing verdict.

Evaluation inputs and results are versioned per follow-up turn. Prior verdict files are retained; session exports keep the actual model messages, tools, original image bytes, and empty reasoning when the provider returns no reasoning.

## Compatibility and validation

`node multi/freeze-check.mjs` checks the original file hashes. For the three original integration files it first removes explicitly marked additive blocks, proving the old code remains byte-identical. `CAD_CODE_SINGLE_SOLID=1` is an explicit legacy-entry mode for reproducing historical CLI fixture tests; normal uploads use automatic counting.

```sh
CAD_CODE_PYTHON=/path/to/python CAD_CODE_SINGLE_SOLID=1 npm test
node --test multi/public/app.test.mjs
/path/to/python -I multi/tests/test_assembly_replay.py -v
/path/to/python -m unittest discover -s multi -p 'test_notebook_adapter.py' -v
```

Historical benchmark and training directories are never rewritten by this extension. New batch artifacts are under `stepir_geom_gen/cadcode_synth_multisolid`; training packaging uses an independent dataset and excludes evaluation provenance and hashes. Unsupported geometry is reported explicitly with diagnostics; no failed split is admitted as a validated part.
