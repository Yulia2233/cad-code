import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {initializeProject, readProject, summarizeProject, updateProject} from '../multi/store.mjs';

const ir = () => ({
  schema_version: 'step-assembly-ir-v1',
  source: {solid_occurrences: 2, unique_parts: 1},
  unique_parts: [{id: 'part-000', stepir_version: 'v6.3', stepir_sha256: 'a'.repeat(64)}],
  instances: [
    {id: 'instance-000', part_id: 'part-000'},
    {id: 'instance-001', part_id: 'part-000'},
  ],
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-project-store-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'assembly.ir.json'), JSON.stringify(ir()) + '\n');
  return root;
}

test('project manifest preserves occurrence-to-unique-part mapping and state summary', t => {
  const root = fixture(t), project = initializeProject({projectDir: root, source: {sha256: 'b'.repeat(64), solid_count: 2}, assemblyIR: ir()});
  assert.equal(project.state, 'ir_ready');
  assert.equal(project.unique_parts.length, 1);
  assert.equal(project.instances.length, 2);
  assert.deepEqual(summarizeProject(readProject(root)).part_status, {queued: 1, running: 0, completed: 0, failed: 0});
  assert.throws(() => initializeProject({projectDir: root, source: {sha256: 'b'.repeat(64), solid_count: 2}, assemblyIR: ir()}), /already exists/);
});

test('project updates are revision-checked and reject illegal transitions', t => {
  const root = fixture(t), project = initializeProject({projectDir: root, source: {sha256: 'b'.repeat(64), solid_count: 2}, assemblyIR: ir()});
  const queued = updateProject(root, 0, next => { next.state = 'parts_queued'; });
  assert.equal(queued.revision, 1);
  assert.throws(() => updateProject(root, 0, next => { next.state = 'parts_running'; }), /expected revision 0/);
  assert.throws(() => updateProject(root, 1, next => { next.state = 'evaluated'; }), /cannot transition/);
});

test('project lock serializes writes and identity cannot be changed', t => {
  const root = fixture(t), project = initializeProject({projectDir: root, source: {sha256: 'b'.repeat(64), solid_count: 2}, assemblyIR: ir()});
  fs.writeFileSync(path.join(root, '.project.lock'), 'held');
  assert.throws(() => updateProject(root, 0, next => { next.state = 'parts_queued'; }), /ProjectBusy/);
  fs.unlinkSync(path.join(root, '.project.lock'));
  assert.throws(() => updateProject(root, 0, next => { next.project_id = 'other'; }), /identity fields are immutable/);
  assert.equal(readProject(root).project_id, project.project_id);
});
