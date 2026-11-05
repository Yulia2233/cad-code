#!/usr/bin/env python3
"""STEP -> compact inspector IR (JSONL, one face per line), version 3 (SimpleCADAPI inspector only).

Built exclusively on simplecadapi.inspect.brep (load_step_rbrepmodel, describe_entity,
inspect_face_boundaries_rdescriptor, inspect_step_rsummary); numpy is used for frame arithmetic only.

Input representation for the STEP->SimpleCADAPI model. Raw STEP text of real parts is 60K-230K Qwen tokens;
this IR keeps what is needed to write a feature-tree program: faces, analytic carriers, ordered boundary
loops in a face-local 2D frame (chain-encoded), extrusion (prism) structure, rounded numbers.

Line 1  : global header (unit, bbox, volume, area, counts, surface type histogram, #implied faces).
Lines 2+: one face each, ids stable within the file (sorted canonically), gaps = implied faces.

Planar face loops (local frame: origin o, x axis x, y = n x x, n outward):
  loop = {"s":[x,y], "e":[seg,...]}  chain from start point;  or {"c":[cx,cy,r]} for a full circle
  seg  = ["L",x,y] line to (x,y) | ["A",cx,cy,x,y,s] arc to (x,y) about centre (cx,cy), s=+1 ccw/-1 cw
         ["E",cx,cy,a,b,ux,uy,x,y,s] ellipse arc | ["S",deg,x,y,[mx,my]] spline to (x,y) via its centroid
  "rect":[u0,v0,u1,v1] replaces loops when the face is a single axis-aligned rectangle.
Prism structure: a cap face carries "ext":{"to":id_of_opposite_cap,"h":height}; the opposite cap is emitted
  with "twin":id (no loops: identical loops, translated by -h*n), and all lateral faces (planes parallel to n,
  cylinders with axis parallel to n) between the pair are omitted (implied by the loops).
  "cut":1 in ext: the caps face each other, i.e. they bound REMOVED material (slot/pocket); the twin then lies at
  +h*n and the loops swept along +n by h are the removed prism.
Non-planar faces: carrier parameters (p point, d axis, r radius, r2, ang, u/v ranges in degrees or length,
  cc=1 convex / 0 concave) and "adj" neighbour ids when few.
"""
import argparse
import json
import math
import os
import sys
from collections import Counter

import numpy as np
from simplecadapi.inspect import brep

NDIG = int(os.environ.get("STEPIR_NDIG", "4"))
ENDCAPS = os.environ.get("STEPIR_ENDCAPS", "0") == "1"   # cylinders/cones: explicit end-circle centres instead of p + v*d
TOL = 2e-3


def r(x, n=None):
    n = NDIG if n is None else n
    v = round(float(x), n)
    if v == 0:
        return 0
    return int(v) if v == int(v) and abs(v) < 1e9 else v


def canon_frame(n):
    nx, ny, nz = n
    up = (0.0, 0.0, 1.0) if abs(nz) < 0.9 else (0.0, 1.0, 0.0)
    x = np.array([up[1] * nz - up[2] * ny, up[2] * nx - up[0] * nz, up[0] * ny - up[1] * nx])
    x = x / (np.linalg.norm(x) or 1.0)
    y = np.cross(np.asarray(n), x)
    return x, y



def reversed_face(model, index):
    """True when the face is stored reversed (its outward normal opposes the carrier normal => concave carrier)."""
    return model.faces[index].Orientation().name.endswith("REVERSED")


SURF = {"PLANE": "PLANE", "CYLINDER": "CYL", "CONE": "CONE", "SPHERE": "SPHERE", "TORUS": "TORUS",
        "BSPLINE": "BSPL", "BEZIER": "BEZ"}
RANK = {"PLANE": 0, "CYL": 1, "CONE": 2, "SPHERE": 3, "TORUS": 4}


class Frame:
    def __init__(self, origin, n):
        self.o = np.asarray(origin, float)
        self.n = np.asarray(n, float)
        self.x, self.y = canon_frame(self.n)

    def to2d(self, p):
        d = np.asarray(p, float) - self.o
        return [float(d @ self.x), float(d @ self.y)]


def edge_seg(model, rec, frame):
    """Edge occurrence record -> (start_list, segment_or_None, circle_or_None)."""
    gt = rec["geometry_type"]
    start, end = np.asarray(rec["start"], float), np.asarray(rec["end"], float)
    P = (lambda p: [r(c) for c in frame.to2d(p)]) if frame else (lambda p: [r(c) for c in p])
    if gt == "LINE":
        return P(start), ["L"] + P(end), None
    ed = model.describe_entity(rec["entity_id"])["geometry"]
    par = ed["parameters"]
    closed = bool(ed.get("closed")) or float(np.linalg.norm(start - end)) < 1e-7
    fwd = rec["orientation"] == "FORWARD"
    if gt == "CIRCLE":
        cen = np.asarray(par["center"], float)
        rad = float(par["radius"])
        if closed:
            return None, None, ["C"] + P(cen) + [r(rad)]
        axis = np.asarray(par["axis_direction"], float)
        sense_axis = 1 if fwd else -1  # +1: traversal runs ccw about the circle axis
        if frame:
            s = sense_axis * (1 if float(axis @ frame.n) > 0 else -1)
            return P(start), ["A"] + P(cen) + P(end) + [s], None
        return P(start), ["A"] + P(cen) + P(end) + [sense_axis] + [r(c, 4) for c in axis], None
    if gt == "ELLIPSE":
        cen = np.asarray(par["center"], float)
        axis = np.asarray(par["axis_direction"], float)
        xdir = np.asarray(par["x_direction"], float)
        sense_axis = 1 if fwd else -1
        if frame:
            s = sense_axis * (1 if float(axis @ frame.n) > 0 else -1)
            u = [float(xdir @ frame.x), float(xdir @ frame.y)]
            return P(start), ["E"] + P(cen) + [r(par["major_radius"]), r(par["minor_radius"]), r(u[0], 4), r(u[1], 4)] + P(end) + [s], None
        return P(start), ["E"] + P(cen) + [r(par["major_radius"]), r(par["minor_radius"])] + P(end) + [sense_axis], None
    cen = ed.get("centroid", rec["start"])
    deg = par.get("degree", 0) if isinstance(par, dict) else 0
    return P(start), ["S", deg] + P(end) + [P(cen)], None


def face_loops(model, face_id, frame):
    b = brep.inspect_face_boundaries_rdescriptor(model_or_path=model, face_id=face_id, compact=True)
    loops_raw = [b["outer"]] + list(b.get("inner", []))
    out, pts = [], []
    for lp in loops_raw:
        start, segs, circle = None, [], None
        for rec in lp["edges"]:
            pts.append(rec["start"])
            pts.append(rec["end"])
            s0, seg, circ = edge_seg(model, rec, frame)
            if circ is not None:
                circle = circ
            else:
                if start is None:
                    start = s0
                segs.append(seg)
        if circle is not None and not segs:
            out.append({"c": circle[1:]})
        else:
            out.append({"s": start, "e": segs})
    return out, pts


def rect_of(loop):
    if "e" not in loop or len(loop["e"]) != 4 or any(s[0] != "L" for s in loop["e"]):
        return None
    pts = [loop["s"]] + [s[1:3] for s in loop["e"]]
    us = sorted({p[0] for p in pts})
    vs = sorted({p[1] for p in pts})
    if len(us) != 2 or len(vs) != 2:
        return None
    return [us[0], vs[0], us[1], vs[1]]


def vkey(p):
    return (round(float(p[0]), 2), round(float(p[1]), 2), round(float(p[2]), 2))


def _cap_segments(cap, loops):
    """World-space line segments and (centre, radius) arcs of a planar cap's loops."""
    fr = cap["frame"]
    world = lambda uv: fr.o + fr.x * float(uv[0]) + fr.y * float(uv[1])
    lines, arcs = [], []
    for lp in loops or []:
        if "c" in lp:
            arcs.append((world(lp["c"][:2]), float(lp["c"][2])))
            continue
        cur = lp["s"]
        for sg in lp["e"]:
            if sg[0] == "L":
                lines.append((world(cur), world(sg[1:3])))
                cur = sg[1:3]
            elif sg[0] == "A":
                arcs.append((world(sg[1:3]), float(np.linalg.norm(np.asarray(sg[1:3], float) - np.asarray(cur, float)))))
                cur = sg[3:5]
            elif sg[0] == "S":
                cur = sg[2:4]
            elif sg[0] == "E":
                cur = sg[7:9]
    return lines, arcs


def _swept(face, cap, lines, arcs):
    """True when the lateral face is the sweep of one of the cap's loop edges (so the IR can drop it)."""
    tol = TOL * max(1.0, float(np.max(np.abs(cap["o"]))))
    if face["name"] == "PLANE":
        n, o = face["n"], face["o"]
        return any(abs(float(n @ (p0 - o))) <= tol and abs(float(n @ (p1 - o))) <= tol for p0, p1 in lines)
    if face["name"] == "CYL":
        d = np.asarray(face["dirv"], float)
        d = d / (np.linalg.norm(d) or 1.0)
        for c, rad in arcs:
            w = c - face["p"]
            if np.linalg.norm(w - d * float(w @ d)) <= tol and abs(rad - float(face["rad"])) <= TOL * max(1.0, rad):
                return True
    return False


def detect_prisms(infos, order, loops=None):
    """Cap pairs of extrusions and the lateral faces they imply.

    A face is dropped from the IR only if it is the sweep of an edge of an accepted cap's loops; accepted caps are never
    dropped, and a pair is rejected when one of its caps was already dropped as another prism's lateral face. So every
    implied face can be rebuilt from the IR.
    """
    loops = loops or {}
    planar = [k for k in order if infos[k]["name"] == "PLANE"]
    cands = []                                   # (a, b, shift): first partner of every planar face, as before
    for a in planar:
        if len(infos[a]["pts"]) < 1:
            continue
        na = infos[a]["n"]
        for b in planar:
            if b == a:
                continue
            nb = infos[b]["n"]
            if not np.allclose(na, -nb, atol=1e-6):
                continue
            shift = -infos[b]["d"] - infos[a]["d"]
            if abs(shift) < 1e-6:
                continue
            vexp = {vkey(np.asarray(p) + na * shift) for p in infos[a]["pts"]}
            if vexp != {vkey(p) for p in infos[b]["pts"]}:
                continue
            if abs(infos[a]["area"] - infos[b]["area"]) > 1e-3 * max(1.0, infos[a]["area"]):
                continue
            cands.append((a, b, shift))
            break
    cands.sort(key=lambda c: (-float(f"{infos[c[0]]['area']:.4g}"), order.index(c[0])))   # main bodies claim their side faces first
    ext, twin, implied, used = {}, {}, set(), set()
    for a, b, shift in cands:
        if {a, b} & (used | implied):
            continue
        na = infos[a]["n"]
        oa, ob = infos[a]["d"], -infos[b]["d"]
        lines, arcs = _cap_segments(infos[a], loops.get(a))
        lat = set()
        for k in order:
            if k in (a, b) or k in used:
                continue
            inf = infos[k]
            if inf["name"] == "PLANE":
                if abs(float(inf["n"] @ na)) > 1e-4:
                    continue
            elif inf["name"] == "CYL":
                if abs(abs(float(np.asarray(inf["dirv"]) @ na)) - 1.0) > 1e-5:
                    continue
            else:
                continue
            if not inf["pts"]:
                continue
            if all(abs(float(np.asarray(p) @ na) - oa) <= TOL or abs(float(np.asarray(p) @ na) - ob) <= TOL
                   for p in inf["pts"]) and _swept(inf, infos[a], lines, arcs):
                lat.add(k)
        ext[a] = (b, abs(shift), shift > 0)
        twin[b] = a
        implied |= lat
        used |= {a, b}
    return ext, twin, implied


def add_cut_flags(ir_text):
    """Upgrade an IR produced before the "cut" flag existed (idempotent; same result as re-running build_ir).

    A cap pair whose outward normals face each other bounds removed material: the twin lies at +h*n from the cap.
    """
    lines = ir_text.rstrip("\n").split("\n")
    recs = [json.loads(x) for x in lines[1:]]
    byid = {j["id"]: j for j in recs}
    out = [lines[0]]
    for j in recs:
        e = j.get("ext")
        if e and "cut" not in e and e["to"] in byid:
            b = byid[e["to"]]
            if sum((ob - oa) * na for ob, oa, na in zip(b["o"], j["o"], j["n"])) > 0:
                e["cut"] = 1
        out.append(json.dumps(j, separators=(",", ":")))
    return "\n".join(out) + "\n"


CANON_CYL = os.environ.get("STEPIR_CANON_CYL", "1") == "1"


def canon_axes(ir_text):
    """IR v5 (idempotent text transform, also applied to IRs stored before it existed): every cylinder states its axis
    segment directly - d points along its dominant axis in the positive sense, p is the START point of the segment and
    v = [0, length], so a cylinder/hole reads as make_cylinder_rsolid(bottom_face_center=p, axis=d, height=v[1])."""
    lines = ir_text.rstrip("\n").split("\n")
    out = [lines[0]]
    for line in lines[1:]:
        if '"t":"CYL"' in line:
            j = json.loads(line)
            if "p" in j and "d" in j and "v" in j:
                d = np.asarray(j["d"], float)
                v0, v1 = float(j["v"][0]), float(j["v"][1])
                if d[int(np.argmax(np.abs(d)))] < 0:
                    d, v0, v1 = -d, -v1, -v0
                j["p"] = [r(c) for c in np.asarray(j["p"], float) + d * v0]
                j["d"] = [r(c, 4) for c in d]
                j["v"] = [0, r(v1 - v0)]
            line = json.dumps(j, separators=(",", ":"))
        out.append(line)
    return "\n".join(out) + "\n"


def build_ir(path):
    model = brep.load_step_rbrepmodel(path=str(path))
    summ = brep.inspect_step_rsummary(path=str(path))
    nf = len(model.faces)
    infos = []
    for i in range(nf):
        d = model.describe_entity(f"face:{i}")
        g = d["geometry"]
        p = g["parameters"]
        name = SURF.get(g["type"], "OTHER")
        nrm = np.asarray(g["normal_at_center"], float)
        inf = {"i": i, "name": name, "area": g["area"], "adj": [int(q.split(":")[1]) for q in d["adjacency"]["neighboring_faces"]], "g": g}
        if name == "PLANE":
            o = np.asarray(p["origin"], float)
            n = nrm / (np.linalg.norm(nrm) or 1.0)
            dd = float(n @ o)
            inf.update(n=n, d=dd, o=n * dd)
        elif name in ("CYL", "CONE", "TORUS"):
            ax = p["axis"]
            inf.update(p=np.asarray(ax["point"], float), dirv=np.asarray(ax["direction"], float), rad=p.get("radius", p.get("major_radius", p.get("reference_radius"))))
            c = np.asarray(g["centroid"], float)
            dv = inf["dirv"] / (np.linalg.norm(inf["dirv"]) or 1.0)
            rv = c - inf["p"] - float((c - inf["p"]) @ dv) * dv
            rr = float(np.linalg.norm(rv))
            if rr > 0.05 * float(inf["rad"] or 1.0):
                inf["ref"] = rv / rr
            inf["cc"] = 0 if reversed_face(model, i) else 1
            if name == "CONE":
                inf["ang"] = math.radians(p["semi_angle_degrees"]) if "semi_angle_degrees" in p else None
            if name == "TORUS":
                inf["rad2"] = p.get("minor_radius")
        elif name == "SPHERE":
            inf.update(p=np.asarray(p["center"], float), rad=p["radius"], dirv=np.asarray(p.get("axis_direction", [0, 0, 1]), float))
            inf["cc"] = 0 if reversed_face(model, i) else 1
        inf["ur"], inf["vr"] = p.get("u_range"), p.get("v_range")
        if name in ("BSPL", "BEZ", "OTHER"):
            inf["bb"] = [[r(c) for c in d["bounding_box"]["min"]], [r(c) for c in d["bounding_box"]["max"]]]
            inf["deg"] = [p.get("u_degree"), p.get("v_degree")]
            inf["poles"] = [p.get("u_pole_count"), p.get("v_pole_count")]
        infos.append(inf)

    def sort_key(inf):
        rk = RANK.get(inf["name"], 9)
        if inf["name"] == "PLANE":
            return (rk, tuple(round(float(c), 2) for c in inf["n"]), round(inf["d"], 3), -inf["area"])
        if "dirv" in inf:
            return (rk, round(float(inf.get("rad") or 0), 3), tuple(round(float(c), 2) for c in inf["dirv"]), -inf["area"])
        return (rk, 0, 0, -inf["area"])

    order = sorted(range(nf), key=lambda k: sort_key(infos[k]))
    newid = {k: j for j, k in enumerate(order)}
    # loops (needs frames for planar faces) and boundary points
    loops_cache = {}
    for k in order:
        inf = infos[k]
        fid = f"face:{inf['i']}"
        if inf["name"] == "PLANE":
            fr = Frame(inf["o"], inf["n"])
            loops, pts = face_loops(model, fid, fr)
            inf["frame"] = fr
        elif inf["name"] in ("BSPL", "BEZ", "OTHER"):
            loops, pts = face_loops(model, fid, None)
        else:
            loops, pts = face_loops(model, fid, None) if False else (None, None)
            b = brep.inspect_face_boundaries_rdescriptor(model_or_path=model, face_id=fid, compact=True)
            pts = []
            for lp in [b["outer"]] + list(b.get("inner", [])):
                for rec in lp["edges"]:
                    pts.append(rec["start"])
                    pts.append(rec["end"])
        loops_cache[k] = loops
        inf["pts"] = pts
    ext, twin, implied = detect_prisms(infos, order, loops_cache)
    types = Counter(inf["name"] for inf in infos)
    bb = summ["bounding_box"]
    header = {"unit": "mm", "bbox": [[r(c) for c in bb["min"]], [r(c) for c in bb["max"]]], "vol": r(summ["volume"], 2),
              "area": r(summ["surface_area"], 2), "counts": {"face": nf, "edge": summ["edge_count"]}, "types": dict(types),
              "implied": len(implied)}
    lines = [json.dumps(header, separators=(",", ":"))]
    for j, k in enumerate(order):
        if k in implied:
            continue
        inf = infos[k]
        rec = {"id": j, "t": inf["name"], "A": r(inf["area"], 2)}
        if inf["name"] == "PLANE":
            fr = inf["frame"]
            rec.update(o=[r(c) for c in inf["o"]], n=[r(c, 4) for c in inf["n"]], x=[r(c, 4) for c in fr.x])
            if k in twin:
                rec["twin"] = newid[twin[k]]
            else:
                if k in ext:
                    rec["ext"] = {"to": newid[ext[k][0]], "h": r(ext[k][1])}
                    if ext[k][2]:
                        rec["ext"]["cut"] = 1
                loops = loops_cache[k]
                rects = [rect_of(l) for l in loops]
                if len(loops) == 1 and rects[0] is not None:
                    rec["rect"] = rects[0]
                else:
                    rec["loops"] = loops
        else:
            if "p" in inf:
                rec["p"] = [r(c) for c in inf["p"]]
            if "dirv" in inf:
                rec["d"] = [r(c, 4) for c in inf["dirv"]]
            if inf.get("rad") is not None:
                rec["r"] = r(inf["rad"])
            if inf.get("rad2") is not None:
                rec["r2"] = r(inf["rad2"])
            if inf.get("ang") is not None:
                rec["ang"] = r(math.degrees(inf["ang"]), 2)
            if ENDCAPS and inf["name"] in ("CYL", "CONE") and inf.get("vr"):
                dv = np.asarray(inf["dirv"], float)
                dv = dv / (np.linalg.norm(dv) or 1.0)
                v0, v1 = inf["vr"]
                if inf["name"] == "CYL":
                    z0, z1, r0, r1 = v0, v1, inf["rad"], inf["rad"]
                else:
                    a_ = inf["ang"]
                    z0, z1 = v0 * math.cos(a_), v1 * math.cos(a_)
                    r0, r1 = inf["rad"] + v0 * math.sin(a_), inf["rad"] + v1 * math.sin(a_)
                rec["c0"] = [r(c) for c in inf["p"] + dv * z0]
                rec["c1"] = [r(c) for c in inf["p"] + dv * z1]
                if inf["name"] == "CONE":
                    rec["r0"], rec["r1"] = r(r0), r(r1)
                    rec.pop("r", None)
                rec.pop("p", None)
            if inf["name"] in ("CYL", "CONE", "SPHERE", "TORUS"):
                lin = inf["name"] in ("CYL", "CONE")
                ur, vr = inf["ur"], inf["vr"]
                if ur:
                    span = math.degrees(ur[1] - ur[0])
                    rec["span"] = r(span, 1)
                    if "ref" in inf and span < 359.0:
                        rec["ref"] = [r(c, 4) for c in inf["ref"]]
                if vr and not ("c0" in rec):
                    rec["v"] = [r(vr[0]), r(vr[1])] if lin else [r(math.degrees(vr[0]), 1), r(math.degrees(vr[1]), 1)]
                rec["cc"] = inf["cc"]
            else:
                rec["bb"] = inf["bb"]
                rec["deg"] = inf["deg"]
                rec["poles"] = inf["poles"]
                rec["loops"] = loops_cache[k]
            adj = sorted(newid[q] for q in inf["adj"])
            if 0 < len(adj) <= 6:
                rec["adj"] = adj
        lines.append(json.dumps(rec, separators=(",", ":")))
    if CANON_CYL:
        lines = canon_axes("\n".join(lines)).rstrip("\n").split("\n")
    build_ir.last_face_map = dict(newid)      # original face index -> IR id, for tools that need to join with the B-rep
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step")
    ap.add_argument("--out")
    a = ap.parse_args()
    text = "\n".join(build_ir(a.step)) + "\n"
    if a.out:
        open(a.out, "w").write(text)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
