#!/usr/bin/env python3
"""Robust volumetric IoU between two STEP solids, independent of OCC boolean fragility.

SimpleCADAPI-only CAD path: STEP loaded with simplecadapi.inspect.brep.load_step_rshape and tessellated with the
SDK's own simplecadapi.exporter._surface_mesh.tessellate_solid (vertex-welded, orientation-correct). The two
triangle meshes are intersected with manifold3d (a mesh boolean library; guaranteed-valid output, symbolic
perturbation for coincident faces).

Complements the frozen strict B-rep IoU (tools/frozen/compare.py), which returns 0 / invalid for faithful
reconstructions of real-world targets when surfaces are (nearly) coincident.

Usage: robust_iou.py target.step candidate.step  -> JSON line.  Needs simplecadapi + numpy + manifold3d.
"""
import json
import sys

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cadthreads  # noqa: E402
cadthreads.limit()
import numpy as np
import manifold3d as m3d
from simplecadapi.exporter._surface_mesh import tessellate_solid
from simplecadapi.inspect import brep

REL_DEFLECTION = 1.0e-4
ANGULAR_DEG = 8.0


def mesh_of(path):
    diag = brep.inspect_step_rsummary(path=str(path))["bounding_box"]["diagonal"]
    shape = brep.load_step_rshape(path=str(path))
    v, t = tessellate_solid(shape, linear_deflection=max(diag * REL_DEFLECTION, 1e-6),
                            angular_deflection_degrees=ANGULAR_DEG, relative=False)
    return v, t


def manifold_of(v, t, centre):
    mesh = m3d.Mesh(vert_properties=np.asarray(v - centre, dtype=np.float32), tri_verts=np.asarray(t, dtype=np.uint32))
    man = m3d.Manifold(mesh)
    if man.status() != m3d.Error.NoError:
        raise ValueError(f"mesh is not a valid manifold: {man.status()}")
    return man


def sample_surface(v, t, n, rng):
    """n points spread over the triangle mesh, each triangle drawn with probability proportional to its area."""
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    tot = area.sum()
    if tot <= 0:
        raise ValueError("degenerate mesh: zero surface area")
    idx = rng.choice(len(t), size=n, p=area / tot)
    u, w = rng.random((n, 1)), rng.random((n, 1))
    flip = (u + w) > 1
    u[flip], w[flip] = 1 - u[flip], 1 - w[flip]
    return a[idx] + u * (b[idx] - a[idx]) + w * (c[idx] - a[idx])


def chamfer_hausdorff(vt, tt, vc, tc, n_points=32768, seed=0):
    """Chamfer and Hausdorff distance between two surfaces, in units of the TARGET's bounding-box diagonal.

    Both shapes are divided by that diagonal, so the numbers are scale-free and comparable across parts (papers that report
    CD/HD on CAD benchmarks normalise too, but not always the same way, so state this normalisation when comparing).
    CD is the symmetric mean of nearest-neighbour distances (the average of the two directions), HD the symmetric maximum.
    Both are point-sampled, as in the CAD-generation literature, so they have a noise floor: two identical shapes score about
    0.004 (CD) and 0.013 (HD) at 32768 points, not 0. Report that floor whenever these numbers are compared with a baseline.
    """
    from scipy.spatial import cKDTree
    rng = np.random.default_rng(seed)
    scale = float(np.linalg.norm(vt.max(axis=0) - vt.min(axis=0)))
    if scale <= 0:
        raise ValueError("degenerate target bounding box")
    pt = sample_surface(vt, tt, n_points, rng) / scale
    pc = sample_surface(vc, tc, n_points, rng) / scale
    d_tc = cKDTree(pc).query(pt)[0]
    d_ct = cKDTree(pt).query(pc)[0]
    return {"cd": float((d_tc.mean() + d_ct.mean()) / 2.0), "hd": float(max(d_tc.max(), d_ct.max())),
            "cd_points": n_points, "normalised_by": "target bbox diagonal"}


def robust_iou(target_path, cand_path):
    out = {"riou": 0.0, "ok": False}
    try:
        vt, tt = mesh_of(target_path)
        vc, tc = mesh_of(cand_path)
        centre = (vt.min(axis=0) + vt.max(axis=0)) / 2.0
        a, b = manifold_of(vt, tt, centre), manifold_of(vc, tc, centre)
        va, vb = a.volume(), b.volume()
        inter = (a ^ b).volume()
        union = va + vb - inter
        out.update(ok=True, riou=float(inter / union) if union > 0 else 0.0, vol_target=va, vol_cand=vb, inter=inter,
                   rel_vol_err=abs(vb - va) / max(va, 1e-12))
        try:                                   # surface distances: comparable with CAD papers that report CD / HD
            out.update(chamfer_hausdorff(vt, tt, vc, tc))
        except Exception as e:  # noqa: BLE001
            out["cd_error"] = f"{type(e).__name__}: {str(e)[:120]}"
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {str(e)[:200]}"
    return out


if __name__ == "__main__":
    print(json.dumps(robust_iou(sys.argv[1], sys.argv[2])))
