# Multi-Solid STEP Preprocessor

This package prepares a multi-solid STEP assembly for the existing STEPIR v6.3 single-solid workflow. Geometry import, solid selection, transforms, STEP output, and equivalence checks use the pinned `simplecadapi==2.2.7` runtime. It does not change the existing single-solid parser or reconstruction prompt.

## Commands

Inspect a source file and print machine-readable JSON:

```bash
python multisolid/cli.py inspect input.step
```

Split, conservatively deduplicate, and generate v6.3 IR for each unique part:

```bash
python multisolid/cli.py prepare input.step --out work/multisolid/project-001 --stepir-script /path/to/frozen-v6.3/stepir.py
```

The default subprocess interpreter is the interpreter running this command. Set `MULTISOLID_PYTHON` or pass `--python` to select a different interpreter. Pass the frozen v6.3 bundled script with `--stepir-script`, or set `MULTISOLID_STEPIR_SCRIPT`. No CAD Code checkout layout is assumed, and the existing `cand/` parser and `bundle/` sources are not modified. The output directory must not already exist.

## Output

```text
project-001/
  source/source.step
  split/instance-NNN.step
  unique/part-NNN/target.step
  unique/part-NNN/target.ir.jsonl
  unique/part-NNN/ir_version.txt
  preprocess/split-manifest.json
  preprocess/dedup-report.json
  assembly.ir.json
```

All paths inside persisted JSON are relative to the project directory. `assembly.ir.json` uses schema `step-assembly-ir-v1`; each instance records a rigid `transform_from_representative` and SimpleCADAPI `placement`. Unique targets retain their source-world coordinates, so the representative instance uses identity placement. Other occurrences preserve their source STEP location.

The version-pinned SDK XCAF adapter enumerates every leaf occurrence separately and preserves its full path and name. Coincident occurrences remain distinct, including repeated child shapes within a compound. Each exported solid is checked against its original raw solid in source-world coordinates. Roundtrip verification requires valid SDK-imported solids, `Solid.same_topology`, and maximum bounding-box error at most `max(diagonal, 1 mm) * 1e-8`. Material evidence must be either relative volume error at most `1e-8` with both SDK directional cuts empty, or independently recomputed float64 manifold3d mesh IoU at least `1 - 1e-8`. The mesh check uses bounded deflection refinement from `diagonal * 1e-5` through `1e-7`. PCA normalization is never part of roundtrip verification. This gate is separate from the stricter duplicate identity gate below: the SDK absolute `1e-9 mm³` integration threshold and rounded area/centroid label buckets can reject decimal STEP serialization at otherwise matching geometry. The preprocessor reports pairwise bounding-box distance lower bounds as limited geometric evidence: a positive bound proves separation, while zero does not prove contact. Engineering mates remain unresolved with the `source_placement` fallback.

## Duplicate Policy

Candidate matching is only a pruning step. A merge requires the SDK `compare_shapes_rbrepcomparison` hard gate to pass on the representative transformed into the occurrence source-world pose. Both material point-set equality and geometry-labelled topology isomorphism must pass at the unchanged SDK tolerances: 1e-7 mm geometric and 1e-9 mm³ Boolean volume. Volume, bounding boxes, and vertex moments never authorize a merge by themselves.

For asymmetric solids with a distinct vertex-covariance frame, the preprocessor estimates a rigid candidate frame and verifies it geometrically. If the frame is degenerate, sign-ambiguous, or rejected by the SDK transform, it falls back to translation-only matching. Such cases remain separate unless a verified translation passes the strict check; the dedup report records the alignment mode or failure reason. Symmetric solids and STEP files with different topological segmentation can therefore remain separate even when they may be equivalent. This is a deliberate false-negative bias.

The SDK XCAF occurrence traversal and child order define `solid-NNN` IDs for one input hash. The source SHA256, split STEP hashes, unique target hashes, STEPIR hashes, SDK version, and preprocessing version are persisted for traceability.

## Tests

Run the deterministic synthetic split/dedup test with a SimpleCADAPI 2.2.7 environment and a frozen v6.3 bundled script:

```bash
export MULTISOLID_PYTHON=/path/to/python-with-simplecadapi-2.2.7
export MULTISOLID_STEPIR_SCRIPT=/path/to/frozen-v6.3/stepir.py
"$MULTISOLID_PYTHON" -m unittest discover -s multisolid -p 'test_*.py' -v
```

Tests cover translated and rotated duplicates, distinct solids, strict rejection of displacement and reflection, preserved coincident occurrences, source-world transform reconstruction, and v6.3 IR headers. The v6.3 script is SHA256-pinned to `bce850d29452142f8e54387d8a4a7c820ced744fb61aa3e953b71c8aa4bb371c`; a different script is rejected before any IR is labelled v6.3.

A serialization check can still fail because of Boolean instability, topology changes, relative volume drift, or mesh mismatch. Such inputs are reported as `unsupported_input` with the exact failed checks and all attempted independent mesh results. No failed serialization or duplicate identity check is accepted. The CLI runs preprocessing in a supervised worker, records its last stage, and reports native crashes or deadlines (`--timeout`, default 900 seconds) explicitly. Failure reports are saved next to the requested project as `<name>.unsupported.json`; no accepted project is emitted.
