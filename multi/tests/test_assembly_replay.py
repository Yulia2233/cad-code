from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("replay_isolation", HERE / "replay_isolation.py")
isolation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isolation)

HEADER = '''# /// script
# requires-python = ">=3.10"
# dependencies = ["simplecadapi"]
# [tool.simplecadapi]
# id = "{id}"
# revision = "1.0.0"
# ///
import marimo
app = marimo.App()
with app.setup:
    import simplecadapi as scad
'''
PART = HEADER.format(id="model") + '''
@app.cell
def _():
    # ---- feature: box (build) ----
    box = scad.make_box_rsolid(2.0, 3.0, 4.0)
    return (box,)
@app.cell
def _(box):
    model = scad.Part(part_id=scad.notebook_id(), body=box)
    return (model,)
if __name__ == "__main__":
    app.run()
'''
PRODUCT = HEADER.format(id="product") + '''
@app.cell
def _():
    child = scad.use("parts/part-000/model.py", id="part-000")
    return (child,)
@app.cell
def _(child):
    _assembly = scad.make_assembly_rassembly(assembly_id="product")
    _assembly = scad.add_component_rassembly(_assembly, child, "instance-000", scad.identity_placement_rplacement())
    product = scad.add_component_rassembly(_assembly, child, "instance-001", scad.make_placement_rplacement((10., 0., 0.)))
    return (product,)
if __name__ == "__main__":
    app.run()
'''


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="assembly-eval-test-")
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)

    def fixture(self):
        import simplecadapi as scad
        import simplecadapi._cpp as native
        source = self.root / "delivery"
        (source / "parts/part-000").mkdir(parents=True)
        (source / "product.py").write_text(PRODUCT)
        (source / "parts/part-000/model.py").write_text(PART)
        target = self.root / "target.step"
        native.export_step([scad.make_box_rsolid(2., 3., 4.)], target)
        identity = {"origin": [0., 0., 0.], "x_axis": [1., 0., 0.], "y_axis": [0., 1., 0.]}
        ir = {"schema_version": "step-assembly-ir-v1", "units": "mm", "unique_parts": [{"id": "part-000", "target_step": "target.step", "target_step_sha256": digest(target), "stepir_version": "v6.3"}], "instances": [{"id": "instance-000", "part_id": "part-000", "placement": identity}, {"id": "instance-001", "part_id": "part-000", "placement": {**identity, "origin": [10., 0., 0.]}}]}
        (self.root / "assembly.ir.json").write_text(json.dumps(ir))
        self.write_inputs(source)
        return source

    def write_inputs(self, source):
        manifest = {"schema_version": "cad-code-assembly-inputs-v1", "assembly_ir_sha256": digest(self.root / "assembly.ir.json"), "parts": [{"part_id": "part-000", "stepir_version": "v6.3", "stepeval_verdict": {"ok": True}}], "files": [], "replay_files": [{"path": file.relative_to(source).as_posix(), "sha256": digest(file)} for file in source.rglob("*.py")]}
        (self.root / "assembly-inputs.json").write_text(json.dumps(manifest))
        return manifest

    def evaluate(self, source, name):
        out = self.root / name
        command = [sys.executable, "-I", str(HERE / "assemblyeval.py"), "--assembly-ir", str(self.root / "assembly.ir.json"), "--inputs", str(self.root / "assembly-inputs.json"), "--notebook", str(source / "product.py"), "--out", str(out), "--timeout", "60"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=90)
        self.assertTrue((out / "verdict.json").is_file(), result.stderr)
        return result, json.loads((out / "verdict.json").read_text())

    def test_repeated_part_replays_and_each_occurrence_is_scored(self):
        source = self.fixture()
        result, verdict = self.evaluate(source, "good")
        self.assertEqual(result.returncode, 0, json.dumps(verdict, indent=2))
        self.assertTrue(verdict["ok"])
        self.assertEqual(verdict["counts"], {"expected": 2, "actual": 2, "step_solids": 2})
        self.assertEqual(len(verdict["component_checks"]), 2)
        self.assertEqual(verdict["mate_status"], "source_placement")
        self.assertTrue(all(row["placement_pass"] and row["geometry"]["ok"] for row in verdict["component_checks"]))

    def test_missing_occurrence_fails_even_with_correct_remaining_part(self):
        source = self.fixture()
        (source / "product.py").write_text(PRODUCT.replace('product = scad.add_component_rassembly(_assembly, child, "instance-001", scad.make_placement_rplacement((10., 0., 0.)))', 'product = _assembly'))
        self.write_inputs(source)
        _, verdict = self.evaluate(source, "missing")
        self.assertFalse(verdict["ok"])
        self.assertFalse(verdict["coverage_pass"])
        self.assertEqual(verdict["missing_instances"], ["instance-001"])

    def test_misplaced_occurrence_fails_despite_identical_local_geometry(self):
        source = self.fixture()
        (source / "product.py").write_text(PRODUCT.replace('(10., 0., 0.)', '(11., 0., 0.)'))
        self.write_inputs(source)
        _, verdict = self.evaluate(source, "misplaced")
        self.assertFalse(verdict["ok"])
        self.assertTrue(verdict["coverage_pass"])
        failed = next(row for row in verdict["component_checks"] if row["instance_id"] == "instance-001")
        self.assertEqual(failed["translation_error_mm"], 1.0)
        self.assertTrue(failed["geometry"]["ok"])
        self.assertFalse(failed["placement_pass"])

    def test_wrong_part_definition_mapping_fails(self):
        source = self.fixture()
        (source / "product.py").write_text(PRODUCT.replace('id="part-000"', 'id="wrong-part"'))
        self.write_inputs(source)
        _, verdict = self.evaluate(source, "wrong-part")
        self.assertFalse(verdict["ok"])
        self.assertTrue(verdict["coverage_pass"])
        self.assertTrue(all(not row["part_mapping_pass"] for row in verdict["component_checks"]))

    def test_absolute_notebook_dependency_is_rejected_before_replay(self):
        source = self.fixture()
        (source / "product.py").write_text(PRODUCT.replace('"parts/part-000/model.py"', repr(str(source / "parts/part-000/model.py"))))
        manifest = self.write_inputs(source)
        with self.assertRaisesRegex(ValueError, "outside source closure"):
            isolation.closure_files(source, manifest, source / "product.py")

    def test_hash_unregistered_and_symlink_sources_are_rejected(self):
        source = self.fixture()
        manifest = self.write_inputs(source)
        (source / "other.py").write_text("x = 1\n")
        with self.assertRaisesRegex(ValueError, "Unregistered"):
            isolation.closure_files(source, manifest, source / "product.py")
        (source / "other.py").unlink()
        (source / "product.py").write_text(PRODUCT + "\n# changed\n")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            isolation.closure_files(source, manifest, source / "product.py")
        (source / "product.py").unlink()
        (source / "product.py").symlink_to(self.root / "target.step")
        with self.assertRaisesRegex(ValueError, "symlink"):
            isolation.closure_files(source, manifest, source / "product.py")

    def test_sandbox_denies_target_and_network_but_reads_registered_sibling(self):
        source = self.fixture()
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        helper = '''from pathlib import Path
import socket
def check():
    assert Path(__file__).read_text()
    for path in PATHS:
        try:
            Path(path).read_bytes()
        except (OSError, PermissionError):
            pass
        else:
            raise RuntimeError("External target readable")
    try:
        socket.create_connection(("127.0.0.1", PORT), timeout=1)
    except OSError:
        pass
    else:
        raise RuntimeError("Network available")
    try:
        Path(__file__).write_text("mutated")
    except OSError:
        pass
    else:
        raise RuntimeError("Source tree writable")
    return True
'''.replace("PATHS", repr([str(self.root / "target.step"), str(source / "target.step"), str(self.root / "assembly.ir.json")])).replace("PORT", str(port))
        (source / "probe.py").write_text(helper)
        (source / "target.step").write_text("DENY_SIBLING_TARGET")
        (source / "product.py").write_text(PRODUCT.replace('import simplecadapi as scad', 'import simplecadapi as scad\n    from probe import check').replace('child = scad.use(', 'assert check()\n    child = scad.use('))
        self.write_inputs(source)
        result, verdict = self.evaluate(source, "isolation")
        self.assertEqual(result.returncode, 0, json.dumps(verdict, indent=2))
        self.assertEqual(verdict["isolation"]["network"], "denied")
        self.assertTrue(verdict["ok"])

    def test_linux_requires_bwrap_and_uses_no_host_root_bind(self):
        source, scratch = self.root / "src", self.root / "scratch"
        source.mkdir(); scratch.mkdir()
        (scratch / "cache").mkdir(); (scratch / "output").mkdir(); (scratch / "tmp").mkdir(); (scratch / "home").mkdir()
        wrapper_dir = self.root / "runtime"; wrapper_dir.mkdir()
        wrapper = wrapper_dir / "python"; wrapper.write_text("#!/bin/sh\nexit 0\n"); wrapper.chmod(0o700)
        fake = self.root / "bwrap"; fake.write_text("#!/bin/sh\nexit 0\n"); fake.chmod(0o700)
        command, env = isolation.sandbox_command(Path(sys.executable), HERE / "replay_assembly.py", source, scratch, "product.py", [Path(sys.prefix)], platform="linux", bwrap=fake, site_packages=[], python_wrapper=wrapper)
        self.assertIn("--unshare-all", command)
        self.assertIn("--clearenv", command)
        self.assertNotIn("/", command)
        self.assertNotIn("HTTP_PROXY", env)
        self.assertIn("--ro-bind", command)
        self.assertIn("/cad-code", command)
        self.assertIn("/cad-code/source", command)
        self.assertIn("/cad-code/scratch", command)
        self.assertIn("/cad-code/trusted", command)
        self.assertIn("/cad-code/runtime", command)
        self.assertEqual(env["CAD_CODE_ASSEMBLY_PYTHON_WRAPPER"], "/cad-code/runtime/python")
        self.assertNotIn(str(source), command[command.index("--chdir"):])
        self.assertNotIn(str(scratch), command[command.index("--chdir"):])


if __name__ == "__main__":
    unittest.main()
