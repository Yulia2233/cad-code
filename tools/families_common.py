"""Canonical sketch-plane helpers shared by all part-family generators (must match tools/stepir.canon_frame).

A sketch plane is fully determined by its normal n and one point on it:
    origin = n * (n . p)           (foot of the perpendicular from the world origin)
    x_axis = normalize(up x n)     with up = (0,0,1), or (0,1,0) if |n_z| >= 0.9
    y_axis = n x x_axis
All profile coordinates are then plain local coordinates u = (P - origin).x_axis, v = (P - origin).y_axis.
"""
import math


def _norm(v):
    l = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / l for c in v)


def canon_frame(n):
    n = _norm(n)
    nx, ny, nz = n
    up = (0.0, 0.0, 1.0) if abs(nz) < 0.9 else (0.0, 1.0, 0.0)
    x = _norm((up[1] * nz - up[2] * ny, up[2] * nx - up[0] * nz, up[0] * ny - up[1] * nx))
    y = (n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0])
    return x, y


class Plane:
    """Canonical plane through `point` with normal `n`.  Use .local(P) for profile coordinates and .literal() for the
    `plane=` argument text of scad.make_sketch_rsketch."""

    def __init__(self, n, point):
        self.n = _norm(n)
        d = sum(a * b for a, b in zip(self.n, point))
        self.origin = tuple(round(c * d, 4) + 0.0 for c in self.n)
        x, y = canon_frame(self.n)
        self.x = tuple(round(c, 4) + 0.0 for c in x)
        self.y = tuple(round(c, 4) + 0.0 for c in y)
        self._x, self._y = x, y

    def local(self, p):
        d = [p[i] - self.origin[i] for i in range(3)]
        return (round(sum(d[i] * self._x[i] for i in range(3)), 4) + 0.0, round(sum(d[i] * self._y[i] for i in range(3)), 4) + 0.0)

    def world(self, uv):
        return tuple(self.origin[i] + uv[0] * self._x[i] + uv[1] * self._y[i] for i in range(3))

    def literal(self):
        f = lambda t: "(" + ", ".join(repr(c) for c in t) + ")"
        return "{'origin': %s, 'x_axis': %s, 'y_axis': %s}" % (f(self.origin), f(self.x), f(self.y))


def _num(v):
    v = round(float(v), 4) + 0.0
    return str(int(v)) if v == int(v) and abs(v) < 1e9 else repr(v)


CHAIN_BUILDER = """firsts = []
for li, lp in enumerate(loops):
    if lp[0][0] == 'C':
        s = scad.add_point_rsketch(sketch=s, point_id=f'l{li}c', x=lp[0][1], y=lp[0][2])
        s = scad.add_circle_rsketch(sketch=s, entity_id=f'l{li}', center=f'l{li}c', radius=lp[0][3])
        firsts.append(f'l{li}')
        continue
    s = scad.add_point_rsketch(sketch=s, point_id=f'l{li}p0', x=lp[0][0], y=lp[0][1])
    prev = f'l{li}p0'
    for k, sg in enumerate(lp[1:], 1):
        end = f'l{li}p0' if k == len(lp) - 1 else f'l{li}p{k}'
        ex, ey = (sg[1], sg[2]) if sg[0] == 'L' else (sg[3], sg[4])
        if end != f'l{li}p0':
            s = scad.add_point_rsketch(sketch=s, point_id=end, x=ex, y=ey)
        if sg[0] == 'L':
            s = scad.add_line_rsketch(sketch=s, entity_id=f'l{li}e{k}', start=prev, end=end)
        else:
            s = scad.add_point_rsketch(sketch=s, point_id=f'l{li}c{k}', x=sg[1], y=sg[2])
            a, b = (prev, end) if sg[5] > 0 else (end, prev)
            s = scad.add_arc_rsketch(sketch=s, entity_id=f'l{li}e{k}', start=a, end=b, center=f'l{li}c{k}')
        prev = end
    firsts.append(f'l{li}e1')"""


def chain_sketch(plane, loops, name="sk", face_var="face", indent="    "):
    """Code text of one sketch in the canonical CHAIN style (the same format the oracle decoder writes for prisms).

    plane : Plane;  loops : list of loops in the plane's local (u, v) coordinates, outer loop first, then holes:
        {"c": (cx, cy, r)}                                   full circle
        {"s": (x, y), "e": [("L", x, y), ("A", cx, cy, x, y, s), ...]}   chain from s; s=+1 ccw / -1 cw about (cx, cy);
                                                               the last segment must end back at s (closed loop).
    Emits:  s = make_sketch(...); loops = [...]; <fixed builder>; <face_var> = make_face_from_sketch(profile=firsts[0], inner=firsts[1:])
    """
    L = [f"s = scad.make_sketch_rsketch(name={name!r}, plane={plane.literal()})", "loops = ["]
    for lp in loops:
        if "c" in lp:
            cx, cy, r = lp["c"]
            L.append(f"    [('C', {_num(cx)}, {_num(cy)}, {_num(r)})],")
            continue
        items = [f"({_num(lp['s'][0])}, {_num(lp['s'][1])})"]
        cur = (round(float(lp["s"][0]), 4), round(float(lp["s"][1]), 4))
        for sg in lp["e"]:
            if sg[0] == "L":
                if (round(float(sg[1]), 4), round(float(sg[2]), 4)) == cur:
                    continue
                items.append(f"('L', {_num(sg[1])}, {_num(sg[2])})")
                cur = (round(float(sg[1]), 4), round(float(sg[2]), 4))
            elif sg[0] == "A":
                items.append(f"('A', {_num(sg[1])}, {_num(sg[2])}, {_num(sg[3])}, {_num(sg[4])}, {1 if sg[5] > 0 else -1})")
                cur = (round(float(sg[3]), 4), round(float(sg[4]), 4))
            else:
                raise ValueError(f"unsupported segment {sg[0]}")
        L.append("    [" + ", ".join(items) + "],")
    L.append("]")
    L += CHAIN_BUILDER.split("\n")
    L.append(f"{face_var} = scad.make_face_from_sketch_rface(sketch=s, profile=firsts[0], inner_profiles=firsts[1:])")
    return "\n".join(indent + x for x in L)
