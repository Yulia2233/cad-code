import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {stageAssemblyInputs} from '../multi/inputs.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-assembly-inputs-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'unique/part-000'), {recursive: true});
  fs.mkdirSync(path.join(root, 'attempts/part-000/out'), {recursive: true});
  fs.writeFileSync(path.join(root, 'assembly.ir.json'), JSON.stringify({schema_version:'step-assembly-ir-v1',units:'mm',source:{solid_occurrences:1,unique_parts:1},unique_parts:[{id:'part-000',representative_instance:'instance-000',metrics:{bbox_mm:{min:[0,0,0],max:[1,1,1]},bbox_size_mm:[1,1,1],face_count:6}}],instances:[{id:'instance-000',part_id:'part-000',placement:{origin:[0,0,0],x_axis:[1,0,0],y_axis:[0,1,0]},source_occurrence:{name:'part',path:'root/part'}}],relations:[],suggested_mates:[]})+'\n');
  fs.writeFileSync(path.join(root, 'unique/part-000/target.ir.jsonl'), '{"unit":"mm","bbox":[[0,0,0],[1,1,1]],"vol":1,"area":6,"solids":1,"counts":{"face":6,"edge":12},"types":{"PLANE":6}}\n');
  fs.writeFileSync(path.join(root, 'attempts/part-000/out/model.py'), 'model = None\n');
  fs.writeFileSync(path.join(root, 'source.step'), 'target geometry\n');
  return root;
}

const selectedParts = root => {
  const notebook = 'attempts/part-000/out/model.py';
  const stepir = 'unique/part-000/target.ir.jsonl';
  return [{part_id: 'part-000', notebook, notebook_sha256: sha(fs.readFileSync(path.join(root, notebook))), stepir, stepir_version: 'v6.3', stepir_sha256: sha(fs.readFileSync(path.join(root, stepir)))}];
};

test('snapshot retains full hashed sources and writes a compact bounded context index', t => {
  const root = fixture(t), out = path.join(root, 'attempts/assembly-000/input');
  const manifest = stageAssemblyInputs({projectRoot: root, attemptInputDir: out, projectID: 'project-1', assemblyIRPath: 'assembly.ir.json', selectedParts: selectedParts(root)});
  assert.equal(manifest.schema_version, 'cad-code-assembly-inputs-v1');
  assert.equal(manifest.parts[0].notebook, 'parts/part-000/model.py');
  assert.equal(manifest.parts[0].stepir, 'parts/part-000/target.ir.jsonl');
  assert.equal(fs.existsSync(path.join(out, 'source.step')), false);
  assert.equal(fs.existsSync(path.join(out, 'parts/part-000/model.py')), true);
  const saved = JSON.parse(fs.readFileSync(path.join(out, 'assembly-inputs.json')));
  assert.equal(saved.files.length, 6);
  assert.equal(saved.context_index, 'assembly-context-index.json');
  assert.equal(saved.files.find(file => file.path === saved.context_index).sha256, saved.context_index_sha256);
  const index = JSON.parse(fs.readFileSync(path.join(out, saved.context_index)));
  assert.equal(index.counts.occurrences, 1);
  assert.equal(index.counts.unique_parts, 1);
  assert.equal(index.pages.parts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, index.pages.parts[0]))).items[0].part_id, 'part-000');
  assert.ok(Buffer.byteLength(JSON.stringify(index)) < 12000);
});

test('snapshot rejects non-v6.3 IR, target STEP, symlinks, and hash drift', t => {
  const root = fixture(t);
  const run = (part, assemblyIRPath = 'assembly.ir.json') => stageAssemblyInputs({projectRoot: root, attemptInputDir: path.join(root, 'attempts/reject/input'), projectID: 'p', assemblyIRPath, selectedParts: [part]});
  assert.throws(() => run({...selectedParts(root)[0], stepir_version: 'v6.2.2'}), /must use STEPIR v6\.3/);
  assert.throws(() => run({...selectedParts(root)[0], notebook: 'source.step'}), /forbidden geometry artifact/);
  assert.throws(() => run({...selectedParts(root)[0], notebook_sha256: '0'.repeat(64)}), /hash mismatch/);
  const outside = path.join(os.tmpdir(), `cad-outside-${process.pid}.py`);
  fs.writeFileSync(outside, 'model = None\n');
  t.after(() => fs.rmSync(outside, {force: true}));
  fs.symlinkSync(outside, path.join(root, 'linked.py'));
  assert.throws(() => run({...selectedParts(root)[0], notebook: 'linked.py'}), /regular file/);
});

test('snapshot is immutable after creation and duplicate part IDs fail closed', t => {
  const root = fixture(t), out = path.join(root, 'attempts/assembly-000/input'), parts = selectedParts(root);
  stageAssemblyInputs({projectRoot: root, attemptInputDir: out, projectID: 'p', assemblyIRPath: 'assembly.ir.json', selectedParts: parts});
  assert.throws(() => stageAssemblyInputs({projectRoot: root, attemptInputDir: out, projectID: 'p', assemblyIRPath: 'assembly.ir.json', selectedParts: parts}), /refusing to overwrite/);
  assert.throws(() => stageAssemblyInputs({projectRoot: root, attemptInputDir: path.join(root, 'attempts/reject/input'), projectID: 'p', assemblyIRPath: 'assembly.ir.json', selectedParts: [parts[0], parts[0]]}), /duplicate part ID/);
});
