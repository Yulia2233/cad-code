# Workflow: STEP Reconstruction

Rebuild a target STEP part as an editable SimpleCAD notebook, working from its
STEPIR description, and prove the result with one evaluation command. The
procedure is fixed and short; follow it in order and do nothing it does not ask
for.

## Goal and scope

- Input: `target.step` (one solid), and `target.ir.jsonl` when supplied.
- Output: one notebook `<part_id>.py` next to the target, which rebuilds the
  part without reading the target, plus `report.json`.
- Done when `scripts/stepeval.py` prints `"ok":true`: clean format, fresh run
  succeeds, one solid, volumetric IoU ≥ 0.99, and `complete` (face count and
  surface types match the target, so no fillet/chamfer group or detail was
  left out — small blends barely move the IoU, so the IoU alone cannot show it).
- Out of scope: multi-solid targets (`"solids"` > 1 in the IR header: report and
  stop), assemblies, drawings.

Paths below are relative to this skill's directory (`scripts/...`,
`references/...`). Run the scripts with the Python that has SimpleCADAPI 2.2.7
installed (with the `verify` extra; the evaluator also needs `manifold3d`).

## What to read

1. This file.
2. `references/inspect/stepir.md`, completely: the IR format and how each
   record maps to SimpleCAD calls.
3. `references/ql-playbook.md` only if the Blends recipe at the end of this
   file does not cover a selection you need (it usually does).
4. Only for an API not in the card below: its page
   `references/docs/api/<name>.md`.

Nothing else. Do NOT open `docs/guides/notebook-runtime.md`,
`discipline/feature-tree-convention.md`, `discipline/notebook-cell-design.md`,
the inspection domain, the strategy or test-contract guides, or the
requirement-refinement domain: the "Notebook format" section below already
holds every rule of theirs that this task needs, and it satisfies SKILL.md
global rules 1, 3 and 11 here. The target STEP is the requirement.

## Procedure

### 1. Read the IR (one command)

If `target.ir.jsonl` is missing, create it:
`python scripts/stepir.py target.step --out target.ir.jsonl`. Then read the
whole file once with one `cat` (no `head` first, no re-reading later). The
workspace holds only the target files; do not search it. Check the header: `solids` must be 1.

### 2. Infer the design intent, then plan the feature list (no tool calls)

First read the IR as a designer would have drawn the part, and decide:

- **What the part is and how it was built**: the base solid, what was added,
  what was cut, which edges were rounded last.
- **The design dimensions**: values that are round or repeat (a thickness used
  by several faces, one hole radius used four times, a fillet radius) are one
  design value each; values that follow from others (an offset that is half a
  width, a boss height that is plate thickness plus 2) are relations, not new
  numbers.
- **The geometric relations**: lines that are horizontal/vertical in their
  sketch, arcs tangent to their neighbours, profiles symmetric about a midplane,
  holes concentric with bosses, features centred or offset from an edge,
  repeated features (a linear or radial pattern, a mirror).
- **The dependencies between features**: which feature is placed relative to
  which (a bore on the boss axis, a slot at the middle of the plate), so that
  changing a parameter moves everything that depends on it.

Then write the ordered list of features you will build, one line each: slug,
role, operation, the IR ids it explains, its driving dimensions and the
references it depends on. Map regions to operations:

| IR evidence | Feature |
|---|---|
| plane with `ext` (no `cut`) | sketch the cap's loops on its frame, extrude along `-n` by `h` |
| plane with `ext` and `cut:1` | sketch the loops, cut the prism extruded along `+n` by `h` |
| `axis` line, coaxial `CYL`/`CONE`/`TORUS`/`SPHERE`, `op revolve`, `REV` | one revolve: sketch the meridian (`query axis` gives it exactly) in a plane containing the axis |
| full `CYL` with `cc:0` not covered by a prism | a bore: cylinder tool, cut (overshoot both ends) |
| `op sweep` / `op loft` / `helix` | sweep or loft from the given rail/profile/sections |
| `fillet` / `chamfer` lines | one modify feature per line, after all solids and cuts; `on_blend` ones after the blend they sit on |
| `sharp` line | sketch that outline (not the rounded one); the fillet line rounds it later |
| the same feature repeated at equal steps or angles | one instance + `linear_pattern_rsolidlist` / `radial_pattern_rsolidlist` (or a loop over a literal list of positions), not copies |
| features mirrored across a plane | one side + `mirror_shape`, or a symmetric sketch |

Order: base solid → additive features → cuts → shells → fillets/chamfers.
Every face record must be explained by some feature (implied faces come with
their prism). Write the list into `report.json` under `"features"` at the end;
do not create other planning files.

### 3. Write the notebook body (one file write)

`<part_id>` is a short snake_case name of what the part is (`valve_holder`,
`motor_flange`), never `target`. When the task names the notebook path, use that
path and its file name as the id. Write `<part_id>.py` directly in the notebook
format below with every feature EXCEPT the fillet/chamfer cells, every number
taken from the IR (4 decimals). Model the sharp body (use the `sharp` outlines).
Write the file yourself with your file-editing tool: no program that generates
the notebook, no copies of it (`debug.py`), no string-replacement scripts.

Modelling requirements (they carry the design intent into the code):

1. **Parameters**: every design dimension from step 2 is one `scad.var` in the
   params cell; a derived value is an expression of the parameters
   (`PLATE_W - 10.0`, `BORE_D / 2`), never a second literal of the same number.
2. **Constrained sketches**: a planar profile is a sketch whose constraints
   state the intent: one anchor point fixed (`constrain_fix_rsketch`) on a datum
   of the frame, `constrain_horizontal_rsketch` / `constrain_vertical_rsketch` on
   axis-aligned lines, `constrain_tangent_rsketch` where an arc meets a line or
   arc smoothly, `constrain_equal_*` / `constrain_symmetric_rsketch` where the
   design is equal or symmetric, and driving dimensions
   (`constrain_length_rsketch`, `constrain_distance_x/_y_rsketch`,
   `constrain_radius_rsketch`) whose values are the parameters or their
   expressions. Seed the points with the IR coordinates (the solver starts from
   them) and promote with `require_fully_constrained=True`. If one profile's
   constraints will not close after two attempts, promote it without
   `require_fully_constrained`, keep the constraints that do hold, and record it
   under `assumptions`.
3. **Dependent placement**: a feature placed relative to another uses the same
   parameters and expressions (a bore at the boss centre reuses the boss
   position), repeated features use a pattern or a loop, mirrored features use a
   mirror. Moving a parameter must keep the part consistent.
4. `profile=geometry` / `path=geometry` only for 3D curves and transcribed
   splines (`REV`/`EXT` generators, `bspline` sections, sweep rails).

### 4. Evaluate (one command per attempt)

Evaluate the sharp body first. A correct sharp body differs from the target
only along the blended edges: its `missing` / `extra` regions are strips there
(the IoU is about 0.97–0.995 for small blends, lower for large ones). Fix the body until that
is so, then add the blend cells (one per `fillet`/`chamfer` line, in IR order,
`on_blend` ones later) and evaluate again.

```bash
python scripts/stepeval.py <part_id>.py target.step --out eval/<n>
```

It checks the format, runs the notebook in a fresh process, exports the
candidate and compares it with the target, and prints one JSON line:

| Field | Meaning |
|---|---|
| `ok` | true = done |
| `format` | format problems with line numbers; empty when clean |
| `run` | `"ok"`, or `{"stage","error","line","cell"}`: `cell` is the feature slug that raised |
| `solids` | solids in the product (must be 1) |
| `riou` | volumetric IoU with the target (1.0 = identical) |
| `faces`, `complete` | face counts and surface types of target and candidate, counted as in the IR header (pieces of one surface merged, so how the target's exporter split faces does not matter); `complete` = they agree. `faces_raw` = plain B-rep counts, for reference only |
| `vol_err`, `bbox_err` | relative volume error; largest bounding-box difference (mm) |
| `missing` | regions the target has and the candidate lacks: `vol`, `centroid`, `bbox` |
| `extra` | regions the candidate has and the target lacks |

### 5. Repair (edit only the owning cell)

| Result | Repair |
|---|---|
| `format` not empty | fix exactly the listed lines |
| `run.cell` = a feature | fix that cell; read the error text, and the API page if the error is about arguments |
| `stage` capture, `brep_invalid` | a profile crosses itself: check arc direction (`s=-1` swaps start/end), loop order, the plane's `y = n × x` |
| `solids` > 1 | a feature does not touch the body: check its plane origin and extrusion direction |
| `union_rsolid` "separated solids ... gap g", `closure_vector` v | the added solid is displaced by v from where it should touch: when g is large (more than a few % of the part) the feature is misplaced, so check the `ext` direction (material along `-n`, `cut:1` along `+n`), which cap is the `twin`, and the sketch plane origin; when g is tiny the feature only meets a face of the body, so extend it into the body by about 0.05 mm (the overlap inside material changes nothing) |
| `union_rsolid` "operands meet only along an edge, vertex, or tangent" | the two solids share only an edge or a tangent line: give them a real overlap (extend one into the other) or build them as one profile |
| `make_face_from_sketch_rface` "Failed to create a face" | a loop is not closed (an end point id that is not the next start), crosses itself (arc direction, `s=-1`), a hole id in `inner_profiles` is not the first entity of a closed hole loop, or the constraints conflict (remove the last added constraint first) |
| `complete` false, `riou` high | a blend group or small detail is missing: compare `faces.types_*` (IR type names, the same as the IR header) with the IR (`TORUS`/`SPHERE` = fillet corners, `CYL` = fillets and bores) and add the missing operation. Every `fillet`/`chamfer` line must be applied, however small |
| `missing` / `extra` regions | find the IR records whose coordinates fall in the region's `bbox`, fix that feature (`query face <id>` only for those ids) |
| `QL selector expected exactly k ..., got m` with m > k | several faces pass the windows (same normal elsewhere on the part): add a `geom.center` window on a second axis, from the IR record's loop/bbox |
| `TypeError: expected a edge or a QL selector` in a blend | `resolve()` returns a LIST of edges: collect them with `edges.extend(sel.resolve(body))`, not `append`, and pass the flat list |
| `QL selector expected exactly k ..., got m` | the selector's windows are wrong, or the body before the blend is not yet right (evaluate it without the blend cell). Recompute the windows from the IR records of the `between` faces; never lower `k` to what matched |
| any error | read only the JSON line. Ignore `.simplecad/diagnostics/*.png` (renders the SDK writes on a failed selection); do not open them |

Run step 4 again after each repair. Do not add `print`, probes or copies of the
notebook to debug: the evaluator's error names the cell and the source line, and
QL errors state the matched count. Two attempts with the same error mean the
approach is wrong: change the construction of that feature, not its numbers.

When to stop: at `"ok": true`; or when the feature tree is structurally sound
(every IR region is explained by a sensible feature, every `fillet`/`chamfer`
line is applied) and no further improvement is reachable through clean modelling
— the remaining difference would need patch solids, target-fitted surfaces,
hand-tuned offsets with no design meaning, or other workarounds. Do not stop
while a clean change is still raising the IoU. Keep the best notebook and say in
the report which regions are still off and why a clean model does not reach
them.

### 6. Finish

Write `report.json`:
`{"part_id": ..., "riou": ..., "evaluations": n, "design_intent": "...", "features": [...], "assumptions": [...]}`
(`design_intent`: two or three sentences: what the part is, its design
dimensions and relations; `features`: the step-2 list).
Then stop: no renders, no extra comparisons, no cleanup passes.

## Notebook format (the web editor format)

A model is a marimo notebook the SimpleCAD web editor (`sca edit`) opens as-is.

```python
# /// script
# requires-python = ">=3.10"
# dependencies = ["simplecadapi"]
#
# [tool.simplecadapi]
# id = "bracket"
# revision = "1.0.0"
# ///
import marimo

app = marimo.App()

with app.setup:
    import simplecadapi as scad
    from simplecadapi import ql


@app.cell
def _():
    # ---- params ----
    PLATE_W = scad.var("plate_w", 40.0, unit="mm", comment="overall length")
    PLATE_H = scad.var("plate_h", 20.0, unit="mm", comment="overall width")
    PLATE_T = scad.var("plate_t", 6.0, unit="mm", comment="thickness")
    CORNER_R = scad.var("corner_r", 5.0, unit="mm", comment="rounded corner of the outline")
    BORE_D = scad.var("bore_d", 6.0, unit="mm", comment="bore diameter")
    EDGE_R = scad.var("edge_r", 1.0, unit="mm", comment="edge fillet")
    return BORE_D, CORNER_R, EDGE_R, PLATE_H, PLATE_T, PLATE_W


@app.cell
def _(CORNER_R, PLATE_H, PLATE_T, PLATE_W):
    # ---- feature: base-plate (build, profile=sketch) ----
    _s = scad.make_sketch_rsketch(name="base_plate", plane={"origin": (0.0, 0.0, 0.0), "x_axis": (1.0, 0.0, 0.0), "y_axis": (0.0, 1.0, 0.0)})
    for _pid, _u, _v in (("p0", 0.0, 0.0), ("p1", 35.0, 0.0), ("p2", 40.0, 5.0), ("p3", 40.0, 20.0), ("p4", 0.0, 20.0), ("c0", 35.0, 5.0)):
        _s = scad.add_point_rsketch(sketch=_s, point_id=_pid, x=_u, y=_v)
    _s = scad.add_line_rsketch(sketch=_s, entity_id="e0", start="p0", end="p1")
    _s = scad.add_arc_rsketch(sketch=_s, entity_id="e1", start="p1", end="p2", center="c0")
    _s = scad.add_line_rsketch(sketch=_s, entity_id="e2", start="p2", end="p3")
    _s = scad.add_line_rsketch(sketch=_s, entity_id="e3", start="p3", end="p4")
    _s = scad.add_line_rsketch(sketch=_s, entity_id="e4", start="p4", end="p0")
    _s = scad.constrain_fix_rsketch(sketch=_s, target="p0")
    _s = scad.constrain_horizontal_rsketch(sketch=_s, line="e0")
    _s = scad.constrain_horizontal_rsketch(sketch=_s, line="e3")
    _s = scad.constrain_vertical_rsketch(sketch=_s, line="e2")
    _s = scad.constrain_vertical_rsketch(sketch=_s, line="e4")
    _s = scad.constrain_tangent_rsketch(sketch=_s, a="e1", b="e0", at_a="start")
    _s = scad.constrain_tangent_rsketch(sketch=_s, a="e1", b="e2", at_a="end")
    _s = scad.constrain_radius_rsketch(sketch=_s, circle="e1", value=CORNER_R)
    _s = scad.constrain_distance_x_rsketch(sketch=_s, a="p0", b="p3", value=PLATE_W)
    _s = scad.constrain_length_rsketch(sketch=_s, line="e4", value=PLATE_H)
    _face = scad.make_face_from_sketch_rface(sketch=_s, profile="e0", require_fully_constrained=True)
    base_plate = scad.extrude_rsolid(profile=_face, direction=(0.0, 0.0, 1.0), distance=PLATE_T)
    return (base_plate,)


@app.cell
def _(BORE_D, PLATE_H, PLATE_T, PLATE_W, base_plate):
    # ---- feature: bore (subtract) ----
    _tool = scad.make_cylinder_rsolid(radius=BORE_D / 2, height=PLATE_T + 10.0, bottom_face_center=(PLATE_W - 10.0, PLATE_H / 2, -5.0), axis=(0.0, 0.0, 1.0))
    bore = scad.cut_rsolid(base_plate, _tool)
    return (bore,)


@app.cell
def _(EDGE_R, PLATE_H, bore):
    # ---- feature: back-edge-round (modify) ----
    _top = ql.faces().where(ql.and_(ql.prop("geom.type", "==", "PLANE"), ql.prop("geom.normal.z", ">", 0.999)))
    _back = ql.faces().where(ql.and_(ql.prop("geom.type", "==", "PLANE"), ql.prop("geom.normal.y", ">", 0.999), ql.prop("geom.center.y", ">", PLATE_H - 0.01)))
    _edges = []
    _edges.extend(_top.shared_boundary(_back, to_kind="edge").exactly(1).resolve(bore))
    back_edge_round = scad.fillet_rsolid(solid=bore, edges=_edges, radius=EDGE_R)
    return (back_edge_round,)


@app.cell
def _(back_edge_round):
    bracket = scad.Part(part_id="bracket", body=back_edge_round)
    return (bracket,)


if __name__ == "__main__":
    app.run()
```

Rules (`stepeval.py` checks the ones marked ✓):

1. ✓ Header: the PEP 723 block with `[tool.simplecadapi]`, `id` = the file name
   without `.py` (snake_case), `revision = "1.0.0"`.
2. ✓ Imports only in `with app.setup:` (`simplecadapi as scad`, `ql`, and `math`
   if needed).
3. Params cell first, `# ---- params ----`: every design dimension as
   `scad.var(name, value, unit="mm", comment=...)` (angles `unit="deg"`); derived
   values are expressions of these (modelling requirement 1). ✓ No geometry in
   the params cell.
4. ✓ One feature per cell. The first line of the cell is
   `# ---- feature: <slug> (<role>[, profile=sketch|geometry][, path=sketch|geometry]) ----`,
   role ∈ build, add, subtract, intersect, modify, pattern, annotate; slug in
   kebab-case, no numbers for ordering.
5. ✓ The cell returns exactly one name, the slug in snake_case
   (`base-plate` → `base_plate`), and the next feature reads it. Temporaries start
   with `_` (`_s`, `_face`, `_tool`) so they stay inside the cell.
6. ✓ The last cell makes the product: `<id> = scad.Part(part_id="<id>", body=<last feature>)`.
   A helper used by several cells is an `@app.function` (a plain top-level
   function under that decorator, reading only setup names); a `_name` defined
   in one cell is invisible to the others.
7. Planar profiles go through the sketch API with constraints (`profile=sketch`,
   modelling requirement 2); a cutter that
   is exactly a primitive (a bore, a box slot) may be `make_cylinder_rsolid` /
   `make_box_rsolid`; non-planar paths and transcribed splines are
   `profile=geometry` / `path=geometry`.
8. ✓ Never read files: no paths, no `open`, no `simplecadapi.inspect`, no
   `load_step*`/`load_brep*`/`copy_step_region*`, no `GraphSession`, no
   `@scad.part`, no `print`. The runtime records each cell itself.
9. Keyword arguments for every SDK call except the two solids of a boolean.
   Through-cutters overshoot the material by a few mm on both sides.

## API card (2.2.7, verified)

```python
scad.var(name, default, comment=None, *, unit="mm" | "deg")           # a named parameter; use it like a number
scad.make_sketch_rsketch(name=None, *, plane="XY" | {"origin": o, "x_axis": x, "y_axis": y})
scad.add_point_rsketch(sketch, point_id, x, y)
scad.add_line_rsketch(sketch, entity_id, start, end)                 # point ids
scad.add_arc_rsketch(sketch, entity_id, start, end, center)          # counter-clockwise start -> end
scad.add_circle_rsketch(sketch, entity_id, center, radius)           # center = point id
scad.constrain_fix_rsketch(sketch, target)                           # target: a point id
scad.constrain_horizontal_rsketch(sketch, line), scad.constrain_vertical_rsketch(sketch, line)
scad.constrain_tangent_rsketch(sketch, a, b, *, at_a=None, at_b=None)  # at_a/at_b: "start" | "end" of an arc
scad.constrain_coincident_rsketch(sketch, a, b), scad.constrain_concentric_rsketch(sketch, a, b)
scad.constrain_parallel_rsketch(sketch, a, b), scad.constrain_perpendicular_rsketch(sketch, a, b)
scad.constrain_equal_length_rsketch(sketch, a, b), scad.constrain_equal_radius_rsketch(sketch, a, b)
scad.constrain_symmetric_rsketch(sketch, a, b, axis), scad.constrain_midpoint_rsketch(sketch, point, line)
scad.constrain_length_rsketch(sketch, line, value), scad.constrain_radius_rsketch(sketch, circle, value)
scad.constrain_distance_rsketch(sketch, a, b, value)
scad.constrain_distance_x_rsketch(sketch, a, b, value), scad.constrain_distance_y_rsketch(sketch, a, b, value)
scad.make_face_from_sketch_rface(sketch, profile=<first entity id of the outer loop>, *, inner_profiles=[<first entity id of each hole loop>], require_fully_constrained=False)
scad.extrude_rsolid(profile, direction, distance)                    # profile: a face
scad.revolve_rsolid(profile, axis=(0, 0, 1), angle=360, origin=(0, 0, 0))
scad.sweep_rsolid(profile, path, is_frenet=False)
scad.loft_rsolid(profiles, ruled=False)
scad.make_helix_rwire(pitch, height, radius, center=(0, 0, 0), dir=(0, 0, 1), *, handedness="Right")
scad.make_spline_redge(*, control_points, degree=3, knots=None, multiplicities=None, weights=None, periodic=False)
scad.make_interpolated_spline_redge(*, points, periodic=False)
scad.make_wire_from_edges_rwire(edges)
scad.make_face_from_wire_rface(wire)
scad.make_cylinder_rsolid(radius, height, bottom_face_center=(0, 0, 0), axis=(0, 0, 1))
scad.make_box_rsolid(width, height, depth, ...)                      # read its page for placement
scad.make_sphere_rsolid(...), scad.make_cone_rsolid(...)             # read their pages
scad.union_rsolid(a, b), scad.cut_rsolid(a, b), scad.intersect_rsolid(a, b)   # b may be a list of solids
scad.linear_pattern_rsolidlist(shape, direction, count, spacing)      # -> list of solids (instance included)
scad.radial_pattern_rsolidlist(shape, center, axis, count, total_rotation_angle)
scad.mirror_shape(shape, plane_origin, plane_normal)
scad.fillet_rsolid(solid, edges, radius)
scad.chamfer_rsolid(solid, edges, distance)
scad.Part(part_id, body)
```

A sketch is immutable: every `add_*` and `constrain_*` returns the new sketch, reassign it. Constraint values
may be parameters or expressions of them. Point
ids and entity ids are plain strings that are unique within the sketch.

## Recipes

**A planar IR loop as a sketch.** Plane = the record's frame with
`y_axis = n × x`. Points: the loop start, then each segment end; for an `A`
segment also its centre. Entities in loop order; outer loop first, then each
hole loop; `profile` = the outer loop's first entity id, `inner_profiles` = the
first entity id of each hole loop. A `{"c":[cu,cv,r]}` loop is one centre point
plus `add_circle_rsketch`. A `rect` is four points and four lines.

**Prism from `ext`.** Sketch on the cap's frame, `extrude_rsolid(direction=-n,
distance=h)`; with `cut:1`, `direction=+n` and cut the result from the body.
A sketch plane may be the cap itself even when the prism grows from it.

**Revolve.** Choose a plane that contains the axis: origin = axis point, `x_axis`
⟂ axis, `y_axis` = axis direction; the meridian `(r, z)` points become `(u, v)`
= `(r, z)`. `revolve_rsolid(profile=face, axis=d, origin=p)`.

**Blends.** One `fillet`/`chamfer` line is ONE `fillet_rsolid`/`chamfer_rsolid`
call (its corner patches need it). Select its edges pair by pair from the
`between` list: for each pair, one face selector per member built from its IR
record, `a.shared_boundary(b, to_kind="edge").exactly(1).resolve(body)`, and
collect the resolved edges into one list; `fillet_rsolid(solid=body,
edges=edge_list, radius=r)` takes that list (a list of unresolved selectors, or
`sel_a | sel_b`, is rejected). Put the face-selector helper in an
`@app.function`, once:

```python
@app.function
def face_sel(kind, normal=None, center=None, area=None):
    """kind: PLANE | CYLINDER | CONE | SPHERE | TORUS; normal (planes): the IR n;
    center: {"x": (lo, hi), ...} windows; area: (lo, hi)."""
    _p = [ql.prop("geom.type", "==", kind)]
    for _c, _v in zip("xyz", normal or ()):
        _p += [ql.prop(f"geom.normal.{_c}", ">", _v - 0.001), ql.prop(f"geom.normal.{_c}", "<", _v + 0.001)]
    for _c, (_lo, _hi) in (center or {}).items():
        _p += [ql.prop(f"geom.center.{_c}", ">", _lo), ql.prop(f"geom.center.{_c}", "<", _hi)]
    if area:
        _p += [ql.prop("geom.area", ">", area[0]), ql.prop("geom.area", "<", area[1])]
    return ql.faces().where(ql.and_(*_p))
```

Window rules: a plane by its normal, plus a ±0.01 `center` window on the
coordinate along its dominant normal axis (= that coordinate of `o`) when other
planes share the normal; a plane with the same normal and offset elsewhere on
the part gets a second window on a side coordinate. A cylinder's `geom.center`
is the middle of its axis segment; separate cylinders by that and by area (the
area of a fillet cylinder before rounding other edges is its arc length × length).
Available properties: `geom.type`, `geom.center.x/y/z`, `geom.normal.x/y/z`
(planes), `geom.area`, `geom.length` (edges); there is no radius, axis, convexity
or dihedral predicate. Coordinates take ranges, never `==`.
