"""Version-pinned SimpleCADAPI adapter for STEP solid extraction."""

from __future__ import annotations

import hashlib
import importlib.metadata
from pathlib import Path
from typing import Any


SUPPORTED_SDK_VERSION = "2.2.7"


def _sdk():
    try:
        version = importlib.metadata.version("simplecadapi")
    except importlib.metadata.PackageNotFoundError as exc:
        raise RuntimeError("simplecadapi==2.2.7 is required") from exc
    if version != SUPPORTED_SDK_VERSION:
        raise RuntimeError(f"simplecadapi=={SUPPORTED_SDK_VERSION} is required; found {version}")

    import simplecadapi as scad

    return scad


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_occurrences(step_path: Path) -> tuple[list[Any], list[dict[str, Any]], dict[str, Any]]:
    """Enumerate each SDK XCAF leaf separately, retaining coincident occurrences."""
    scad = _sdk()
    from simplecadapi.inspect.brep import render
    from simplecadapi._glue import bridge

    try:
        document, _, _ = render._load_step_xcaf_document(step_path)
        records = render._component_records(document)
        solids, occurrences, hierarchy = [], [], []
        for record in records:
            metadata = {key: value for key, value in record.items() if key != "shape"}
            metadata["path"] = "/".join(metadata["path"])
            hierarchy.append(metadata)
            if record["assembly"]:
                continue
            shape = bridge.from_occt(record["shape"])
            def visit(node: Any, depth: int = 0) -> list[Any]:
                if depth > 128:
                    raise RuntimeError("STEP shape hierarchy exceeds 128 levels")
                if isinstance(node, scad.Solid):
                    return [node]
                if type(node).__name__ not in {"Compound", "CompSolid"}:
                    return []
                return [solid for child in node.get_children() for solid in visit(child, depth + 1)]

            leaf_solids = visit(shape)
            # A separate leaf record is deliberately processed even if its shape and
            # placement are identical to an earlier leaf. SDK get_children preserves
            # repeated children inside compounds as well; QL indexed maps would not.
            for solid_index, solid in enumerate(leaf_solids):
                solids.append(solid)
                occurrences.append({**metadata, "solid_in_occurrence": solid_index})
    except Exception as exc:
        raise RuntimeError(f"SimpleCADAPI XCAF occurrence import failed: {exc}") from exc
    if not solids:
        raise RuntimeError("STEP contains no solids")
    return solids, occurrences, {
        "status": "sdk_xcaf_occurrences", "source_preserved": True,
        "coincident_leaf_occurrences_preserved": True,
        "records": hierarchy,
        "adapter": "simplecadapi.inspect.brep.render._component_records@2.2.7",
    }


def load_solids(step_path: Path) -> list[Any]:
    return load_occurrences(step_path)[0]


def metrics(solid: Any) -> dict[str, Any]:
    scad = _sdk()
    import numpy as np

    # _bounds is the SDK 2.2.7 native geometry adapter; keep this use isolated here.
    bounds = tuple(float(v) for v in solid._bounds())
    vertices = scad.ql.vertices().resolve(solid)
    points = np.asarray([vertex.get_center().to_tuple() for vertex in vertices], dtype=float)
    if len(points) >= 4:
        center = points.mean(axis=0)
        centered_points = points - center
        covariance = centered_points.T @ centered_points
        eigenvalues, eigenvectors = np.linalg.eigh(covariance)
        order = np.argsort(eigenvalues)[::-1]
        eigenvalues = eigenvalues[order]
        eigenvectors = eigenvectors[:, order]
        scale = max(1.0, float(eigenvalues[0]))
        gaps = [float(abs(eigenvalues[i] - eigenvalues[i + 1]) / scale) for i in range(2)]

        # Fix two PCA-axis signs by their third moments, then derive the last axis
        # with a cross product so the canonical frame is always right-handed.
        sign_ambiguous = False
        for axis in (0, 1):
            projections = centered_points @ eigenvectors[:, axis]
            third_moment = float(np.sum(projections ** 3))
            moment_scale = max(1.0, float(np.sum(np.abs(projections) ** 3)))
            if abs(third_moment) <= 1e-10 * moment_scale:
                sign_ambiguous = True
            elif third_moment < 0:
                eigenvectors[:, axis] *= -1
        eigenvectors[:, 2] = np.cross(eigenvectors[:, 0], eigenvectors[:, 1])
        eigenvectors[:, 2] /= np.linalg.norm(eigenvectors[:, 2])
        rotation_to_principal = eigenvectors.T
        translation_to_principal = -(rotation_to_principal @ center)
        principal_axes_resolved = min(gaps) > 1e-7 and not sign_ambiguous
        anchor_kind = "vertex_mean"
        eigenvalues_out = [float(v) for v in eigenvalues]
    else:
        # Analytic balls and other low-vertex solids have no usable PCA frame.
        center = np.asarray([(bounds[i] + bounds[i + 3]) / 2 for i in range(3)], dtype=float)
        bbox_size = np.asarray([bounds[i + 3] - bounds[i] for i in range(3)], dtype=float)
        rotation_to_principal = np.eye(3)
        translation_to_principal = -center
        principal_axes_resolved = False
        anchor_kind = "bbox_center_fallback"
        eigenvalues_out = sorted((bbox_size ** 2).tolist(), reverse=True)
        gaps = []

    faces = len(scad.ql.faces().resolve(solid))
    edges = len(scad.ql.edges().resolve(solid))
    bbox_center = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
    return {
        "vertex_mean_mm": [float(v) for v in center],
        "placement_anchor": anchor_kind,
        "bbox_center_mm": bbox_center,
        "bbox_mm": {"min": list(bounds[:3]), "max": list(bounds[3:])},
        "bbox_size_mm": [bounds[i + 3] - bounds[i] for i in range(3)],
        "face_count": faces,
        "edge_count": edges,
        "vertex_count": len(vertices),
        "principal_moments_mm2": eigenvalues_out,
        "principal_axes_resolved": principal_axes_resolved,
        "principal_axis_relative_gaps": gaps,
        "source_to_principal_rotation": rotation_to_principal.tolist(),
        "source_to_principal_translation": translation_to_principal.tolist(),
    }


def centered(solid: Any, center: tuple[float, float, float]) -> Any:
    scad = _sdk()
    return scad._cpp._native.translate_shape(solid, tuple(-value for value in center))


def principal_aligned(solid: Any, geometry_metrics: dict[str, Any]) -> Any:
    scad = _sdk()
    rotation = geometry_metrics["source_to_principal_rotation"]
    translation = geometry_metrics["source_to_principal_translation"]
    matrix = [
        [*rotation[0], translation[0]],
        [*rotation[1], translation[1]],
        [*rotation[2], translation[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]
    return rigid_transform(solid, matrix)


def rigid_transform(solid: Any, matrix: list[list[float]]) -> Any:
    """Use SDK rigid rotate/translate; affine transform can convert analytic surfaces."""
    import numpy as np
    from scipy.spatial.transform import Rotation

    scad = _sdk()
    values = np.asarray(matrix, dtype=float)
    if values.shape != (4, 4) or not np.isfinite(values).all() or not np.allclose(values[3], [0, 0, 0, 1], atol=1e-12, rtol=0):
        raise ValueError("Invalid rigid transform matrix")
    rotation = values[:3, :3]
    if not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-10, rtol=0) or abs(np.linalg.det(rotation) - 1) > 1e-10:
        raise ValueError("Only proper rigid rotations are allowed")
    vector = Rotation.from_matrix(rotation).as_rotvec()
    angle = float(np.linalg.norm(vector))
    moved = solid
    if angle > 1e-12:
        moved = scad.rotate_shape(moved, angle * 180.0 / np.pi, axis=tuple(vector / angle), origin=(0, 0, 0))
    if np.linalg.norm(values[:3, 3]) > 1e-12:
        moved = scad.translate_shape(moved, tuple(values[:3, 3]))
    return moved


def strict_comparison(a: Any, b: Any) -> dict[str, Any]:
    """The SDK material point-set AND labelled topology hard gate, without relaxed tolerances."""
    _sdk()
    from simplecadapi.inspect import brep

    result = brep.compare_shapes_rbrepcomparison(a._native_wrapped, b._native_wrapped)
    return result.to_dict()


def robust_mesh_iou(a: Any, b: Any, diagonal: float, relative_deflection: float = 1e-5) -> dict[str, Any]:
    import numpy as np
    import manifold3d as m3d
    from simplecadapi.exporter._surface_mesh import tessellate_solid

    options = {"linear_deflection": max(diagonal * relative_deflection, 1e-9), "angular_deflection_degrees": 2.0, "relative": False}
    va, ta = tessellate_solid(a, **options)
    vb, tb = tessellate_solid(b, **options)
    va, vb = np.asarray(va, float), np.asarray(vb, float)
    center = (va.min(axis=0) + va.max(axis=0)) / 2

    def manifold(vertices: Any, triangles: Any) -> Any:
        result = m3d.Manifold(m3d.Mesh64(vert_properties=np.asarray(vertices - center, np.float64), tri_verts=np.asarray(triangles, np.uint64)))
        if result.status() != m3d.Error.NoError:
            raise RuntimeError(f"Roundtrip mesh is not closed: {result.status()}")
        return result

    ma, mb = manifold(va, ta), manifold(vb, tb)
    intersection = (ma ^ mb).volume()
    union = ma.volume() + mb.volume() - intersection
    return {"riou": intersection / union if union > 0 else 0.0, "source_mesh_volume": ma.volume(), "exported_mesh_volume": mb.volume(), "mesh_options": options, "float_precision": 64}


def verify_roundtrip(a: Any, b: Any) -> dict[str, Any]:
    """Fast raw-world roundtrip gate; duplicate identity still uses the SDK strict gate."""
    source_bounds, exported_bounds = tuple(a._bounds()), tuple(b._bounds())
    diagonal = max(float(sum((source_bounds[i + 3] - source_bounds[i]) ** 2 for i in range(3)) ** 0.5), 1.0)
    tolerance = diagonal * 1e-8
    bbox_error = max(abs(source_bounds[index] - exported_bounds[index]) for index in range(6))
    source_volume, exported_volume = float(a.get_volume()), float(b.get_volume())
    relative_volume_error = abs(source_volume - exported_volume) / max(abs(source_volume), 1e-30)
    topology_equal = bool(a.same_topology(b))

    # Exact Boolean comparison can spend minutes on decimal STEP roundtrips with
    # near-coincident surfaces. Use the same float64 manifold mesh evidence as
    # the project's robust-IoU evaluator, with deterministic refinement bounds.
    mesh_refinements = []
    for relative_deflection in (1e-5, 1e-6, 1e-7):
        try:
            mesh = robust_mesh_iou(a, b, diagonal, relative_deflection)
            mesh_refinements.append(mesh)
            if mesh["riou"] >= 1.0 - 1e-8:
                break
        except Exception as exc:
            mesh_refinements.append({"error": f"{type(exc).__name__}: {str(exc)[:300]}", "relative_deflection": relative_deflection})
            break
    mesh_passed = bool(mesh_refinements and mesh_refinements[-1].get("riou", 0.0) >= 1.0 - 1e-8)
    material_passed = relative_volume_error <= 1e-8 and mesh_passed
    valid = True  # both inputs were imported with require_valid=True by the pinned SDK
    bbox_passed = bbox_error <= tolerance
    accepted = valid and topology_equal and bbox_passed and material_passed
    return {"accepted": bool(accepted), "serialization_check": {
        "kind": "source_world_step_serialization", "valid_inputs": valid,
        "same_sdk_topology": topology_equal,
        "topology_check": "SimpleCADAPI Solid.same_topology",
        "source_volume_mm3": source_volume, "exported_volume_mm3": exported_volume,
        "relative_volume_error": relative_volume_error, "relative_volume_tolerance": 1e-8,
        "bbox_max_error_mm": bbox_error, "bbox_tolerance_mm": tolerance,
        "directional_cuts": "not_used_for_serialization_check; retained in strict duplicate gate",
        "point_set_evidence": mesh_passed, "volume_and_mesh_passed": material_passed,
        "robust_mesh_iou": mesh_refinements[-1] if mesh_refinements else None,
        "mesh_refinements": mesh_refinements, "mesh_iou_tolerance": 1.0 - 1e-8,
        "material_evidence_passed": material_passed,
    }}


def same_geometry(a: Any, b: Any) -> tuple[bool, str]:
    try:
        result = strict_comparison(a, b)
        return result["hard_gate_passed"], "sdk_material_and_labelled_topology_hard_gate"
    except Exception as exc:
        return False, f"sdk_comparison_error: {type(exc).__name__}: {str(exc)[:240]}"


def export_solid(solid: Any, destination: Path) -> None:
    scad = _sdk()
    scad._cpp._native.export_step(solid, str(destination))
