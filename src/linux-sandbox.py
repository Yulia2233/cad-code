#!/usr/bin/env python3
"""Fail-closed Linux worker and notebook replay isolation; no host-root bind."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYROOT = ROOT / ".runtime/python"


def runtime_mounts():
    info = json.loads((ROOT / ".runtime/python-environment.json").read_text())
    paths = [Path(p) for p in ("/usr", "/bin", "/sbin", "/lib", "/lib64") if Path(p).exists()]
    paths += [Path(p) for p in ("/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d",
                               "/etc/localtime", "/etc/fonts") if Path(p).exists()]
    paths += [PYROOT, PYROOT.resolve(), ROOT / "src", ROOT / "tools", ROOT / "skills/simplecadapi",
              ROOT / ".runtime/python-environment.json"]
    paths += [Path(p).resolve() for p in info["library_roots"]]
    bwrap = Path(os.environ["CAD_CODE_BWRAP"]).resolve(strict=True)
    if not bwrap.is_file() or not os.access(bwrap, os.X_OK):
        raise RuntimeError("CAD_CODE_BWRAP is not executable")
    paths += [bwrap]
    return bwrap, sorted(set(paths), key=lambda p: (len(p.parts), str(p)))


def command(bindings, cwd, env, executable):
    bwrap, roots = runtime_mounts()
    args = [str(bwrap), "--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL",
            "--hostname", "cad-case", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
            "--clearenv"]
    mounts = [("--ro-bind", p, p) for p in roots] + bindings
    # bwrap creates missing destinations; parent directories contain no host files.
    for mode, src, dst in mounts:
        if Path(src) == Path("/") or Path(dst) == Path("/"):
            raise RuntimeError("Host root must never be mounted")
        args += [mode, str(src), str(dst)]
    for name, value in env.items():
        args += ["--setenv", name, str(value)]
    args += ["--chdir", str(cwd), "--"] + list(map(str, executable))
    return args


def environment(work):
    env = {name: os.environ[name] for name in
           ("PATH", "LANG", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE", "OMP_NUM_THREADS",
            "OPENBLAS_NUM_THREADS", "CAD_CODE_PYTHON", "CAD_CODE_SKILL", "CAD_CODE_BWRAP") if name in os.environ}
    env.update(HOME=str(work / ".home"), TMPDIR=str(work / ".tmp"),
               MPLCONFIGDIR=str(work / ".tmp/mpl"), SIMPLECAD_VTK_RENDER_LOCK=str(work / ".tmp/vtk-render.lock"),
               CUDA_VISIBLE_DEVICES="", PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
    return env


def worker(args):
    work = Path(args.work).resolve(strict=True)
    if not work.name.startswith("ses_") or not work.is_dir():
        raise RuntimeError("Invalid session workspace")
    node = Path(args.node).resolve(strict=True)
    bindings = [("--ro-bind", node.parent, node.parent), ("--bind", work, work)]
    if (work / "input").exists():
        if (work / "input").is_symlink():
            raise RuntimeError("Session input must be a directory")
        bindings.append(("--ro-bind", work / "input", work / "input"))
    readonly = json.loads(args.readonly)
    for p in readonly:
        p = Path(p).resolve(strict=True)
        # Reviewer artifact roots may only be the out/ directory of another session.
        if p.name != "out" or not p.parent.name.startswith("ses_") or p.parent.parent != work.parent:
            raise RuntimeError("Unexpected read-only artifact root")
        bindings.append(("--ro-bind", p, p))
    env = environment(work)
    env.update(CAD_CODE_WORK=str(work), CAD_CODE_READONLY=json.dumps(readonly))
    cmd = command(bindings, work, env, [node, ROOT / "src/worker.mjs"])
    os.execv(cmd[0], cmd)


def notebook(args):
    nb, out, runner = Path(args.notebook).absolute(), Path(args.out).absolute(), Path(args.runner).absolute()
    if not nb.is_file() or nb.is_symlink() or not runner.is_file() or runner.is_symlink():
        raise RuntimeError("Replay inputs must be regular files")
    # Only a fresh scratch tree is writable. Old eval output and notebook siblings are invisible.
    with tempfile.TemporaryDirectory(prefix=".isolated-replay-", dir=out) as tmp:
        scratch = Path(tmp)
        for name in (".tmp", ".home"):
            (scratch / name).mkdir()
        env = environment(out)
        env["CAD_CODE_REPLAY_ISOLATED"] = "1"
        bindings = [("--ro-bind", nb, nb), ("--ro-bind", runner, runner), ("--bind", scratch, out)]
        cmd = command(bindings, nb.parent, env,
                      [PYROOT / "bin/python", "-I", runner, nb, out])
        result = subprocess.run(cmd, stdin=subprocess.DEVNULL)
        if result.returncode:
            return result.returncode
        for name in ("candidate.step", "candidate.scadpkg"):
            src = scratch / name
            if src.is_file() and not src.is_symlink():
                shutil.copyfile(src, out / name)
    return 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)
    w = sub.add_parser("worker")
    w.add_argument("--work", required=True)
    w.add_argument("--node", required=True)
    w.add_argument("--readonly", default="[]")
    n = sub.add_parser("notebook")
    n.add_argument("--notebook", required=True)
    n.add_argument("--out", required=True)
    n.add_argument("--runner", required=True)
    args = parser.parse_args()
    if sys.platform != "linux":
        raise RuntimeError("Linux isolation helper called on another platform")
    if args.mode == "worker":
        worker(args)
    else:
        sys.exit(notebook(args))


if __name__ == "__main__":
    main()
