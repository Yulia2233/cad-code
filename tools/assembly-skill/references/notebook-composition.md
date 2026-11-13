# Notebook Composition

SimpleCADAPI 2.2.7 composes notebooks through product definitions. The
assembly notebook loads a child with `scad.use(...)`, then adds one or more
component occurrences to an `Assembly`. Keep each child's modeling history in
its own notebook.

## Preserve source notebooks

Copy the selected notebook into the assembly attempt's relative source tree
and record the source and copy hashes. If the part declares a literal
`Part(part_id="model", ...)`, adapt that product identity in the copy to
`Part(part_id=scad.notebook_id(), ...)` when needed for composition. The
controller may also adapt the constructor to `make_part_rpart` and append
static connector frames so the scaffold records connectors in the modeling
graph. Do not change geometry, dimensions, operation order, sketch constraints,
or comments that carry reconstruction evidence.

The assembly runner makes and records these narrow identity and connector
adaptations before the agent receives the files. If the source cannot be recognized safely, report
the incompatibility rather than rewriting it by broad text replacement.
After adaptation, compare the built solid's volume and bounds with the
unmodified child result within the configured tolerance.

## Reuse definitions; keep occurrences

Load each unique part notebook once using a stable definition ID, for example:

```python
part_000 = scad.use("parts/part-000/model.py", id="part-000")
```

For every `instances[]` row that references `part-000`, add a separate
component using that same `part_000` product, a unique `component_id`, and the
row's placement. Do not create a new modeling history for an identical
repeated instance, and do not collapse coincident instances.

Use `make_assembly_rassembly` and `add_component_rassembly` for explicit
component structure. Use `make_placement_rplacement(origin, x_axis, y_axis)`
for the IR's local frame only after confirming the axes meet the API's
right-handed placement requirements. Check the exact API documentation for
the installed 2.2.7 SDK before authoring calls.

## Connectors and constraints

Attach the controller's static connector frames to assembly copies before
child definitions are captured. These support the source-pose fixed scaffold
as an explicit static assumption; they do not prove physical fixed interfaces.
Add or change mate connectors only for evidence-supported relationships. Use
explicit local datum frames where possible; avoid unstable face-index
assumptions. Keep connector frames on the part-local geometry, then use
documented constraints at the assembly level.

Ground a true reference component before solving constraints. Inspect the
constraint report and residuals. If a solver moves a component away from the
source placement beyond tolerance or the solve fails, restore the scaffold's
source-pose fixed edge and report the failed constraint hypothesis.

## Source tree and ID rules

- Keep notebook paths relative and inside the assembly attempt tree.
- Give each unique part a stable definition ID and each occurrence a distinct
  component ID.
- Repeated occurrences share the same child product definition but have
  independent placements.
- Keep `product.py` as the assembly notebook and return an Assembly whose ID
  matches the notebook's effective ID.
- Preserve child file hashes and the identity/connector adaptation diff in the assembly
  report.
