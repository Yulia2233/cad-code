# Assembly Workflow

This workflow starts after single-part reconstruction attempts have produced
the selected child notebooks. It consumes those notebooks as authored, their
STEPIR v6.3 files, and a `step-assembly-ir-v1` document. The input STEP is not
an assembly coding input; use only the supplied source facts and selected
notebooks.

## 1. Freeze and inspect inputs

Read the project manifest and `assembly-inputs.json`. Check that every selected
unique part has one notebook, one STEPIR v6.3 file, matching recorded SHA-256
hashes, and a usable single-part verdict. Check that every source occurrence
maps to exactly one `part_id` and that all occurrence IDs are unique.

Use assembly IR placements and explicit geometric relations as facts. Keep
suggested mates and unresolved relations as hypotheses. Never treat a name,
product label, or guessed function as geometric evidence.

If an input is missing, has a mismatched hash, uses another STEPIR version, or
has an invalid part result, stop and report the exact item. Do not substitute
another notebook or silently omit an occurrence.

## 2. Build an assembly source tree

Work in a new assembly attempt directory. Preserve the selected part files
byte-for-byte as source snapshots and record their hashes. Put one unique part
notebook under each stable path, for example
`parts/part-000/model.py`. Put the assembly notebook at `product.py`.

Use the composition rules in `notebook-composition.md`. Adapt only the product
identity in a copied notebook when required by the assembly runtime. Compare
the adapted child with its source and verify that its geometry is unchanged.

## 3. Preserve occurrences and source poses

Create one component instance for every `instances[]` row. A repeated part
uses the same loaded part definition with a distinct `component_id` and the
placement for that occurrence.

Convert the assembly IR's right-handed placement frame to the documented
SimpleCADAPI placement API. Confirm that the frame is orthonormal and has
positive handedness before using it. The placement origin and axes are in
millimetres and in the IR's stated coordinate convention.

When there is no well-supported mate, author the occurrence at its source
placement. This default preserves a static reconstruction of the supplied
pose. It does not assert a fixed connection, a recovered design intent, or a
motion model.

## 4. Infer only supported relationships

For each proposed mate, record the geometric evidence, the selected
engineering interpretation, and any remaining ambiguity. Prefer explicit
local connector frames over raw face indices. Use face/edge queries only on
the corresponding child IR or reconstructed child geometry, and do not map a
target face ID directly to a rebuilt face index.

Use a fixed constraint only when the supplied evidence supports a fixed
interface. Use a revolute or prismatic constraint only when both geometry and
the stated or strongly supported function justify that motion. Omit guessed
travel limits or drive values. Ground only the component or components that
define the product frame; do not ground every part as a shortcut.

If a proposed constraint is underdetermined, conflicting, unsolved, or moves
components away from their source pose beyond the declared tolerance, preserve
the failed hypothesis in the report and retain source placements for affected
components. Do not hide a fallback behind a successful geometry score.

## 5. Build and validate

Read the exact API pages for the APIs used. For a static assembly, use the
documented assembly and component-placement APIs. For a constrained assembly,
read the connector, constraint, grounding, solve, and residual inspection
pages before calling them.

Run the notebook from a clean cache, then use the supplied independent
assembly evaluator. Check all of the following separately:

- every source occurrence is represented exactly once;
- each occurrence references the intended unique part;
- each child result remains a valid single part;
- realized component placements agree with the source placements or with a
  clearly reported, supported constraint solution;
- all used constraints report their actual solve state and residuals;
- package and STEP exports exist and can be reopened when those outputs are
  requested.

Do not equate a valid Assembly object with a successful geometry evaluation.
Report `geometry_pass`, `mate_status`, and evaluator errors independently.

## 6. Deliver and report

Keep `product.py`, all child notebooks, and required project modules together
with relative paths. Deliver the full source tree, the package, the exported
STEP, and the evaluator report as requested. Record the source hashes, IR
hashes, notebook hashes, SDK version, and assembly attempt ID.

State which occurrences use source-placement fallback, which mates were
inferred, which constraints were solved, the measured residuals, and every
unresolved assumption. Do not describe a fallback-only assembly as having
recovered mechanical constraints.
