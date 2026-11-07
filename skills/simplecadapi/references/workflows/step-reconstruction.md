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

### 2. Plan the feature list (no tool calls)

From the IR, write the ordered list of features you will build, one line each:
slug, role, operation, the IR ids it explains. Map regions to operations:

| IR evidence | Feature |
|---|---|
| plane with `ext` (no `cut`) | sketch the cap's loops on its frame, extrude along `-n` by `h` |
| plane with `ext` and `cut:1` | sketch the loops, cut the prism extruded along `+n` by `h` |
| `axis` line, coaxial `CYL`/`CONE`/`TORUS`/`SPHERE`, `op revolve`, `REV` | one revolve: sketch the meridian (`query axis` gives it exactly) in a plane containing the axis |
| full `CYL` with `cc:0` not covered by a prism | a bore: cylinder tool, cut (overshoot both ends) |
| `op sweep` / `op loft` / `helix` | sweep or loft from the given rail/profile/sections |
| `fillet` / `chamfer` lines | one modify feature per line, after all solids and cuts; `on_blend` ones after the blend they sit on |
| `sharp` line | sketch that outline (not the rounded one); the fillet line rounds it later |

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
| `faces`, `complete` | face counts and surface types of target and candidate; `complete` = they agree |
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
| `complete` false, `riou` high | a blend group or small detail is missing: compare `faces.types_*` with the IR (`TORUS`/`SPHERE` = fillet corners, `CYLINDER` = fillets and bores) and add the missing operation. Every `fillet`/`chamfer` line must be applied, however small |
| `missing` / `extra` regions | find the IR records whose coordinates fall in the region's `bbox`, fix that feature (`query face <id>` only for those ids) |
| `QL selector expected exactly k ..., got m` | the selector's windows are wrong, or the body before the blend is not yet right (evaluate it without the blend cell). Recompute the windows from the IR records of the `between` faces; never lower `k` to what matched |
| any error | read only the JSON line. Ignore `.simplecad/diagnostics/*.png` (renders the SDK writes on a failed selection); do not open them |

Run step 4 again after each repair. Do not add `print`, probes or copies of the
notebook to debug: the evaluator's error names the cell and the source line, and
QL errors state the matched count. Two attempts with the same error mean the
approach is wrong: change the construction of that feature, not its numbers.
Budget: 8 evaluations. Keep the best notebook; if the budget runs out, stop with
the best `riou` and say which regions are still off.

### 6. Finish

Write `report.json`:
`{"part_id": ..., "riou": ..., "evaluations": n, "features": [...], "assumptions": [...]}`.
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
    PLATE_T = scad.var("plate_t", 6.0, unit="mm")
    EDGE_R = scad.var("edge_r", 1.0, unit="mm")
    return EDGE_R, PLATE_T


@app.cell
def _(PLATE_T):
    # ---- feature: base-plate (build, profile=sketch) ----
    _s = scad.make_sketch_rsketch(name="base_plate", plane={"origin": (0.0, 0.0, 0.0), "x_axis": (1.0, 0.0, 0.0), "y_axis": (0.0, 1.0, 0.0)})
    for _pid, _u, _v in (("p0", 0.0, 0.0), ("p1", 40.0, 0.0), ("p2", 40.0, 20.0), ("p3", 10.0, 20.0), ("p4", 0.0, 10.0), ("c0", 10.0, 10.0)):
        _s = scad.add_point_rsketch(sketch=_s, point_id=_pid, x=_u, y=_v)
    _s = scad.add_line_rsketch(sketch=_s, entity_id="e0", start="p0", end="p1")
    _s = scad.add_line_rsketch(sketch=_s, entity_id="e1", start="p1", end="p2")
    _s = scad.add_line_rsketch(sketch=_s, entity_id="e2", start="p2", end="p3")
    _s = scad.add_arc_rsketch(sketch=_s, entity_id="e3", start="p3", end="p4", center="c0")
    _s = scad.add_line_rsketch(sketch=_s, entity_id="e4", start="p4", end="p0")
    _face = scad.make_face_from_sketch_rface(sketch=_s, profile="e0")
    base_plate = scad.extrude_rsolid(profile=_face, direction=(0.0, 0.0, 1.0), distance=PLATE_T)
    return (base_plate,)


@app.cell
def _(base_plate):
    # ---- feature: bore (subtract) ----
    _tool = scad.make_cylinder_rsolid(radius=3.0, height=20.0, bottom_face_center=(30.0, 10.0, -5.0), axis=(0.0, 0.0, 1.0))
    bore = scad.cut_rsolid(base_plate, _tool)
    return (bore,)


@app.cell
def _(EDGE_R, bore):
    # ---- feature: corner-round (modify) ----
    _end = ql.faces().where(ql.and_(ql.prop("geom.type", "==", "PLANE"), ql.prop("geom.normal.x", ">", 0.999)))
    _front = ql.faces().where(ql.and_(ql.prop("geom.type", "==", "PLANE"), ql.prop("geom.normal.y", "<", -0.999)))
    corner_round = scad.fillet_rsolid(solid=bore, edges=_end.shared_boundary(_front, to_kind="edge").exactly(1), radius=EDGE_R)
    return (corner_round,)


@app.cell
def _(corner_round):
    bracket = scad.Part(part_id="bracket", body=corner_round)
    return (bracket,)


if __name__ == "__main__":
    app.run()
```

Rules (`stepeval.py` checks the ones marked ✓):

1. ✓ Header: the PEP 723 block with `[tool.simplecadapi]`, `id` = the file name
   without `.py` (snake_case), `revision = "1.0.0"`.
2. ✓ Imports only in `with app.setup:` (`simplecadapi as scad`, `ql`, and `math`
   if needed).
3. Params cell first, `# ---- params ----`: the part's main dimensions (overall
   thickness, main radii, blend sizes) as `scad.var(name, value, unit="mm")`
   (angles `unit="deg"`); a dimension used by one feature only stays a literal in
   that feature. ✓ No geometry in the params cell.
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
7. Planar profiles go through the sketch API (`profile=sketch`); a cutter that
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
scad.make_face_from_sketch_rface(sketch, profile=<first entity id of the outer loop>, *, inner_profiles=[<first entity id of each hole loop>])
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
scad.union_rsolid(a, b), scad.cut_rsolid(a, b), scad.intersect_rsolid(a, b)
scad.fillet_rsolid(solid, edges, radius)
scad.chamfer_rsolid(solid, edges, distance)
scad.Part(part_id, body)
```

A sketch is immutable: every `add_*` returns the new sketch, reassign it. Point
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
