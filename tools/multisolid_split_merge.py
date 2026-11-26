#!/usr/bin/env python3
"""Split a multi-solid STEP into single-solid parts and programmatically merge generated STEPs."""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Builder
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS_Compound


def read_step_shape(step_path: Path):
    reader = STEPControl_Reader()
    status = reader.ReadFile(str(step_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"Failed to read STEP file: {step_path}")
    reader.TransferRoots()
    return reader.OneShape()


def write_step_shape(shape, out_path: Path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    status = writer.Write(str(out_path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"Failed to write STEP file: {out_path}")


def extract_solids(shape):
    solids = []
    exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        solids.append(exp.Current())
        exp.Next()
    return solids


def solid_metrics(solid):
    box = Bnd_Box()
    BRepBndLib.Add_s(solid, box)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props)
    faces = 0
    fexp = TopExp_Explorer(solid, TopAbs_FACE)
    while fexp.More():
        faces += 1
        fexp.Next()
    return {
        "volume": round(float(props.Mass()), 3),
        "faces": faces,
        "bbox": [
            [round(xmin, 3), round(ymin, 3), round(zmin, 3)],
            [round(xmax, 3), round(ymax, 3), round(zmax, 3)],
        ],
        "size": [
            round(xmax - xmin, 3),
            round(ymax - ymin, 3),
            round(zmax - zmin, 3),
        ],
    }


def cmd_split(args):
    step_path = Path(args.step)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    shape = read_step_shape(step_path)
    solids = extract_solids(shape)
    if len(solids) < 2:
        print(json.dumps({"ok": False, "solid_count": len(solids), "error": f"Expected >= 2 solids, got {len(solids)}"}))
        sys.exit(2)

    parts = []
    for idx, solid in enumerate(solids, start=1):
        part_id = f"part_{idx:03d}"
        part_dir = out_dir / "parts" / part_id
        part_dir.mkdir(parents=True, exist_ok=True)
        part_step = part_dir / "target.step"
        part_ir = part_dir / "target.ir.jsonl"
        write_step_shape(solid, part_step)

        if args.stepir:
            subprocess.run(
                [sys.executable, args.stepir, str(part_step), "--out", str(part_ir)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )

        metrics = solid_metrics(solid)
        parts.append({
            "id": part_id,
            "index": idx,
            "label": f"实体 {idx}",
            **metrics,
            "target_step": f"parts/{part_id}/target.step",
            "target_ir": f"parts/{part_id}/target.ir.jsonl" if args.stepir else None,
            "session_id": None,
            "status": "pending",
        })

    print(json.dumps({"ok": True, "solid_count": len(solids), "parts": parts}, ensure_ascii=False))


def cmd_merge(args):
    out_path = Path(args.out_step)
    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)

    total_solids = 0
    for step_file in args.inputs:
        shape = read_step_shape(Path(step_file))
        solids = extract_solids(shape)
        if solids:
            for s in solids:
                builder.Add(compound, s)
                total_solids += 1
        else:
            builder.Add(compound, shape)
            total_solids += 1

    write_step_shape(compound, out_path)
    print(json.dumps({
        "ok": True,
        "merged_step": str(out_path),
        "solid_count": total_solids,
        "bytes": out_path.stat().st_size,
    }))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_split = sub.add_parser("split")
    p_split.add_argument("step")
    p_split.add_argument("out_dir")
    p_split.add_argument("--stepir", default=None)

    p_merge = sub.add_parser("merge")
    p_merge.add_argument("out_step")
    p_merge.add_argument("inputs", nargs="+")

    args = parser.parse_args()
    if args.cmd == "split":
        cmd_split(args)
    elif args.cmd == "merge":
        cmd_merge(args)


if __name__ == "__main__":
    main()
