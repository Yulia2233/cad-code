#!/usr/bin/env python3
"""Adapt a copied notebook's definition ID without reformatting its geometry."""
import argparse
import ast
import hashlib
import json
import math
from pathlib import Path


def _tuple(values, label):
    if not isinstance(values, (list, tuple)) or len(values) != 3:
        raise ValueError(f'{label} must contain three numbers')
    numbers = [float(value) for value in values]
    if not all(math.isfinite(value) for value in numbers):
        raise ValueError(f'{label} must be finite')
    return '(' + ', '.join(format(value, '.17g') for value in numbers) + ')'


def adapt(text, connectors=()):
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
    identity_change = None
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'scad' and node.func.attr == 'notebook_id' and not node.args and not node.keywords:
        result = text
    else:
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            raise ValueError(f'Unsupported product ID expression on line {node.lineno}')
        raw = text.encode('utf-8')
        lines = raw.splitlines(keepends=True)
        start = sum(map(len, lines[:node.lineno-1])) + node.col_offset
        end = sum(map(len, lines[:node.end_lineno-1])) + node.end_col_offset
        result_bytes = raw[:start] + b'scad.notebook_id()' + raw[end:]
        result = result_bytes.decode('utf-8')
        identity_change = {'line': node.lineno, 'original': raw[start:end].decode('utf-8'), 'replacement': 'scad.notebook_id()'}

    changes = [] if identity_change is None else [identity_change]
    if connectors:
        adapted_tree = ast.parse(result)
        part_calls = [n for n in ast.walk(adapted_tree) if isinstance(n, ast.Call)
                      and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
                      and n.func.value.id == 'scad' and n.func.attr in ('Part', 'make_part_rpart')]
        part_call = part_calls[0]
        if isinstance(part_call.func, ast.Attribute) and part_call.func.attr == 'Part':
            raw = result.encode('utf-8')
            lines = raw.splitlines(keepends=True)
            attr_start = sum(map(len, lines[:part_call.func.end_lineno-1])) + part_call.func.end_col_offset - len(part_call.func.attr)
            attr_end = attr_start + len(part_call.func.attr)
            raw = raw[:attr_start] + b'make_part_rpart' + raw[attr_end:]
            result = raw.decode('utf-8')
            adapted_tree = ast.parse(result)
            part_calls = [n for n in ast.walk(adapted_tree) if isinstance(n, ast.Call)
                          and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
                          and n.func.value.id == 'scad' and n.func.attr == 'make_part_rpart']
            part_call = part_calls[0]
            changes.append({'part_constructor': 'scad.Part', 'replacement': 'scad.make_part_rpart', 'reason': 'record assembly connectors in GraphSession'})
        assignments = [n for n in ast.walk(adapted_tree)
                       if isinstance(n, (ast.Assign, ast.AnnAssign)) and getattr(n, 'value', None) is part_call]
        if len(assignments) != 1 or len(assignments) == 0:
            raise ValueError('Part construction must be assigned once before adding assembly connectors')
        assignment = assignments[0]
        target = assignment.targets[0] if isinstance(assignment, ast.Assign) else assignment.target
        if not isinstance(target, ast.Name):
            raise ValueError('Part construction target must be a local name')
        variable = target.id
        source_lines = result.splitlines(keepends=True)
        insert_at = sum(map(len, source_lines[:assignment.end_lineno]))
        assignment_line = source_lines[assignment.lineno - 1]
        indentation = assignment_line[:len(assignment_line) - len(assignment_line.lstrip())]
        injected = []
        seen = set()
        for connector in connectors:
            connector_id = connector.get('connector_id')
            if not isinstance(connector_id, str) or not connector_id or connector_id in seen:
                raise ValueError('Connector IDs must be nonempty and unique per part')
            seen.add(connector_id)
            origin = _tuple(connector.get('placement', {}).get('origin'), 'connector origin')
            x_axis = _tuple(connector.get('placement', {}).get('x_axis'), 'connector x_axis')
            y_axis = _tuple(connector.get('placement', {}).get('y_axis'), 'connector y_axis')
            injected.append(
                f'{indentation}{variable} = scad.add_connector_rpart(\n'
                f'{indentation}    part={variable},\n'
                f'{indentation}    connector=scad.make_placement_connector_rconnector(\n'
                f'{indentation}        connector_id={json.dumps(connector_id)},\n'
                f'{indentation}        placement=scad.make_placement_rplacement(origin={origin}, x_axis={x_axis}, y_axis={y_axis}),\n'
                f'{indentation}    ),\n'
                f'{indentation})\n'
            )
        result = result[:insert_at] + ''.join(injected) + result[insert_at:]
        changes.append({'connectors_added': len(injected), 'connector_ids': sorted(seen)})
    ast.parse(result)
    return result, changes


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path)
    p.add_argument('destination', type=Path)
    p.add_argument('--connectors-json', type=Path)
    a = p.parse_args()
    if a.source.is_symlink() or not a.source.is_file():
        p.error('Source must be a regular notebook')
    original = a.source.read_text()
    connectors = json.loads(a.connectors_json.read_text()) if a.connectors_json else []
    if not isinstance(connectors, list):
        p.error('Connector specification must be a JSON list')
    result, changes = adapt(original, connectors)
    a.destination.parent.mkdir(parents=True, exist_ok=True)
    with a.destination.open('x') as f:
        f.write(result)
    print(json.dumps({'source_sha256':hashlib.sha256(original.encode()).hexdigest(), 'adapted_sha256':hashlib.sha256(result.encode()).hexdigest(), 'changes':changes}))


if __name__ == '__main__':
    main()
