#!/usr/bin/env python3
"""Build a source assembly and report observations; acceptance runs separately."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path


def deliver(notebook, index_file, output):
    import simplecadapi as scad
    from simplecadapi import exporter
    from simplecadapi.runtime import run_notebook

    if importlib.metadata.version("simplecadapi") != "2.2.7":
        raise ValueError("Assembly delivery requires SimpleCADAPI 2.2.7")
    notebook, index_file, output = Path(notebook), Path(index_file), Path(output)
    index = json.loads(index_file.read_text())
    if index.get("schema_version") != "cad-code-assembly-context-index-v1":
        raise ValueError("Expected the controller assembly context index")
    output.mkdir(parents=True, exist_ok=True)
    run = run_notebook(path=notebook, cache=False, timeout=120)
    if not isinstance(run.product, scad.Assembly):
        raise TypeError("Assembly notebook must return a SimpleCADAPI Assembly")
    constraints = scad.inspect_assembly_constraints_rconstraintreport(assembly=run.product).to_dict()
    if not constraints.get("solved"):
        raise ValueError("Assembly constraints are not solved")
    occurrences = [{"instance_id": c.component_id, "part_id": c.item.part_id,
                    "placement": c.placement.to_dict()} for c in run.product.components]
    if len(occurrences) != index["counts"]["occurrences"]:
        raise ValueError("Built occurrence count differs from the controller index")
    package, step = output / "product.scadpkg", output / "product.step"
    scad.capture(run.definition, package, include_scene=False)
    exporter.export_product_package_to_step(data=package, output_path=step)
    report = {
        "schema_version": "cad-code-assembly-delivery-v1",
        "author": "CAD Code delivery helper; observed build results only",
        "sdk_version": "2.2.7", "project_id": index["project_id"],
        "assembly_ir_sha256": index["assembly_ir_sha256"],
        "notebook_sha256": hashlib.sha256(notebook.read_bytes()).hexdigest(),
        "build_status": "completed", "occurrences": occurrences,
        "constraint_count": len(run.product.constraints), "constraints": constraints,
        "candidate_relations_exposed": index["counts"]["candidate_relations_exposed"],
        "candidate_relations_omitted": index["counts"]["candidate_relations_omitted"],
        "engineering_intent": "Not inferred by the delivery helper; default fixed edges are static assumptions.",
        "independent_acceptance": "pending_controller_evaluation",
        "artifacts": {p.name: {"bytes": p.stat().st_size,
                               "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                      for p in (package, step)},
    }
    (output / "assembly-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return {"build_status": "completed", "occurrences": len(occurrences),
            "constraint_count": report["constraint_count"], "constraints": constraints,
            "independent_acceptance": report["independent_acceptance"],
            "artifacts": list(report["artifacts"]), "report": str(output / "assembly-report.json")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--notebook", type=Path, required=True)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(deliver(args.notebook, args.index, args.out)))
