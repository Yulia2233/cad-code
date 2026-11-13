# Assembly Workflow

This workflow starts after single-part reconstruction attempts have produced
the selected child notebooks. The trusted controller validates and snapshots
all notebooks, STEPIR v6.3 files, and the `step-assembly-ir-v1` document. The
input STEP is not an assembly coding input; use only supplied source facts and
selected notebooks.

## 1. Freeze and inspect inputs

Start with `assembly-context-index.json`, the bounded reasoning index. The
controller has already checked all source hashes, single-part verdicts, and
occurrence mappings against the immutable input manifest. Do not read the
complete manifest, complete assembly IR, every child notebook, or every
STEPIR into the context. Query only the index pages and local STEPIR evidence
for selected candidate relations; the complete snapshot remains available to
the trusted evaluator.

Use assembly IR placements and explicit geometric relations as facts. Keep
suggested mates and unresolved relations as hypotheses. Never treat a name,
product label, or guessed function as geometric evidence.

If the index reports a controller validation error, stop and report it. Do
not substitute another notebook or silently omit an occurrence.

## 2. Build an assembly source tree

Work in a new assembly attempt directory. Preserve the selected part files
byte-for-byte as source snapshots and record their hashes. Put one unique part
notebook under each stable path, for example
`parts/part-000/model.py`. Put the assembly notebook at `product.py`.

Use the composition rules in `notebook-composition.md`. In controller-owned
copies, adapt the product identity and add the static connector frames needed
by the scaffold. Use the recorded `make_part_rpart` constructor adaptation
when needed to capture those connectors in the modeling graph. Preserve the
child's geometry and modeling history; compare the copied source with its
snapshot and verify that its geometry is unchanged.

## 3. Preserve occurrences and source poses

The controller creates `out/product.py` with one grounded reference and a
fixed spanning tree containing every source occurrence. A repeated part uses
the same loaded definition with a distinct `component_id` and source
placement. Controller-adapted child copies contain per-occurrence connector
frames whose initial fixed residuals preserve those poses. Treat this as the
complete static baseline; do not recreate its full `scad.use()` and
occurrence lists from prompt context.

Convert the assembly IR's right-handed placement frame to the documented
SimpleCADAPI placement API. Confirm that the frame is orthonormal and has
positive handedness before using it. The placement origin and axes are in
millimetres and in the IR's stated coordinate convention.

When there is no well-supported motion candidate, retain the scaffold fixed
edge at the source placement. This creates a complete static assembly
hypothesis; it does not assert recovered source CAD history. Do not remove a
fixed edge without replacing it by a supported joint or an explicit reviewed
fallback.

## 4. Infer only supported relationships

For each proposed mate, record the geometric evidence, the selected
engineering interpretation, and any remaining ambiguity. Prefer explicit
local connector frames over raw face indices. Use face/edge queries only on
the corresponding child IR or reconstructed child geometry, and do not map a
target face ID directly to a rebuilt face index.

The scaffold's fixed constraints at recorded source poses are explicit static
assumptions, not claims that physical fixed interfaces were recovered. Retain
those defaults for unresolved and unreviewed occurrences. Claim a physical
fixed interface only when supplied evidence supports it. Replace a scaffold
edge with a revolute or prismatic constraint only when both geometry and the
stated or strongly supported function justify that motion. Omit guessed
travel limits or drive values. Ground only the component or components that
define the product frame; do not ground every part as a shortcut.

If a proposed motion constraint is underdetermined, conflicting, unsolved, or
moves components away from their source pose beyond the declared tolerance,
preserve the failed hypothesis in the report and restore its original fixed
edge. Do not hide a fallback behind a successful geometry score.

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
