#!/usr/bin/env python3
"""Trusted runner. Run only through replay_isolation.py."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys


def inventory(product):
    import simplecadapi as scad
    rows, reports = [], []
    def walk(assembly, placement, prefix):
        report = scad.inspect_assembly_constraints_rconstraintreport(assembly).to_dict()
        reports.append({"path": prefix, "constraint_count": len(assembly.constraints), **report})
        for component in assembly.components:
            world = placement.compose(component.placement)
            path = prefix + [component.component_id]
            if isinstance(component.item, scad.Assembly):
                walk(component.item, world, path)
            elif isinstance(component.item, scad.Part):
                rows.append({"instance_id": component.component_id, "component_path": path, "part_id": component.item.part_id, "placement": world.to_dict()})
            else:
                raise TypeError("Assembly contains an unsupported component")
    walk(product, scad.Placement((0., 0., 0.)), [])
    return {"schema_version": "assembly-replay-inventory-v1", "instances": rows, "constraint_reports": reports}


def main():
    if os.environ.get("CAD_CODE_ASSEMBLY_ISOLATED") != "1":
        raise RuntimeError("Use the isolated replay controller")
    for item in reversed(os.environ.get("CAD_CODE_ASSEMBLY_PYTHONPATH", "").split(os.pathsep)):
        if item and item not in sys.path:
            sys.path.insert(0, item)
    wrapper=os.environ.get("CAD_CODE_ASSEMBLY_PYTHON_WRAPPER")
    if wrapper:
        sys.executable=wrapper
    from simplecadapi.runtime import runner
    import simplecadapi as scad
    from simplecadapi import exporter
    notebook, output = Path(sys.argv[1]), Path(sys.argv[2])
    # use() calls runner.run_notebook itself. Disable caches for every child,
    # without modifying installed SDK code; runtime state is redirected by -X.
    original = runner.run_notebook
    def fresh(*args, **kwargs):
        kwargs["cache"] = False
        return original(*args, **kwargs)
    runner.run_notebook = fresh
    run = fresh(notebook)
    if not isinstance(run.product, scad.Assembly):
        raise TypeError("Assembly notebook must return a SimpleCADAPI Assembly")
    scad.capture(run.definition, output / "product.scadpkg", include_scene=False)
    exporter.export_product_package_to_step(output / "product.scadpkg", output / "product.step")
    (output / "inventory.json").write_text(json.dumps(inventory(run.product), indent=2) + "\n")


if __name__ == "__main__":
    main()
