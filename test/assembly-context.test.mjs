import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {buildAssemblyContextAssets, createStaticAssemblyScaffold, createStaticConnectorPlan} from '../multi/assembly-context.mjs';

const PYTHON = process.env.CAD_CODE_PYTHON || path.join(path.dirname(fileURLToPath(import.meta.url)), '../.runtime/python/bin/python');

test('context index pages large inventories and bounds motion candidates without dropping occurrence counts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-context-index-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const irPath = path.join(root, 'assembly.ir.json');
  const headerPath = path.join(root, 'part.ir.jsonl');
  fs.writeFileSync(headerPath, JSON.stringify({unit: 'mm', bbox: [[0,0,0],[1,1,1]], vol: 1, area: 6, solids: 1,
    counts: {face: 6, edge: 12}, types: {PLANE: 6}})+'\n');
  const partCount = 240, occurrenceCount = 1200;
  const unique = Array.from({length: partCount}, (_, index) => ({id: `part-${index}`, representative_instance: `instance-${index}`,
    metrics: {bbox_mm: {min: [0,0,0], max: [1,1,1]}, bbox_size_mm: [1,1,1], face_count: 6}}));
  const instances = Array.from({length: occurrenceCount}, (_, index) => ({id: `instance-${index}`, part_id: `part-${index % partCount}`,
    placement: {origin: [index,0,0], x_axis: [1,0,0], y_axis: [0,1,0]}, source_occurrence: {name: `occurrence-${index}`, path: `root/${index}`}}));
  fs.writeFileSync(irPath, JSON.stringify({schema_version: 'step-assembly-ir-v1', units: 'mm', coordinate_convention: 'source',
    source: {solid_occurrences: occurrenceCount, unique_parts: partCount}, hierarchy: {status: 'test'}, unique_parts: unique,
    instances, relations: [], relations_summary: {possible_pair_count: 1200 * 1199 / 2, retained_pair_count: 6000, omitted_pair_count: 1200 * 1199 / 2 - 6000},
    suggested_mates: Array.from({length: 200}, (_, index) => ({id: `candidate-${index}`, kind: 'possible_joint', instances: ['a','b']}))}));
  const selectedParts = unique.map(part => ({part_id: part.id, stepir: 'part.ir.jsonl', stepir_version: 'v6.3',
    stepir_sha256: 'a'.repeat(64), notebook_sha256: 'b'.repeat(64), stepeval_verdict: {ok: true, riou: 1}}));
  const assets = buildAssemblyContextAssets({projectRoot: root, projectID: 'p', assemblyIRPath: 'assembly.ir.json',
    assemblyIRHash: 'c'.repeat(64), selectedParts});
  assert.equal(assets.index.counts.occurrences, occurrenceCount);
  assert.equal(assets.index.counts.unique_parts, partCount);
  assert.equal(assets.index.counts.candidate_relations_exposed, 64);
  assert.equal(assets.index.counts.candidate_relations_omitted, 136);
  assert.equal(assets.index.counts.bbox_relation_pairs_possible, 1200 * 1199 / 2);
  assert.equal(assets.index.counts.bbox_relation_pairs_retained, 6000);
  assert.ok(Buffer.byteLength(JSON.stringify(assets.index)) < 20000);
  const partPages = assets.pageFiles.filter(file => file.role === 'assembly_part_index_page');
  const occurrencePages = assets.pageFiles.filter(file => file.role === 'assembly_occurrence_index_page');
  assert.equal(partPages.length, 5);
  assert.equal(occurrencePages.length, 13);
  assert.ok(partPages.every(file => JSON.parse(file.content).items.length <= 48));
  assert.ok(occurrencePages.every(file => JSON.parse(file.content).items.length <= 96));
  assert.equal(assets.pageFiles.some(file => file.content.includes('bbox_distance_lower_bound')), false);
});

test('static scaffold deterministically covers every unique definition and source occurrence', () => {
  const parts = Array.from({length: 65}, (_, index) => ({part_id: `part-${index}`}));
  const instances = Array.from({length: 200}, (_, index) => ({id: `instance-${index}`, part_id: `part-${index % parts.length}`,
    placement: {origin: [index,0,0], x_axis: [1,0,0], y_axis: [0,1,0]}, source_occurrence: {name: `occ-${index}`}}));
  const source = createStaticAssemblyScaffold({parts, assembly: {instances}});
  assert.equal((source.match(/scad\.use\(/g) || []).length, parts.length);
  assert.equal((source.match(/scad\.add_component_rassembly\(/g) || []).length, 1);
  assert.equal((source.match(/"id":"instance-/g) || []).length, instances.length);
  assert.match(source, /component_id=_row\["id"\]/);
  assert.match(source, /origin=tuple\(_row\["origin"\]\)/);
  assert.match(source, /scad\.ground_component_rassembly/);
  assert.match(source, /scad\.add_fixed_constraint_rassembly/);
  const python = spawnSync(fs.existsSync(PYTHON) ? PYTHON : 'python3', ['-c', 'import sys; compile(sys.stdin.read(), "scaffold.py", "exec")'],
    {input: source, encoding: 'utf8', timeout: 10000});
  assert.equal(python.status, 0, python.stderr);
});

test('fixed scaffold builds and exports with SimpleCADAPI while preserving source occurrence poses', {skip: !fs.existsSync(PYTHON), timeout: 120000}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-fixed-scaffold-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const partID = 'part-000', part = {part_id: partID};
  const sourcePath = path.join(root, 'source.py');
  fs.writeFileSync(sourcePath, `# /// script
# requires-python = ">=3.10"
# dependencies = ["simplecadapi==2.2.7"]
#
# [tool.simplecadapi]
# id = "model"
# revision = "1.0.0"
# ///
import marimo
app = marimo.App()
with app.setup:
    import simplecadapi as scad
@app.cell
def _():
    body = scad.make_box_rsolid(width=2.0, height=3.0, depth=4.0)
    model = scad.Part(part_id="model", body=body)
    return (model,)
if __name__ == "__main__":
    app.run()
`);
  const assembly = {instances: [
    {id: 'instance-000', part_id: partID, placement: {origin: [2,3,5], x_axis: [0,1,0], y_axis: [-1,0,0]}, source_occurrence: {name: 'base'}},
    {id: 'instance-001', part_id: partID, placement: {origin: [10,0,0], x_axis: [1,0,0], y_axis: [0,1,0]}, source_occurrence: {name: 'copy'}},
    {id: 'instance-002', part_id: partID, placement: {origin: [0,20,0], x_axis: [0,-1,0], y_axis: [1,0,0]}, source_occurrence: {name: 'rotated-copy'}},
  ]};
  const plan = createStaticConnectorPlan(assembly);
  const connectorsPath = path.join(root, 'connectors.json');
  fs.writeFileSync(connectorsPath, JSON.stringify(plan.connectors[partID]));
  const adaptedPath = path.join(root, 'parts', partID, 'model.py');
  const adapter = path.join(path.dirname(fileURLToPath(import.meta.url)), '../multi/notebook_adapter.py');
  const adapted = spawnSync(PYTHON, [adapter, sourcePath, adaptedPath, '--connectors-json', connectorsPath], {encoding: 'utf8'});
  assert.equal(adapted.status, 0, adapted.stderr);
  fs.writeFileSync(path.join(root, 'product.py'), createStaticAssemblyScaffold({assembly, parts: [part], connectorPlan: plan}));
  let result = spawnSync(path.join(path.dirname(PYTHON), 'sca'), ['run', 'product.py', '--out', 'product.scadpkg'],
    {cwd: root, encoding: 'utf8', timeout: 90000});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  result = spawnSync(path.join(path.dirname(PYTHON), 'sca'), ['export', 'product.scadpkg', '--format', 'step', '--output-dir', 'out', '--overwrite'],
    {cwd: root, encoding: 'utf8', timeout: 90000});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const step = path.join(root, 'out/product.step');
  const inspect = spawnSync(PYTHON, ['-I', '-c', 'import json,sys; from simplecadapi.inspect import brep; r=brep.inspect_step_rsummary(path=sys.argv[1]); print(json.dumps({"bodies":r["body_count"],"bbox":r["bounding_box"]}))', step], {encoding: 'utf8'});
  assert.equal(inspect.status, 0, inspect.stderr);
  const facts = JSON.parse(inspect.stdout.trim().split('\n').at(-1));
  assert.equal(facts.bodies, 3);
  assert.equal(facts.bbox.min[0], -1.5, JSON.stringify(facts));
  assert.equal(facts.bbox.max[0], 11, JSON.stringify(facts));
  assert.equal(facts.bbox.min[1], -1.5, JSON.stringify(facts));
  assert.equal(facts.bbox.max[1], 21, JSON.stringify(facts));
  assert.equal(facts.bbox.min[2], 0, JSON.stringify(facts));
  assert.equal(facts.bbox.max[2], 9, JSON.stringify(facts));

  const indexPath = path.join(root, 'assembly-context-index.json');
  const context = {schema_version: 'cad-code-assembly-context-index-v1', project_id: 'test',
    assembly_ir_sha256: 'a'.repeat(64), counts: {occurrences: 3, candidate_relations_exposed: 0, candidate_relations_omitted: 0}};
  fs.writeFileSync(indexPath, JSON.stringify(context));
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/assembly_delivery.py');
  result = spawnSync(PYTHON, [helper, '--notebook', path.join(root, 'product.py'), '--index', indexPath,
    '--out', path.join(root, 'delivery')], {cwd: root, encoding: 'utf8', timeout: 90000});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const observed = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(observed.occurrences, 3);
  assert.equal(observed.constraint_count, 2);
  assert.equal(observed.constraints.solved, true);
  assert.equal(observed.independent_acceptance, 'pending_controller_evaluation');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'delivery/assembly-report.json')));
  assert.deepEqual(report.occurrences.map(row => row.instance_id), assembly.instances.map(row => row.id));
  assert.ok(fs.statSync(path.join(root, 'delivery/product.step')).size > 0);
  fs.writeFileSync(indexPath, JSON.stringify({...context, counts: {...context.counts, occurrences: 4}}));
  result = spawnSync(PYTHON, [helper, '--notebook', path.join(root, 'product.py'), '--index', indexPath,
    '--out', path.join(root, 'mismatch')], {cwd: root, encoding: 'utf8', timeout: 90000});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /occurrence count differs/);
  assert.equal(fs.existsSync(path.join(root, 'mismatch/product.step')), false);
});
