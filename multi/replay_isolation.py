#!/usr/bin/env python3
"""Fresh, target-blind multi-file replay using sandbox-exec or bubblewrap."""
from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import signal
import shlex
import subprocess
import sys
import tempfile


def regular_file(path):
    path = Path(path).absolute()
    if path.resolve(strict=True) != path or not path.is_file():
        raise ValueError(f"Expected a regular file without symlinks: {path}")
    return path


def closure_files(root, manifest, notebook):
    root = Path(root).absolute()
    if root.resolve(strict=True) != root or not root.is_dir():
        raise ValueError("Replay source directory must not contain symlinks")
    rows = manifest.get("replay_files")
    if not isinstance(rows, list) or not rows:
        raise ValueError("Trusted inputs require nonempty replay_files with SHA256 hashes")
    files = {}
    for row in rows:
        value = row.get("path") if isinstance(row, dict) else None
        if not isinstance(value, str) or not value or "\\" in value:
            raise ValueError("Invalid replay file path")
        rel = PurePosixPath(value)
        if rel.is_absolute() or any(p in ("..", ".") or p.startswith(".") for p in rel.parts) or rel.suffix != ".py":
            raise ValueError(f"Replay accepts only relative Python source paths: {value}")
        if str(rel) != value or value in files:
            raise ValueError(f"Duplicate or noncanonical replay path: {value}")
        source = regular_file(root / value)
        data = source.read_bytes()
        if len(data) > 8 * 1024 * 1024:
            raise ValueError("Replay source file exceeds 8 MiB")
        digest = hashlib.sha256(data).hexdigest()
        if row.get("sha256") != digest:
            raise ValueError(f"Replay hash mismatch: {value}")
        tree = ast.parse(data.decode("utf-8"), filename=value)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in {"use", "run_notebook"}:
                if not node.args or not isinstance(node.args[0], ast.Constant) or not isinstance(node.args[0].value, str):
                    raise ValueError(f"Notebook dependencies require literal relative paths: {value}:{node.lineno}")
                dependency = PurePosixPath(node.args[0].value)
                if dependency.is_absolute() or ".." in dependency.parts or "\\" in node.args[0].value:
                    raise ValueError(f"Notebook dependency is outside source closure: {value}:{node.lineno}")
        files[value] = data
    registered = set(files)
    found = set()
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if name not in {"__marimo__", "__pycache__", ".simplecad"}]
        for name in dirs:
            if (Path(directory) / name).is_symlink():
                raise ValueError(f"Symlink directory in source tree: {name}")
        for name in names:
            if name.endswith(".py"):
                source = regular_file(Path(directory) / name)
                found.add(source.relative_to(root).as_posix())
    if found != registered:
        raise ValueError(f"Unregistered Python sources: {sorted(found - registered)}")
    relative = Path(notebook).absolute().relative_to(root).as_posix()
    if relative not in files:
        raise ValueError("Main notebook is not registered in replay_files")
    return files, relative


def runtime_roots(python):
    code = "import json,sys,pathlib;print(json.dumps({'prefix':sys.prefix,'base':sys.base_prefix,'executable':str(pathlib.Path(sys.executable).resolve()),'paths':[p for p in sys.path if p and pathlib.Path(p).is_dir()]}))"
    result = subprocess.run([str(python), "-I", "-c", code], check=True, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30)
    info = json.loads(result.stdout)
    roots = {Path(info["prefix"]).resolve(), Path(info["base"]).resolve(), Path(info["executable"]).parent}
    path_entries = [Path(p).resolve() for p in info["paths"]]
    roots.update(path_entries)
    if any(p in {Path("/"), Path.home(), Path("/Users"), Path("/train"), Path("/data")} for p in roots):
        raise ValueError("Unsafe Python runtime root")
    return sorted(roots, key=str), [p for p in path_entries if p.name == "site-packages"]


def sandbox_command(python, runner, source, scratch, notebook, roots, platform=None, bwrap=None, site_packages=None, python_wrapper=None):
    platform = platform or sys.platform
    if site_packages is None:
        _, site_packages = runtime_roots(python)
    if platform == "darwin":
        bootstrap=("import runpy,sys;sys.path[:0]="+repr([str(path) for path in site_packages])+";sys.argv[0]="+repr(str(runner))+";runpy.run_path("+repr(str(runner))+",run_name='__main__')")
        executable = [str(python), "-I", "-B", "-X", f"pycache_prefix={scratch / 'cache'}", "-c", bootstrap, str(source / notebook), str(scratch / 'output')]
        env = {
            "PATH": str(Path(python).parent) + ":/usr/bin:/bin", "HOME": str(scratch / "home"),
            "TMPDIR": str(scratch / "tmp"), "XDG_CACHE_HOME": str(scratch / "cache"),
            "XDG_CONFIG_HOME": str(scratch / "home/config"), "XDG_DATA_HOME": str(scratch / "home/data"),
            "MPLCONFIGDIR": str(scratch / "cache/mpl"), "LANG": "en_US.UTF-8",
            "SIMPLECAD_VTK_RENDER_LOCK": str(scratch / "tmp/vtk.lock"),
            "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "CUDA_VISIBLE_DEVICES": "",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1", "CAD_CODE_ASSEMBLY_ISOLATED": "1",
        }
        if python_wrapper:
            env["CAD_CODE_ASSEMBLY_PYTHON_WRAPPER"] = str(python_wrapper)
        system = [Path(p) for p in ("/System", "/usr/lib", "/usr/share", "/private/var/db/dyld", "/dev/urandom", "/dev/random", "/dev/null") if Path(p).exists()]
        read = roots + system + [source, scratch, runner] + ([Path(python_wrapper)] if python_wrapper else [])
        rules = " ".join(f"(subpath {json.dumps(str(p))})" for p in read)
        profile = f'''(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal (target self) (target children))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/") (literal {json.dumps(str(runner))}) {rules})
(allow file-write* (subpath {json.dumps(str(scratch))}) (literal "/dev/null"))
'''
        return ["/usr/bin/sandbox-exec", "-p", profile, *executable], env
    if platform == "linux":
        bwrap = bwrap or os.environ.get("CAD_CODE_BWRAP")
        if not bwrap:
            raise ValueError("Linux replay requires CAD_CODE_BWRAP; refusing unsandboxed execution")
        binary = Path(bwrap).resolve(strict=True)
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise ValueError("CAD_CODE_BWRAP is not executable")
        mount_root = Path("/cad-code")
        source_path, scratch_path = mount_root / "source", mount_root / "scratch"
        trusted_path, runtime_path = mount_root / "trusted", mount_root / "runtime"
        runner_path = trusted_path / "replay_assembly.py"
        wrapper_path = runtime_path / "python"
        bootstrap=("import runpy,sys;sys.path[:0]="+repr([str(path) for path in site_packages])+";sys.argv[0]="+repr(str(runner_path))+";runpy.run_path("+repr(str(runner_path))+",run_name='__main__')")
        executable = [str(python), "-I", "-B", "-X", f"pycache_prefix={scratch_path / 'cache'}", "-c", bootstrap, str(source_path / notebook), str(scratch_path / 'output')]
        env = {
            "PATH": str(Path(python).parent) + ":/usr/bin", "HOME": str(scratch_path / "home"),
            "TMPDIR": str(scratch_path / "tmp"), "XDG_CACHE_HOME": str(scratch_path / "cache"),
            "XDG_CONFIG_HOME": str(scratch_path / "home/config"), "XDG_DATA_HOME": str(scratch_path / "home/data"),
            "MPLCONFIGDIR": str(scratch_path / "cache/mpl"), "LANG": "C.UTF-8",
            "SIMPLECAD_VTK_RENDER_LOCK": str(scratch_path / "tmp/vtk.lock"),
            "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "CUDA_VISIBLE_DEVICES": "",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1", "CAD_CODE_ASSEMBLY_ISOLATED": "1",
        }
        if python_wrapper:
            env["CAD_CODE_ASSEMBLY_PYTHON_WRAPPER"] = str(wrapper_path)
        system = [Path(p) for p in ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/fonts", "/etc/localtime") if Path(p).exists()]
        runtime = [Path(python).parent, *[Path(item) for item in site_packages]]
        args = [str(binary), "--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--clearenv", "--dir", str(mount_root)]
        for directory in (source_path, scratch_path, trusted_path, runtime_path):
            args.extend(["--dir", str(directory)])
        for path in sorted(set(system + roots + runtime), key=lambda p: (len(p.parts), str(p))):
            if path == Path("/"):
                raise ValueError("Host root cannot be mounted")
            args.extend(["--ro-bind", str(path), str(path)])
        args.extend(["--ro-bind", str(source), str(source_path)])
        args.extend(["--ro-bind", str(runner.parent), str(trusted_path)])
        if python_wrapper:
            args.extend(["--ro-bind", str(Path(python_wrapper).parent), str(runtime_path)])
        args.extend(["--bind", str(scratch), str(scratch_path)])
        for key, value in env.items():
            args.extend(["--setenv", key, value])
        return args + ["--chdir", str(source_path), "--", *executable], env
    raise ValueError(f"Unsupported isolation platform: {platform}")


def isolated_replay(files, notebook, out, python, timeout=600, runner=None):
    out = Path(out).resolve(strict=True)
    runner = regular_file(runner or Path(__file__).with_name("replay_assembly.py"))
    python_entry = Path(python).absolute()
    python = python_entry.resolve(strict=True)
    roots, site_packages = runtime_roots(python_entry)
    with tempfile.TemporaryDirectory(prefix=".assembly-replay-", dir=out) as temp:
        base = Path(temp).resolve()
        source, scratch = base / "source", base / "scratch"
        source.mkdir()
        for name in ("home", "tmp", "cache", "output"):
            (scratch / name).mkdir(parents=True)
        for relative, data in files.items():
            destination = source / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            destination.chmod(0o400)
        trusted = base / "trusted"
        trusted.mkdir(mode=0o700)
        trusted_runner = trusted / "replay_assembly.py"
        trusted_runner.write_bytes(runner.read_bytes())
        trusted_runner.chmod(0o400)
        # SimpleCADAPI launches fresh Python subprocesses with sys.executable.
        # A tiny read-only wrapper restores only the venv package path that -I suppresses.
        wrapper_dir=base/'runtime';wrapper_dir.mkdir(mode=0o700)
        wrapper=wrapper_dir/'python'
        package_path=os.pathsep.join(str(site) for site in site_packages)
        wrapper_text=("#!/bin/sh\n"+
            "if [ \"${1-}\" = \"-I\" ]; then shift; fi\n"+
            "export PYTHONPATH="+shlex.quote(package_path)+"\n"+
            "exec "+shlex.quote(str(python))+" \"$@\"\n")
        wrapper.write_text(wrapper_text,encoding='utf-8');wrapper.chmod(0o500);wrapper_dir.chmod(0o500)
        command, env = sandbox_command(python, trusted_runner, source, scratch, notebook, roots, site_packages=site_packages,python_wrapper=wrapper)
        with (out / "replay.stdout.log").open("wb") as stdout, (out / "replay.stderr.log").open("wb") as stderr:
            child = subprocess.Popen(command, cwd=source, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                code = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                raise TimeoutError(f"Assembly replay exceeded {timeout}s")
            finally:
                # Kill only this replay's process group, including notebook-launched children.
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if code:
            detail = (out / "replay.stderr.log").read_text(errors="replace")[-3000:]
            raise RuntimeError(f"Isolated replay exited {code}: {detail}")
        for name in ("product.step", "product.scadpkg", "inventory.json"):
            candidate = regular_file(scratch / "output" / name)
            if candidate.stat().st_size <= 0:
                raise ValueError(f"Replay output is empty: {name}")
            with (out / name).open("xb") as handle:
                handle.write(candidate.read_bytes())
        return {"platform": sys.platform, "source_files": len(files), "network": "denied", "cache": "fresh", "code_tree": "read_only"}
