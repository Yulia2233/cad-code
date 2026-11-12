#!/usr/bin/env python3
"""Adapt a copied notebook's definition ID without reformatting its geometry."""
import argparse
import ast
import hashlib
import json
from pathlib import Path


def adapt(text):
    tree = ast.parse(text)
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
             and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
             and n.func.value.id == 'scad' and n.func.attr in ('Part', 'make_part_rpart')]
    if len(calls) != 1:
        raise ValueError('Exactly one scad.Part or scad.make_part_rpart definition is required')
    ids = [kw.value for kw in calls[0].keywords if kw.arg == 'part_id']
    if len(ids) != 1:
        raise ValueError('The product must have an explicit part_id')
    node = ids[0]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'scad' and node.func.attr == 'notebook_id' and not node.args and not node.keywords:
        return text, []
    if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
        raise ValueError(f'Unsupported product ID expression on line {node.lineno}')
    raw = text.encode('utf-8')
    lines = raw.splitlines(keepends=True)
    start = sum(map(len, lines[:node.lineno-1])) + node.col_offset
    end = sum(map(len, lines[:node.end_lineno-1])) + node.end_col_offset
    result = raw[:start] + b'scad.notebook_id()' + raw[end:]
    ast.parse(result.decode('utf-8'))
    return result.decode('utf-8'), [{'line':node.lineno, 'original':raw[start:end].decode('utf-8'), 'replacement':'scad.notebook_id()'}]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path)
    p.add_argument('destination', type=Path)
    a = p.parse_args()
    if a.source.is_symlink() or not a.source.is_file():
        p.error('Source must be a regular notebook')
    original = a.source.read_text()
    result, changes = adapt(original)
    a.destination.parent.mkdir(parents=True, exist_ok=True)
    with a.destination.open('x') as f:
        f.write(result)
    print(json.dumps({'source_sha256':hashlib.sha256(original.encode()).hexdigest(), 'adapted_sha256':hashlib.sha256(result.encode()).hexdigest(), 'changes':changes}))


if __name__ == '__main__':
    main()
