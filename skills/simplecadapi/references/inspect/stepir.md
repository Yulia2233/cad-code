# STEPIR v6.2: reading the IR of a target STEP

`scripts/stepir.py` turns a STEP part into a compact description, one JSON
object per line: a header, one record per face, then derived lines computed from
the geometry. It is the evidence a STEP reconstruction works from
(`workflows/step-reconstruction.md`). This page is the complete format and the
rules for turning it into SimpleCAD code.

```bash
python scripts/stepir.py target.step --out target.ir.jsonl   # full IR (skip when target.ir.jsonl is supplied)
python scripts/stepir.py query target.step face 12           # on demand, one face (spline control net included)
python scripts/stepir.py query target.step axis              # coaxial faces with their exact (z, r) meridian
python scripts/stepir.py query target.step neighbours 12     # adjacent faces and the shared tangent length
python scripts/stepir.py query target.step evidence 12       # which rigid motions sweep the face
```

Paths in this page are relative to the skill directory. The IR is read outside
the notebook; the notebook never reads the target (it holds the numbers as
literals).

## Header (line 1)

```json
{"unit":"mm","bbox":[[x0,y0,z0],[x1,y1,z1]],"vol":996.78,"area":1685.78,"solids":1,
 "counts":{"face":139,"edge":411},"types":{"PLANE":95,"CYL":37,"SPHERE":5,"BSPL":2},"implied":17}
```

- `solids` must be 1. More than one solid is out of scope: report it and stop.
- `types` counts faces after recognition: a B-spline face that is really a
  plane, cylinder, cone, sphere or torus is counted (and written) as that.
- `implied` = prism side faces that have no record (see `ext`).
- `vol`, `area`, `bbox` are what the finished candidate must reproduce.

## Face records

Every record has `id` (stable within this IR; gaps are implied faces), `t`
(type) and `A` (area). Pieces of one surface are already merged into one record.
Numbers carry 4 decimals; treat them as exact design values.

### PLANE: a local frame and chain-encoded loops

`o` origin, `n` outward normal, `x` local x axis; the local y axis is
**`y = n × x`**. A local point `(u, v)` is the world point `o + u·x + v·y`.

This frame IS a sketch plane. Pass it unchanged and use the loop coordinates as
they are:

```python
_s = scad.make_sketch_rsketch(name="slot", plane={"origin": o, "x_axis": x, "y_axis": y})   # y = n × x
```

(verified on 2.2.7: with that plane, local `(u, v)` lands on `o + u·x + v·y`).

Loops are in the local frame, outer boundary first:

| Encoding | Meaning |
|---|---|
| `{"s":[u,v],"e":[seg,...]}` | chain starting at `s`; each segment ends where the next starts; the last ends at `s` |
| `["L",u,v]` | line to `(u,v)` |
| `["A",cu,cv,u,v,s]` | arc to `(u,v)` about centre `(cu,cv)`; `s=+1` counter-clockwise, `s=-1` clockwise |
| `["E",cu,cv,a,b,ux,uy,u,v,s]` | elliptical arc (semi-axes `a`,`b`, major axis direction `(ux,uy)`) |
| `["S",deg,u,v,[mu,mv]]` | spline to `(u,v)`; `[mu,mv]` is its centroid. Exact poles: `query face <id>` |
| `{"c":[cu,cv,r]}` | a full circle |
| `"rect":[u0,v0,u1,v1]` | the face is one axis-aligned rectangle (replaces `loops`) |

**Arc direction.** `add_arc_rsketch(start, end, center)` always runs
counter-clockwise from `start` to `end`. For `s=+1` pass the previous point as
`start` and the segment end as `end`; for **`s=-1` swap them**. Getting this wrong
draws the long way round, and the profile self-intersects (`capture` then fails
with `brep_invalid`).

### Prisms: `ext`, `twin`, `cut`

`"ext":{"to":k,"h":h}` on a plane: this face and face `k` are the two caps of a
prism of height `h`. Face `k` carries only `"twin":<id>` (same loops). The side
faces between them are not written (they are the `implied` faces): planes and
cylinders swept from the loop segments.

- No `cut`: material. The cap's loops extruded along **`-n`** by `h` give the
  prism: `extrude_rsolid(profile=face, direction=-n, distance=h)`.
- `"cut":1`: the two caps face each other across EMPTY space (a slot, pocket,
  window). The loops extruded along **`+n`** by `h` give the removed prism: cut it.

Holes in a cap (inner loops) belong to the same prism when the hole walls are
implied too; a hole whose wall has its own record (a `CYL` with `cc:0`) is a
separate feature (a bore), usually cut later.

### Curved faces

| `t` | Fields |
|---|---|
| `CYL` | `p` start of the axis segment, `d` axis, `r`, `v=[0,L]` length along `d`, `span` degrees around the axis (360 = full), `ref` direction of the middle of the span, `cc` 1 convex (boss) / 0 concave (hole) |
| `CONE` | `p` axis point level with the narrow end, `d` direction in which the radius grows, `r` radius there, `ang` half-angle (deg), `v=[0,L]` slant length; far radius `r + L·sin(ang)`, axial length `L·cos(ang)` |
| `SPHERE` | `p` centre, `r`, `v` latitude range (deg) |
| `TORUS` | `p` centre of the tube circle, `d` axis, `r` major radius, `r2` tube radius, `v` tube-section angle range |
| `REV` | surface of revolution: `p`, `d`, and `gen` = exact generator in the meridian plane (`zr` poles: z along `d` from `p`, r away from the axis; `deg`, `knots`, `mult`, optional `w`, `periodic`). Build it with `make_spline_redge` and revolve |
| `EXT` | linear extrusion of `gen` (3D poles) along `d` over `v` |
| `BSPL` | a genuine free-form face: `bb`, `deg`, `poles` (counts), 3D loops. The full net: `query face <id>`; how it was made: the `op` lines |

`span > 360` cannot happen: a face winding round more than once has `span:360`
and `wraps` = number of turns (a thread or helical strip). `adj` lists neighbour
ids when there are at most six.

## Derived lines (after the faces)

Computed from the geometry, not guessed. Ids are IR ids.

```text
{"derived":"fillet","r":R,"faces":[...],"between":[[a,b],...],"corners":[...],"on_blend":[...]}
{"derived":"chamfer","d":D,"faces":[...],"between":[[a,b],...],"uncertain":[...]}
{"derived":"sharp","face":id,"loops":[...]}
{"derived":"op","op":"extrude|revolve|helical","faces":[...],"dir"|"axis","point",["pitch"],"residual"}
{"derived":"op","op":"sweep","faces":[...],"rail":[...],"profile":{...},"frame":"frenet|fixed"}   (or "helix":{...})
{"derived":"op","op":"loft","faces":[...],"sections":[...]}
{"derived":"freeform","faces":[...]}
{"derived":"axis","dir":[...],"point":[...],"faces":[...]}
```

- **fillet / chamfer**: one line = one operation. Face `faces[i]` rounds the
  edge shared by the pair `between[i]`. A pair member may be an inline plane
  `{"t":"PLANE","o":..,"n":..}` when that face has no record. `corners` are the
  sphere/torus patches where fillets meet (made by the same operation, never
  modelled separately). `on_blend` faces round an edge of another blend: do that
  operation first. `uncertain` faces may be design bevels rather than chamfers.
  Model the body sharp, then apply the operation with QL (see the workflow).
- **sharp**: the outline of a plane before its vertical edges were rounded
  (corners instead of fillet arcs). Sketch this outline, extrude, then fillet.
- **op extrude / revolve / helical**: these faces are swept by that rigid motion
  (exactly). Only faces that carry evidence are listed (cones, tori, spheres,
  splines); plain cylinders and planes are never listed.
- **op sweep**: a profile carried along a rail: `rail` = points the profile
  centroid passes through (`make_interpolated_spline_redge(points=rail)`),
  `profile` = the start section (`o`,`n`,`x` frame plus `circle`, `loop` in the
  plane-loop encoding, `bspline` exact curve, `poly` or `through` points), `frame`
  `frenet` (`is_frenet=True`) or `fixed`; a trailing `?` means not certain. A
  `helix` (`axis`, `centre`, `radius`, `pitch`, `height`, `hand`) replaces the rail
  for threads: `make_helix_rwire`. No `rail` means the section does not move: not
  a sweep along a path.
- **op loft**: `sections` the surface passes through in order, same encoding as
  `profile`: `loft_rsolid(profiles=[...])`.
- **freeform**: no rigid motion makes these faces; they come from a loft, a
  sweep along a curve, or a spline surface. Do not try to extrude them.
- **axis**: faces sharing one axis (revolve candidates).

## Caveats

- The IR is the final shape, not the history. It gives one valid explanation of
  each region; choose the feature order yourself: base solid, additive features,
  cuts, then fillets/chamfers last.
- Some operations look alike: a countersink vs a conical chamfer, a sketch arc
  vs a fillet operation, a lofted pair of equal sections vs an extrusion. Pick
  the simpler one; the comparison decides.
- `n` is the outward normal of the FINAL solid. On a pocket floor it points into
  the pocket.
- Concave cylinders (`cc:0`) with `span:360` are holes; with a span below 180
  next to two planes they are usually fillets (check the `fillet` lines first).
- The IR rounds to 4 decimals; small mismatches against the target of about
  1e-4 are expected and are not errors.
- Do not query faces you already understand. `query face` is for splines and for
  the faces a comparison points at.
