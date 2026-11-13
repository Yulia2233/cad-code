#!/usr/bin/env python3
"""Inspect and split multi-solid STEP files into v6.3 single-part jobs."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from sdk_adapter import (
    SUPPORTED_SDK_VERSION,
    export_solid,
    load_solids,
    load_occurrences,
    metrics,
    rigid_transform,
    strict_comparison,
    verify_roundtrip,
    sha256_file,
)


SCHEMA_VERSION = "step-assembly-ir-v1"
PREPROCESS_VERSION = "step-multisolid-preprocess-v2"
IR_VERSION = "v6.3"
STEPIR_V63_SHA256 = "bce850d29452142f8e54387d8a4a7c820ced744fb61aa3e953b71c8aa4bb371c"


def _progress(stage: str, **details: Any) -> None:
    marker = os.environ.get("MULTISOLID_PROGRESS_FILE")
    if marker:
        destination = Path(marker)
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_text(json.dumps({"stage": stage, **details}) + "\n")
        temporary.replace(destination)


def _placement_from_transform(matrix: list[list[float]]) -> dict[str, list[float]]:
    return {
        "origin": [float(matrix[row][3]) for row in range(3)],
        "x_axis": [float(matrix[row][0]) for row in range(3)],
        "y_axis": [float(matrix[row][1]) for row in range(3)],
    }


def _relative_transform(rep: dict[str, Any], current: dict[str, Any]) -> list[list[float]]:
    """Return the source-world transform taking representative points to current points."""
    import numpy as np

    r_rep = np.asarray(rep["source_to_principal_rotation"], dtype=float)
    t_rep = np.asarray(rep["source_to_principal_translation"], dtype=float)
    r_current = np.asarray(current["source_to_principal_rotation"], dtype=float)
    t_current = np.asarray(current["source_to_principal_translation"], dtype=float)
    rotation = r_current.T @ r_rep
    translation = r_current.T @ (t_rep - t_current)
    matrix = np.eye(4)
    matrix[:3, :3] = rotation
    matrix[:3, 3] = translation
    return [[float(value) for value in row] for row in matrix]


class UnsupportedInput(RuntimeError):
    def __init__(self, stage: str, message: str, evidence: dict[str, Any] | None = None):
        super().__init__(message)
        self.stage = stage
        self.evidence = evidence or {}


def _identity() -> list[list[float]]:
    return [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def _translation(rep: dict[str, Any], current: dict[str, Any]) -> list[list[float]]:
    result = _identity()
    for axis in range(3):
        result[axis][3] = current["vertex_mean_mm"][axis] - rep["vertex_mean_mm"][axis]
    return result


def _bbox_relations(rows: list[dict[str, Any]], neighbors_per_instance: int = 8) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return bounded nearest-AABB facts instead of a quadratic relation dump."""
    import math
    import heapq

    if neighbors_per_instance < 1:
        raise ValueError("neighbors_per_instance must be positive")
    heaps: list[list[tuple[float, int, tuple[float, float, float]]]] = [[] for _ in rows]
    for index, left in enumerate(rows):
        a = left["metrics"]["bbox_mm"]
        for right_index in range(index + 1, len(rows)):
            right = rows[right_index]
            b = right["metrics"]["bbox_mm"]
            gaps = tuple(max(0.0, a["min"][k] - b["max"][k], b["min"][k] - a["max"][k]) for k in range(3))
            distance = math.sqrt(sum(value * value for value in gaps))
            for owner, neighbor in ((index, right_index), (right_index, index)):
                heap = heaps[owner]
                item = (-distance, -neighbor, gaps)
                if len(heap) < neighbors_per_instance:
                    heapq.heappush(heap, item)
                elif item > heap[0]:
                    heapq.heapreplace(heap, item)

    retained: dict[tuple[int, int], tuple[float, tuple[float, float, float]]] = {}
    for owner, heap in enumerate(heaps):
        for neg_distance, neg_neighbor, gaps in heap:
            neighbor = -neg_neighbor
            pair = (min(owner, neighbor), max(owner, neighbor))
            retained[pair] = (-neg_distance, gaps)

    result = []
    for (left_index, right_index), (distance, gaps) in sorted(retained.items()):
        result.append({
            "kind": "bbox_distance_lower_bound",
            "instances": [rows[left_index]["id"], rows[right_index]["id"]],
            "distance_lower_bound_mm": distance,
            "axis_gaps_mm": list(gaps),
            "evidence": "source_world_axis_aligned_bounding_boxes",
            "selection": "nearest_neighbors_top_k_per_instance",
            "interpretation": "Positive bound proves separation. Zero does not establish contact, overlap, or an engineering mate.",
        })
    possible = len(rows) * (len(rows) - 1) // 2
    return result, {
        "kind": "bounded_nearest_bbox_neighbors",
        "possible_pair_count": possible,
        "retained_pair_count": len(result),
        "omitted_pair_count": possible - len(result),
        "per_instance_limit": neighbors_per_instance,
        "relation_semantics": "diagnostic_lower_bound_only_not_mate_evidence",
    }


def inspect_step(step_path: Path) -> dict[str, Any]:
    step_path = step_path.resolve(strict=True)
    solids, occurrences, hierarchy = load_occurrences(step_path)
    return {
        "schema_version": "step-multisolid-inspect-v1",
        "source": {"path": str(step_path), "sha256": sha256_file(step_path)},
        "solid_count": len(solids),
        "hierarchy": hierarchy,
        "solids": [
            {"source_solid_id": f"solid-{index:03d}", "source_occurrence": occurrences[index], **metrics(solid)}
            for index, solid in enumerate(solids)
        ],
    }


def _coarse_match(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if any(a[key] != b[key] for key in ("face_count", "edge_count", "vertex_count")):
        return False
    ea = a["principal_moments_mm2"]
    eb = b["principal_moments_mm2"]
    scale = max(1.0, *(abs(value) for value in ea), *(abs(value) for value in eb))
    return all(abs(x - y) <= scale * 1e-8 for x, y in zip(ea, eb))


def _run_stepir(
    step_path: Path,
    ir_path: Path,
    *,
    python: Path,
    script: Path,
) -> dict[str, Any]:
    result = subprocess.run(
        [str(python), str(script), str(step_path), "--out", str(ir_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=600,
    )
    if result.returncode:
        raise RuntimeError(
            f"STEPIR failed for {step_path.name} (exit {result.returncode}): "
            f"{result.stderr[-2000:]}"
        )
    records = [line for line in ir_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not records:
        raise RuntimeError(f"STEPIR produced empty IR for {step_path.name}")
    header = json.loads(records[0])
    if header.get("solids") != 1:
        raise RuntimeError(f"Expected single-solid v6.3 IR for {step_path.name}; header={header}")
    return {"header": header, "sha256": sha256_file(ir_path)}


def prepare_project(
    step_path: Path,
    out_dir: Path,
    *,
    python: Path,
    stepir_script: Path,
) -> dict[str, Any]:
    step_path = step_path.resolve(strict=True)
    out_dir = out_dir.resolve()
    if out_dir.exists():
        raise FileExistsError(f"Output already exists: {out_dir}")
    if not stepir_script.is_file():
        raise FileNotFoundError(f"STEPIR v6.3 script not found: {stepir_script}")
    if sha256_file(stepir_script) != STEPIR_V63_SHA256:
        raise ValueError("STEPIR script is not the frozen v6.3 bundle: SHA256 mismatch")
    if not python.is_file():
        raise FileNotFoundError(f"Python interpreter not found: {python}")

    _progress("load_source_occurrences", source=str(step_path))
    solids, occurrences, hierarchy = load_occurrences(step_path)
    source_hash = sha256_file(step_path)
    out_dir.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=f".{out_dir.name}.prepare-", dir=out_dir.parent) as raw_tmp:
        work_dir = Path(raw_tmp)
        (work_dir / "source").mkdir()
        (work_dir / "split").mkdir()
        (work_dir / "unique").mkdir()
        copied_source = work_dir / "source" / "source.step"
        shutil.copyfile(step_path, copied_source)

        instance_rows: list[dict[str, Any]] = []
        representative_indices: list[int] = []
        match_rows: list[dict[str, Any]] = []

        for index, solid in enumerate(solids):
            instance_id = f"instance-{index:03d}"
            source_solid_id = f"solid-{index:03d}"
            _progress("source_metrics", instance_id=instance_id, source_occurrence=occurrences[index], work_dir=str(work_dir))
            row_metrics = metrics(solid)
            split_path = work_dir / "split" / f"{instance_id}.step"
            _progress("split_export", instance_id=instance_id, source_occurrence=occurrences[index], work_dir=str(work_dir))
            export_solid(solid, split_path)
            split_solids = load_solids(split_path)
            if len(split_solids) != 1:
                raise UnsupportedInput("split_roundtrip", "Split output is not one solid", {"instance_id": instance_id})
            # A STEP roundtrip is checked in SOURCE WORLD coordinates. A second
            # PCA fit may flip signs or encounter symmetric axes after export.
            try:
                _progress("split_world_verification", instance_id=instance_id, source_occurrence=occurrences[index], work_dir=str(work_dir))
                roundtrip_result = verify_roundtrip(solid, split_solids[0])
                roundtrip = roundtrip_result
            except Exception as exc:
                raise UnsupportedInput("split_roundtrip", f"SDK strict comparison failed: {exc}", {"instance_id": instance_id}) from exc
            if not roundtrip_result["accepted"]:
                raise UnsupportedInput("split_roundtrip", "Source-world STEP serialization check failed", {"instance_id": instance_id, "source_occurrence": occurrences[index], "serialization_check": roundtrip_result["serialization_check"]})

            match_index, match_method, match_proof = None, "unique", None
            alignment_mode, transform = "source_world_identity", _identity()
            candidate_evidence = []
            for candidate in representative_indices:
                rep_metrics = instance_rows[candidate]["metrics"]
                if not _coarse_match(row_metrics, rep_metrics):
                    continue
                candidates = [("translation_only", _translation(rep_metrics, row_metrics))]
                if rep_metrics["principal_axes_resolved"] and row_metrics["principal_axes_resolved"]:
                    candidates.append(("principal_axes", _relative_transform(rep_metrics, row_metrics)))
                for mode, matrix in candidates:
                    try:
                        _progress("dedup_rigid_verification", instance_id=instance_id, representative=candidate, alignment_mode=mode, work_dir=str(work_dir))
                        moved = rigid_transform(solids[candidate], matrix)
                        proof = strict_comparison(moved, solid)
                        candidate_evidence.append({"representative_instance": f"instance-{candidate:03d}", "alignment_mode": mode, "comparison": {key: proof[key] for key in ("hard_gate_passed", "same_geometric_point_set", "geometry_labelled_incidence_graph_isomorphic", "target_minus_candidate_volume", "candidate_minus_target_volume")}})
                    except Exception as exc:
                        candidate_evidence.append({"representative_instance": f"instance-{candidate:03d}", "alignment_mode": mode, "error": f"{type(exc).__name__}: {str(exc)[:400]}"})
                        continue
                    if proof["hard_gate_passed"]:
                        match_index, transform, alignment_mode = candidate, matrix, mode
                        match_method, match_proof = "sdk_material_and_labelled_topology_hard_gate", {key: proof[key] for key in ("hard_gate_passed", "same_geometric_point_set", "geometry_labelled_incidence_graph_isomorphic", "target_minus_candidate_volume", "candidate_minus_target_volume")}
                        break
                if match_index is not None:
                    break

            if match_index is None:
                representative_indices.append(index)
                unique_id = f"part-{len(representative_indices) - 1:03d}"
                representative = index
            else:
                unique_id = instance_rows[match_index]["part_id"]
                representative = match_index
            instance_rows.append({
                "id": instance_id,
                "source_solid_id": source_solid_id,
                "split_step": f"split/{instance_id}.step",
                "split_step_sha256": sha256_file(split_path),
                "part_id": unique_id,
                "representative_index": representative,
                "placement": _placement_from_transform(transform),
                "transform_from_representative": transform,
                "metrics": row_metrics,
                "source_occurrence": occurrences[index],
                "roundtrip_verification": roundtrip,
                "alignment_mode": alignment_mode,
            })
            match_rows.append({
                "instance_id": instance_id,
                "part_id": unique_id,
                "representative_instance": f"instance-{representative:03d}",
                "deduplicated": match_index is not None,
                "method": match_method,
                "alignment_mode": alignment_mode,
                "candidate_checks": candidate_evidence,
                "verification": match_proof,
                "rotation_candidate_status": (
                    "resolved"
                    if row_metrics["principal_axes_resolved"]
                    else row_metrics.get("principal_axes_failure", "ambiguous_or_degenerate_principal_frame")
                ),
                "nonmatch_reason": (
                    None
                    if match_index is not None or match_method != "unique"
                    else row_metrics.get("principal_axes_failure", "no_strict_geometry_match")
                ),
            })

        unique_parts = []
        for part_index, representative in enumerate(representative_indices):
            unique_id = f"part-{part_index:03d}"
            representative_row = instance_rows[representative]
            part_dir = work_dir / "unique" / unique_id
            part_dir.mkdir(parents=True)
            target_step = part_dir / "target.step"
            shutil.copyfile(work_dir / representative_row["split_step"], target_step)
            ir_path = part_dir / "target.ir.jsonl"
            _progress("stepir_v6.3", part_id=unique_id, work_dir=str(work_dir))
            ir_result = _run_stepir(target_step, ir_path, python=python, script=stepir_script)
            (part_dir / "ir_version.txt").write_text(IR_VERSION + "\n", encoding="ascii")
            # This is a byte-copy of the already world-verified split; no geometric
            # normalization or second kernel roundtrip is introduced here.
            if sha256_file(target_step) != representative_row["split_step_sha256"]:
                raise UnsupportedInput("unique_target_copy", "Target differs from verified split", {"part_id": unique_id})
            unique_parts.append({
                "id": unique_id,
                "representative_instance": representative_row["id"],
                "source_solid_id": representative_row["source_solid_id"],
                "target_step": f"unique/{unique_id}/target.step",
                "target_step_sha256": sha256_file(target_step),
                "stepir": f"unique/{unique_id}/target.ir.jsonl",
                "stepir_sha256": ir_result["sha256"],
                "stepir_version": IR_VERSION,
                "source_world_roundtrip_verified": True,
                "dedup_method": next(
                    row["method"] for row in match_rows if row["instance_id"] == representative_row["id"]
                ),
                "metrics": representative_row["metrics"],
            })

        split_manifest = {
            "schema_version": "step-multisolid-split-manifest-v1",
            "source": {"step_path": "source/source.step", "sha256": source_hash},
            "hierarchy": hierarchy,
            "solid_count": len(instance_rows),
            "instances": [
                {key: value for key, value in row.items() if key != "representative_index"}
                for row in instance_rows
            ],
        }
        dedup_report = {
            "schema_version": "step-multisolid-dedup-report-v1",
            "input_solid_count": len(instance_rows),
            "unique_part_count": len(unique_parts),
            "deduplicated_count": len(instance_rows) - len(unique_parts),
            "policy": {
                "kind": "conservative_verified_rigid_candidates",
                "match": "SDK material point-set and geometry-labelled topology hard gate after a verified representative-to-instance proper rigid transform",
                "rotation_equivalence": "candidate rotations use distinct vertex-covariance principal axes with deterministic third-moment signs; ambiguous frames fall back to translation-only matching",
                "sdk": f"simplecadapi=={SUPPORTED_SDK_VERSION}",
            },
            "matches": match_rows,
        }

        # Source-world geometry is preserved in every unique target. A repeated occurrence gets
        # the rigid transform from its representative in the original source coordinates.
        unresolved = [
            {
                "instances": [row["id"]],
                "reason": "engineering_mate_not_inferred_by_preprocessor",
                "fallback": "source_placement",
            }
            for row in instance_rows
        ]
        bbox_relations, relations_summary = _bbox_relations(instance_rows)
        assembly_ir = {
            "schema_version": SCHEMA_VERSION,
            "units": "mm",
            "coordinate_convention": "representative_source_world_to_instance_source_world",
            "source": {
                "step_path": "source/source.step",
                "sha256": source_hash,
                "solid_occurrences": len(instance_rows),
                "unique_parts": len(unique_parts),
            },
            "hierarchy": hierarchy,
            "unique_parts": unique_parts,
            "instances": [
                {key: value for key, value in row.items() if key not in {"representative_index", "metrics", "centered_geometry_sha256", "split_step", "split_step_sha256"}}
                for row in instance_rows
            ],
            "relations": bbox_relations,
            "relations_summary": relations_summary,
            "suggested_mates": [],
            "unresolved": unresolved,
            "tolerances": {
                "geometric_tolerance_mm": 1e-7,
                "boolean_volume_tolerance_mm3": 1e-9,
                "dedup_acceptance": "SDK hard gate; no metric-only merge",
                "placement_length_mm": 1e-9,
            },
            "provenance": {
                "preprocessor_version": PREPROCESS_VERSION,
                "simplecadapi_version": SUPPORTED_SDK_VERSION,
                "stepir_version": IR_VERSION,
                "source_sha256": source_hash,
                "stepir_script_sha256": sha256_file(stepir_script),
            },
        }

        (work_dir / "preprocess").mkdir()
        (work_dir / "preprocess" / "split-manifest.json").write_text(
            json.dumps(split_manifest, indent=2) + "\n", encoding="utf-8"
        )
        (work_dir / "preprocess" / "dedup-report.json").write_text(
            json.dumps(dedup_report, indent=2) + "\n", encoding="utf-8"
        )
        (work_dir / "assembly.ir.json").write_text(
            json.dumps(assembly_ir, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(work_dir, out_dir)
    _progress("completed", project_dir=str(out_dir))

    return {
        "schema_version": SCHEMA_VERSION,
        "project_dir": str(out_dir),
        "solid_count": len(solids),
        "unique_part_count": len(unique_parts),
        "assembly_ir": "assembly.ir.json",
        "split_manifest": "preprocess/split-manifest.json",
        "dedup_report": "preprocess/dedup-report.json",
        "unique_parts": unique_parts,
    }


def _defaults() -> tuple[Path, Path | None]:
    python = Path(os.environ.get("MULTISOLID_PYTHON", sys.executable))
    configured_stepir = os.environ.get("MULTISOLID_STEPIR_SCRIPT")
    return python, Path(configured_stepir) if configured_stepir else None


def _supervise_prepare(argv: list[str], args: argparse.Namespace) -> int:
    """A native kernel crash must become a diagnosed unsupported input, never a silent loss."""
    output = args.out.absolute()
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    progress = output.parent / (output.name + ".progress.json")
    env = dict(os.environ, MULTISOLID_PREPARE_WORKER="1", MULTISOLID_PROGRESS_FILE=str(progress))
    child = subprocess.Popen([sys.executable, str(Path(__file__).absolute()), *argv], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    timed_out, interrupted = False, None
    previous_handlers = {}

    def interrupt(signum: int, _frame: Any) -> None:
        nonlocal interrupted
        interrupted = signum
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, interrupt)
    try:
        stdout, stderr = child.communicate(timeout=args.timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGKILL)
        stdout, stderr = child.communicate()
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    if child.returncode == 0:
        sys.stdout.write(stdout)
        return 0
    last_stage = json.loads(progress.read_text()) if progress.is_file() else {"stage": "startup"}
    try:
        report = json.loads(stderr)
    except (ValueError, TypeError):
        report = {
            "status": "unsupported_input", "stage": last_stage["stage"],
            "reason": "worker_interrupted" if interrupted else "worker_deadline_exceeded" if timed_out else "native_worker_crash" if child.returncode < 0 else "worker_error",
            "error": f"Worker interrupted by signal {interrupted}" if interrupted else f"Worker exceeded {args.timeout}s" if timed_out else f"Worker exited with code {child.returncode}",
            "stderr_tail": stderr[-2000:],
        }
    report.setdefault("status", "unsupported_input")
    report.setdefault("stage", last_stage["stage"])
    report.update(source_sha256=sha256_file(args.step), worker_returncode=child.returncode, last_progress=last_stage)
    report_path = output.parent / (output.name + ".unsupported.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    report["diagnostic_report"] = str(report_path)
    sys.stderr.write(json.dumps(report) + "\n")
    return 2


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    default_python, default_stepir = _defaults()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    inspect_parser = sub.add_parser("inspect", help="inspect solid count and source geometry")
    inspect_parser.add_argument("step", type=Path)
    prepare_parser = sub.add_parser("prepare", help="split solids, conservatively deduplicate, and write v6.3 IR")
    prepare_parser.add_argument("step", type=Path)
    prepare_parser.add_argument("--out", type=Path, required=True)
    prepare_parser.add_argument("--python", type=Path, default=default_python,
                                help="v6.3 subprocess interpreter (default: MULTISOLID_PYTHON or this interpreter)")
    prepare_parser.add_argument("--stepir-script", type=Path, default=default_stepir,
                                help="frozen v6.3 bundled script (default: MULTISOLID_STEPIR_SCRIPT)")
    prepare_parser.add_argument("--timeout", type=int, default=900, help="whole-project native worker deadline in seconds")
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            result = inspect_step(args.step)
        else:
            if args.stepir_script is None:
                raise ValueError("Set --stepir-script or MULTISOLID_STEPIR_SCRIPT to the frozen STEPIR v6.3 bundled script")
            if args.timeout < 1:
                raise ValueError("--timeout must be positive")
            if os.environ.get("MULTISOLID_PREPARE_WORKER") != "1":
                return _supervise_prepare(argv, args)
            result = prepare_project(
                args.step,
                args.out,
                python=args.python.absolute(),
                stepir_script=args.stepir_script.resolve(),
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except UnsupportedInput as exc:
        print(json.dumps({"status": "unsupported_input", "stage": exc.stage, "error": str(exc), "evidence": exc.evidence}), file=sys.stderr)
        return 2
    except Exception as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
