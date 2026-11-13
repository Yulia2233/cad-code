from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import simplecadapi as scad

from cli import _bbox_relations, inspect_step, prepare_project
from sdk_adapter import load_solids, metrics, same_geometry, rigid_transform, verify_roundtrip


STEPIR_SCRIPT = Path(os.environ["MULTISOLID_STEPIR_SCRIPT"]) if os.environ.get("MULTISOLID_STEPIR_SCRIPT") else None
PYTHON = Path(os.environ.get("MULTISOLID_PYTHON", sys.executable))


class MultiSolidPreprocessTests(unittest.TestCase):
    def test_bbox_relation_index_is_bounded_for_large_occurrence_sets(self) -> None:
        rows = []
        for index in range(1000):
            x = float(index * 10)
            rows.append({"id": f"instance-{index:04d}", "metrics": {"bbox_mm": {
                "min": [x, 0.0, 0.0], "max": [x + 1.0, 1.0, 1.0]}}})
        relations, summary = _bbox_relations(rows, neighbors_per_instance=4)
        possible = 1000 * 999 // 2
        self.assertEqual(summary["possible_pair_count"], possible)
        self.assertEqual(summary["retained_pair_count"], len(relations))
        self.assertEqual(summary["omitted_pair_count"], possible - len(relations))
        self.assertLessEqual(len(relations), 1000 * 4)
        self.assertTrue(all(row["selection"] == "nearest_neighbors_top_k_per_instance" for row in relations))

    def test_split_translation_dedup_and_v63_ir(self) -> None:
        if STEPIR_SCRIPT is None:
            self.fail("Set MULTISOLID_STEPIR_SCRIPT to the frozen STEPIR v6.3 bundled script")
        with tempfile.TemporaryDirectory(prefix="multisolid-test-") as tmp:
            temp = Path(tmp)
            main = scad.make_box_rsolid(width=10.0, height=8.0, depth=4.0)
            spur = scad.translate_shape(
                scad.make_box_rsolid(width=3.0, height=2.0, depth=4.0),
                (6.0, 2.0, 0.0),
            )
            base = scad.union_rsolid(main, spur)
            repeated = scad.translate_shape(base, (25.0, -3.0, 2.0))
            base_metrics = metrics(base)
            x, y, _ = base_metrics["vertex_mean_mm"]
            rotated = rigid_transform(
                base,
                [
                    [0.0, -1.0, 0.0, x + y],
                    [1.0, 0.0, 0.0, y - x],
                    [0.0, 0.0, 1.0, 0.0],
                    [0.0, 0.0, 0.0, 1.0],
                ],
            )
            different = scad.translate_shape(
                scad.make_box_rsolid(width=3.0, height=4.0, depth=5.0),
                (-12.0, 0.0, 0.0),
            )
            sphere = scad.make_sphere_rsolid(radius=2.0)
            repeated_sphere = scad.translate_shape(sphere, (30.0, 0.0, 0.0))
            source = temp / "source.step"
            scad._cpp._native.export_step([base, repeated, rotated, different, sphere, repeated_sphere], str(source))

            inspected = inspect_step(source)
            self.assertEqual(inspected["solid_count"], 6)

            output = temp / "prepared"
            result = prepare_project(source, output, python=PYTHON, stepir_script=STEPIR_SCRIPT)
            self.assertEqual(result["solid_count"], 6)
            self.assertEqual(result["unique_part_count"], 3)

            assembly = json.loads((output / "assembly.ir.json").read_text())
            self.assertEqual(assembly["source"]["solid_occurrences"], 6)
            self.assertEqual(len(assembly["unique_parts"]), 3)
            self.assertEqual(assembly["instances"][0]["part_id"], assembly["instances"][1]["part_id"])
            self.assertEqual(assembly["instances"][2]["part_id"], assembly["instances"][0]["part_id"])
            self.assertEqual(assembly["instances"][3]["part_id"], "part-001")
            self.assertEqual(assembly["instances"][4]["part_id"], assembly["instances"][5]["part_id"])
            self.assertEqual(assembly["instances"][4]["alignment_mode"], "source_world_identity")
            self.assertEqual(assembly["instances"][5]["alignment_mode"], "translation_only")
            self.assertAlmostEqual(assembly["instances"][1]["placement"]["origin"][0], 25.0, places=6)
            self.assertAlmostEqual(assembly["instances"][1]["placement"]["origin"][1], -3.0, places=6)
            self.assertAlmostEqual(assembly["instances"][1]["placement"]["origin"][2], 2.0, places=6)
            self.assertAlmostEqual(assembly["instances"][5]["placement"]["origin"][0], 30.0, places=6)

            source_shapes = load_solids(source)
            rotated_transform = assembly["instances"][2]["transform_from_representative"]
            rebuilt_rotated = rigid_transform(source_shapes[0], rotated_transform)
            self.assertTrue(same_geometry(rebuilt_rotated, source_shapes[2])[0])
            self.assertTrue(assembly["hierarchy"]["source_preserved"])
            self.assertTrue(assembly["relations"])
            self.assertTrue(all(row["kind"] == "bbox_distance_lower_bound" for row in assembly["relations"]))

            for part in assembly["unique_parts"]:
                target = output / part["target_step"]
                ir = output / part["stepir"]
                self.assertEqual(len(load_solids(target)), 1)
                self.assertEqual((target.parent / "ir_version.txt").read_text().strip(), "v6.3")
                header = json.loads(ir.read_text().splitlines()[0])
                self.assertEqual(header["solids"], 1)
                self.assertGreater(header["vol"], 0)

    def test_world_gate_rejects_displacement_and_mirror(self) -> None:
        base = scad.make_box_rsolid(width=10.0, height=8.0, depth=4.0)
        moved = scad.translate_shape(base, (1.0, 0.0, 0.0))
        self.assertFalse(same_geometry(base, moved)[0])
        with self.assertRaisesRegex(ValueError, "proper rigid"):
            rigid_transform(base, [[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])

    def test_serialization_gate_rejects_moved_missing_and_shifted_cavity(self) -> None:
        body = scad.make_box_rsolid(width=20, height=12, depth=5)
        hole = scad.make_cylinder_rsolid(radius=1, height=7, bottom_face_center=(-3, 1, -1))
        original = scad.cut_rsolid(body, hole)
        moved = scad.translate_shape(original, (0.1, 0, 0))
        missing = scad.cut_rsolid(original, scad.translate_shape(scad.make_box_rsolid(width=2, height=20, depth=10), (9.5, 0, 0)))
        shifted_hole = scad.cut_rsolid(body, scad.translate_shape(hole, (1, 0, 0)))
        for candidate in (moved, missing, shifted_hole):
            self.assertFalse(verify_roundtrip(original, candidate)["accepted"])

    def test_wrong_stepir_bundle_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="multisolid-wrong-stepir-") as tmp:
            temp = Path(tmp)
            source = temp / "source.step"
            scad._cpp._native.export_step(scad.make_box_rsolid(width=1, height=2, depth=3), str(source))
            fake = temp / "stepir.py"
            fake.write_text("# Deliberately not the frozen v6.3 bundle\n")
            with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
                prepare_project(source, temp / "project", python=PYTHON, stepir_script=fake)

    def test_serialization_gate_uses_mesh_and_volume_independently_from_boolean(self) -> None:
        from types import SimpleNamespace
        from unittest.mock import patch

        source = SimpleNamespace(_bounds=lambda: (0, 0, 0, 10, 8, 4), get_volume=lambda: 1000.0, same_topology=lambda other: True)
        exported = SimpleNamespace(_bounds=lambda: (0, 0, 0, 10, 8, 4), get_volume=lambda: 1000.000001, same_topology=lambda other: True)
        with patch(
            "sdk_adapter.robust_mesh_iou", side_effect=[{"riou": 0.9999999995, "resolution": 1e-5}]
        ):
            evidence = verify_roundtrip(source, exported)["serialization_check"]
        self.assertTrue(evidence["material_evidence_passed"])
        self.assertEqual(len(evidence["mesh_refinements"]), 1)

    def test_coincident_occurrences_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory(prefix="multisolid-coincident-") as tmp:
            temp = Path(tmp)
            base = scad.make_box_rsolid(width=4, height=3, depth=2)
            source = temp / "source.step"
            scad._cpp._native.export_step([base, base], str(source))
            inspected = inspect_step(source)
            self.assertEqual(inspected["solid_count"], 2)
            self.assertEqual(len({row["source_occurrence"]["node_id"] for row in inspected["solids"]}), 2)
            self.assertTrue(inspected["hierarchy"]["coincident_leaf_occurrences_preserved"])
            result = prepare_project(source, temp / "project", python=PYTHON, stepir_script=STEPIR_SCRIPT)
            self.assertEqual(result["solid_count"], 2)
            self.assertEqual(result["unique_part_count"], 1)
            ir = json.loads((temp / "project" / "assembly.ir.json").read_text())
            self.assertEqual(len(ir["instances"]), 2)
            self.assertEqual(ir["instances"][0]["placement"], ir["instances"][1]["placement"])


if __name__ == "__main__":
    unittest.main()
