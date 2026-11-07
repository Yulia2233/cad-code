"""Trusted strict boolean material IoU. Never import generated Python here."""
import argparse
import hashlib
import json
import math
import time
import traceback
from pathlib import Path

from simplecadapi.inspect import brep


def inspect(path):
    value = brep.inspect_step_rsummary(path=str(path))
    return {k: value[k] for k in ("valid", "material_body_count", "volume",
                                  "volume_is_solid_material", "face_count", "bounding_box")}


def solid(value):
    return bool(value["valid"] and value["material_body_count"] > 0
                and value["volume_is_solid_material"] and math.isfinite(value["volume"]) and value["volume"] > 0)


def compare(target, current):
    target_summary = inspect(target)
    if not solid(target_summary):
        raise ValueError("invalid reference STEP material")
    candidate = inspect(current)
    report = {"target": target_summary, "candidate": candidate, "candidate_valid": solid(candidate),
              "iou": 0.0, "method": None, "comparison_succeeded": False}
    if not report["candidate_valid"]:
        report["status"] = "invalid_candidate"
        return report
    material = brep.compare_material_rdescriptor(target=str(target), current=str(current),
                                                  boolean_tolerance=None, include_components=True)
    report["material_comparison"] = material
    if not material["boolean_result_valid"] or not material["volume_balance"]["valid"]:
        raise ValueError("boolean cut results are invalid or violate volume conservation")
    tv, cv = target_summary["volume"], candidate["volume"]
    missing, excess = material["missing_material"]["volume"], material["excess_material"]["volume"]
    intersection_a, intersection_b = tv - missing, cv - excess
    tolerance = max(tv, cv) * 1e-8 + 1e-12
    if abs(intersection_a - intersection_b) > tolerance:
        raise ValueError("the two directional cuts disagree about intersection volume")
    intersection = (intersection_a + intersection_b) / 2
    if intersection < -tolerance or intersection > min(tv, cv) + tolerance:
        raise ValueError("intersection volume lies outside material bounds")
    intersection = max(0.0, min(min(tv, cv), intersection))
    union = tv + cv - intersection
    iou = intersection / union
    if not math.isfinite(iou) or not 0 <= iou <= 1 + 1e-8:
        raise ValueError("nonfinite or out-of-range IoU")
    report.update(status="ok", iou=min(iou, 1.0), comparison_succeeded=True,
                  method="strict_bidirectional_boolean_cut", intersection_volume=intersection,
                  union_volume=union, target_volume=tv, candidate_volume=cv)
    return report


def self_test(output):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
    from OCP.IFSelect import IFSelect_RetDone
    paths = []
    for index, x in enumerate((0.0, 5.0, 30.0)):
        shape = BRepPrimAPI_MakeBox(gp_Pnt(x, 0, 0), 10.0, 10.0, 10.0).Shape()
        writer = STEPControl_Writer()
        writer.Transfer(shape, STEPControl_AsIs)
        path = output / f"control-{index}.step"
        assert writer.Write(str(path)) == IFSelect_RetDone
        paths.append(path)
    records = []
    for path, expected in zip(paths, (1.0, 1 / 3, 0.0)):
        result = compare(paths[0], path)
        assert math.isclose(result["iou"], expected, abs_tol=1e-9), result
        records.append({"expected_iou": expected, "measured_iou": result["iou"],
                        "comparison_succeeded": result["comparison_succeeded"], "method": result["method"]})
    return {"status": "passed", "controls": records}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("compare", "audit-targets", "self-test"), default="compare")
    args = parser.parse_args()
    output = Path("/output")
    started = time.monotonic()
    try:
        if args.mode == "self-test":
            result = self_test(output)
        elif args.mode == "audit-targets":
            rows = []
            for path in sorted(Path("/targets").glob("*.step")):
                summary = inspect(path)
                rows.append({"key": path.stem, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                             "eligible_solid_target": solid(summary), **summary})
            assert len(rows) == 750
            result = {"status": "passed" if all(r["eligible_solid_target"] for r in rows) else "invalid_targets",
                      "cases": len(rows), "valid_solid_targets": sum(r["eligible_solid_target"] for r in rows),
                      "targets": rows}
        else:
            result = compare("/input/target.step", "/input/candidate.step")
    except BaseException as error:
        traceback.print_exc()
        result = {"status": "comparison_error", "iou": 0.0, "comparison_succeeded": False,
                  "error_type": type(error).__name__, "error": str(error)[:1500]}
        if args.mode == "compare":
            try:
                candidate = inspect("/input/candidate.step")
                result.update(candidate=candidate, candidate_valid=solid(candidate))
            except Exception:
                result["candidate_valid"] = False
    result["seconds"] = time.monotonic() - started
    (output / "comparison.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k not in ("targets", "material_comparison")}, allow_nan=False))
    raise SystemExit(1 if result["status"] in ("comparison_error", "invalid_targets") else 0)


if __name__ == "__main__":
    main()
