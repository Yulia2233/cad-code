#!/usr/bin/env python3
"""Independently replay and score a delivered SimpleCADAPI assembly source tree."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time

HERE = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


isolation = module("assembly_replay_isolation", HERE / "replay_isolation.py")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def local_file(root, value):
    if not isinstance(value, str) or not value or Path(value).is_absolute() or ".." in Path(value).parts:
        raise ValueError("Expected project-relative file path")
    return isolation.regular_file(Path(root) / value)


def placement_matrix(value):
    import numpy as np
    axes = [np.asarray(value[key], dtype=float) for key in ("x_axis", "y_axis")]
    origin = np.asarray(value["origin"], dtype=float)
    if any(x.shape != (3,) for x in axes + [origin]):
        raise ValueError("Placement vectors must have three coordinates")
    matrix = np.eye(4)
    matrix[:3, :3] = np.column_stack([*axes, np.cross(*axes)])
    matrix[:3, 3] = origin
    rotation = matrix[:3, :3]
    if not np.isfinite(matrix).all() or not np.allclose(rotation.T @ rotation, np.eye(3), rtol=0, atol=1e-6) or np.linalg.det(rotation) <= 0:
        raise ValueError("Placement must be a finite, orthonormal, right-handed rigid transform")
    return matrix


def validate_inputs(ir_path, inputs_path, notebook):
    ir = json.loads(isolation.regular_file(ir_path).read_text())
    inputs = json.loads(isolation.regular_file(inputs_path).read_text())
    if ir.get("schema_version") != "step-assembly-ir-v1" or ir.get("units") != "mm":
        raise ValueError("Expected step-assembly-ir-v1 in mm")
    if inputs.get("schema_version") != "cad-code-assembly-inputs-v1":
        raise ValueError("Expected cad-code-assembly-inputs-v1")
    if inputs.get("assembly_ir_sha256") != sha(ir_path):
        raise ValueError("Assembly IR hash mismatch")
    for row in inputs.get("files", []):
        file = local_file(inputs_path.parent, row["path"])
        if sha(file) != row.get("sha256"):
            raise ValueError(f"Input snapshot hash mismatch: {row['path']}")
    parts = {part["id"]: part for part in ir["unique_parts"]}
    if len(parts) != len(ir["unique_parts"]) or not parts:
        raise ValueError("Empty or duplicate unique part IDs")
    selected = {part["part_id"]: part for part in inputs["parts"]}
    if set(selected) != set(parts) or len(selected) != len(inputs["parts"]):
        raise ValueError("Assembly inputs must contain exactly the IR's unique part IDs")
    for part_id, part in parts.items():
        if part.get("stepir_version") != "v6.3" or selected[part_id].get("stepir_version") != "v6.3":
            raise ValueError("Every child must use STEPIR v6.3")
        target = local_file(ir_path.parent, part["target_step"])
        expected_hash = part.get("target_step_sha256") or part.get("target_sha256") or part.get("step_sha256")
        if expected_hash != sha(target):
            raise ValueError(f"Target STEP hash mismatch: {part_id}")
    ids = [instance["id"] for instance in ir["instances"]]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("Empty or duplicate occurrence IDs")
    for instance in ir["instances"]:
        if instance["part_id"] not in parts:
            raise ValueError("Unknown part reference in assembly IR")
        placement_matrix(instance["placement"])
    files, relative = isolation.closure_files(notebook.parent, inputs, notebook)
    return ir, inputs, files, relative


def materialized_inventory(package_path, out):
    """Read the freshly captured package in this trusted process, not runner claims."""
    import simplecadapi as scad
    import simplecadapi._cpp as native
    from simplecadapi.artifacts import materialize_definition
    from simplecadapi.translator.package_units import read_product_package_translation_units
    package, units = read_product_package_translation_units(package_path)
    product = materialize_definition(package.root_definition)
    if not isinstance(product, scad.Assembly):
        raise TypeError("Captured product is not an Assembly")
    rows, reports = [], []
    directory = out / "components"
    directory.mkdir()
    def walk(assembly, pose, prefix):
        report = scad.inspect_assembly_constraints_rconstraintreport(assembly).to_dict()
        reports.append({"path": prefix, "constraint_count": len(assembly.constraints), **report})
        for component in assembly.components:
            world = pose.compose(component.placement)
            component_path = prefix + [component.component_id]
            if isinstance(component.item, scad.Assembly):
                walk(component.item, world, component_path)
            elif isinstance(component.item, scad.Part):
                file = directory / f"{len(rows):05d}.step"
                native.export_step([component.item.body], file)
                rows.append({"instance_id": component.component_id, "component_path": component_path, "part_id": component.item.part_id, "placement": world.to_dict(), "local_step": str(file)})
            else:
                raise TypeError("Captured assembly contains unsupported component")
    walk(product, scad.Placement((0., 0., 0.)), [])
    return {"instances": rows, "constraint_reports": reports, "definitions": [{"id": unit.definition_id, "kind": unit.definition_kind, "content_hash": unit.content_hash} for unit in units]}


def compare_component(target, candidate, scorer):
    from simplecadapi.inspect import brep
    target_info = brep.inspect_step_rsummary(path=str(target))
    candidate_info = brep.inspect_step_rsummary(path=str(candidate))
    if target_info["body_count"] != 1 or candidate_info["body_count"] != 1:
        return {"ok": False, "error": "Component target and candidate must each contain one solid"}
    strict_error = None
    try:
        strict = brep.compare_steps_rbrepcomparison(target, candidate)
        if strict.hard_gate_passed:
            return {"ok": True, "method": "sdk_strict_point_set_and_topology", "strict_equal": True, "complete": True, "riou": None}
    except Exception as error:
        strict_error = str(error)[:600]
    result = scorer.compare(target, candidate)
    faces = result.get("faces") or {}
    complete = False
    if faces:
        target_types, candidate_types = faces.get("types_target") or {}, faces.get("types_candidate") or {}
        complete = scorer.counts_match(faces["target"], faces["candidate"], target_types, candidate_types)
        relief = faces.get("relief_target")
        if not complete and relief:
            reduced = {key: value - relief["types"].get(key, 0) for key, value in target_types.items()}
            complete = scorer.counts_match(faces["target"] - relief["faces"], faces["candidate"], {key: value for key, value in reduced.items() if value > 0}, candidate_types)
            result["relief_omitted"] = complete
    return {**result, "ok": result.get("riou", 0) >= scorer.RIOU_PASS and complete, "complete": complete, "method": "frozen_stepeval_geometry", "strict_equal": False, "strict_error": strict_error}


def evaluate(ir, inputs, out):
    import numpy as np
    from simplecadapi import exporter
    from simplecadapi.inspect import brep
    inventory = materialized_inventory(out / "product.scadpkg", out)
    # Regenerate delivery STEP from the package in this clean trusted process.
    # The notebook cannot replace the exporter or forge inventory here.
    exporter.export_product_package_to_step(out / "product.scadpkg", out / "product.step")
    (out / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    expected = {row["id"]: row for row in ir["instances"]}
    counts = Counter(row["instance_id"] for row in inventory["instances"])
    missing = sorted(set(expected) - set(counts))
    extra = sorted(set(counts) - set(expected))
    duplicates = sorted(key for key, count in counts.items() if count != 1)
    step_count = brep.inspect_step_rsummary(path=str(out / "product.step"))["body_count"]
    coverage = not missing and not extra and not duplicates and len(expected) == len(inventory["instances"]) == step_count
    scorer = module("frozen_single_solid_stepeval", HERE.parent / "skills/simplecadapi/scripts/stepeval.py")
    parts = {part["id"]: part for part in ir["unique_parts"]}
    checks, cache = [], {}
    for actual in inventory["instances"]:
        item = {"instance_id": actual["instance_id"], "actual_part_id": actual["part_id"], "component_path": actual["component_path"], "ok": False}
        target = expected.get(actual["instance_id"])
        if not target:
            item["error"] = "Unexpected instance"
            checks.append(item)
            continue
        item["expected_part_id"] = target["part_id"]
        item["part_mapping_pass"] = target["part_id"] == actual["part_id"]
        desired, realized = placement_matrix(target["placement"]), placement_matrix(actual["placement"])
        item["translation_error_mm"] = float(np.max(np.abs(desired[:3, 3] - realized[:3, 3])))
        item["axis_error"] = float(np.max(np.abs(desired[:3, :3] - realized[:3, :3])))
        item["placement_pass"] = item["translation_error_mm"] <= 1e-6 and item["axis_error"] <= 1e-7
        path = local_file(Path(ir["_directory"]), parts[target["part_id"]]["target_step"])
        try:
            key = (target["part_id"], sha(actual["local_step"]))
            if key not in cache:
                cache[key] = compare_component(path, Path(actual["local_step"]), scorer)
            item["geometry"] = cache[key]
            item["ok"] = item["part_mapping_pass"] and item["placement_pass"] and item["geometry"]["ok"]
        except Exception as error:
            item["error"] = f"{type(error).__name__}: {error}"
        checks.append(item)
    reports = inventory["constraint_reports"]
    constraint_count = sum(report["constraint_count"] for report in reports)
    mate_status = "source_placement" if not constraint_count else "solved" if all(report.get("solved") for report in reports) else "unsolved"
    geometry_pass = coverage and all(row["ok"] for row in checks)
    return {"ok": geometry_pass and mate_status != "unsolved", "geometry_pass": geometry_pass, "coverage_pass": coverage, "counts": {"expected": len(expected), "actual": len(inventory["instances"]), "step_solids": step_count}, "missing_instances": missing, "extra_instances": extra, "duplicate_instance_ids": duplicates, "component_checks": checks, "mate_status": mate_status, "constraint_reports": reports, "source_placement_fallback_count": len(expected) if not constraint_count else None, "child_verdicts": [{"part_id": part["part_id"], "verdict": part.get("stepeval_verdict")} for part in inputs["parts"]], "limitations": ["Engineering intent is a hypothesis; geometry and actual constraint residuals are checked separately.", "Nested leaves must retain globally unique source occurrence IDs.", "Fallback count for mixed constrained/static assemblies requires the agent report and is not inferred."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assembly-ir", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--notebook", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--python")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()
    if args.python and Path(args.python).absolute() != Path(sys.executable).absolute():
        os.execv(args.python, [args.python, "-I", str(Path(__file__).resolve()), *sys.argv[1:]])
    out = args.out.absolute()
    if out.exists() and (out.is_symlink() or any(out.iterdir())):
        raise ValueError("Evaluator output must be a new or empty directory")
    out.mkdir(parents=True, exist_ok=True)
    if out.resolve() != out:
        raise ValueError("Output directory must not contain symlinks")
    report = {"schema_version": "assembly-verdict-v1", "ok": False, "geometry_pass": False, "replay_status": "not_started", "mate_status": "not_evaluated", "started_at": time.time()}
    try:
        if importlib.metadata.version("simplecadapi") != "2.2.7":
            raise ValueError("SimpleCADAPI 2.2.7 is required")
        notebook, inputs_path, ir_path = args.notebook.absolute(), args.inputs.absolute(), args.assembly_ir.absolute()
        ir, inputs, files, relative = validate_inputs(ir_path, inputs_path, notebook)
        report["source_hashes"] = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
        report["assembly_ir_sha256"] = sha(ir_path)
        report["inputs_sha256"] = sha(inputs_path)
        report["notebook_sha256"] = sha(notebook)
        report["source_step_sha256"] = ir.get("source", {}).get("sha256")
        report["sdk_version"] = "2.2.7"
        report["replay_status"] = "running"
        report["isolation"] = isolation.isolated_replay(files, relative, out, sys.executable, args.timeout)
        report["replay_status"] = "completed"
        ir["_directory"] = str(ir_path.parent)
        report.update(evaluate(ir, inputs, out))
        report["artifacts"] = {name: {"path": str(out / name), "sha256": sha(out / name)} for name in ("product.py", "product.step", "product.scadpkg", "inventory.json") if (out / name).is_file()}
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        if report["replay_status"] == "running":
            report["replay_status"] = "failed"
    report["finished_at"] = time.time()
    (out / "verdict.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(report, allow_nan=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
