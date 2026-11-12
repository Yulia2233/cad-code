import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

function helpers() {
  const window = {};
  vm.runInNewContext(source, {window, console, setInterval, clearInterval});
  return window.AssemblyWorkbench;
}

test('project list accepts the project API array and wrapped response shapes', () => {
  const api = helpers();
  const projects = [{id: 'p1'}, {id: 'p2'}];
  assert.deepEqual(api.projectItems(projects), projects);
  assert.deepEqual(api.projectItems({projects}), projects);
  assert.equal(JSON.stringify(api.projectItems({items: projects})), '[]');
});

test('assembly selection requires completed attempts with both model deliverables', () => {
  const api = helpers();
  const good = {id: 'a1', status: 'completed', deliverables: {model_py: 'out/model.py', model_step: 'out/model.step'}};
  const badState = {...good, id: 'a2', status: 'running'};
  const missingStep = {...good, id: 'a3', deliverables: {model_py: 'out/model.py'}};
  assert.equal(api.isAssemblyAttempt(good), true);
  assert.equal(api.isAssemblyAttempt(badState), false);
  assert.equal(api.isAssemblyAttempt(missingStep), false);
  assert.equal(api.isAssemblyAttempt({...good, deliverables: {model_py: true, model_step: true}}), true);
});

test('assembly payload contains exactly one selected attempt per unique part', () => {
  const api = helpers();
  const project = {unique_parts: [
    {id: 'part-000', selected_attempt_id: 'a1', attempts: [{id: 'a1', status: 'completed', deliverables: {model_py: 'p0.py', model_step: 'p0.step'}}]},
    {id: 'part-001', selected_attempt_id: 'b1', attempts: [{id: 'b1', status: 'completed', deliverables: {model_py: 'p1.py', model_step: 'p1.step'}}]}
  ]};
  assert.equal(api.canStartAssembly(project), true);
  assert.equal(JSON.stringify(api.assemblySelection(project)), JSON.stringify([
    {part_id: 'part-000', attempt_id: 'a1'},
    {part_id: 'part-001', attempt_id: 'b1'}
  ]));
  project.unique_parts[1].selected_attempt_id = null;
  assert.equal(api.canStartAssembly(project), false);
  assert.equal(api.assemblySelection(project), null);
});

test('verdict display preserves the supplied result without inventing a pass', () => {
  const api = helpers();
  const verdict = {ok: false, riou: 0.76, errors: ['component_missing']};
  assert.equal(api.formatVerdict(verdict), JSON.stringify(verdict, null, 2));
  assert.equal(api.formatVerdict(null), '无 verdict');
});

test('page exposes manual controls and independent evaluation status', () => {
  assert.match(html, /id="parallelCount"/);
  assert.match(html, /id="runParts"/);
  assert.match(html, /id="startAssembly"/);
  assert.match(html, /尚未评测/);
  assert.match(html, /独立装配复评/);
  assert.doesNotMatch(html, /评测通过|geometry_pass/);
  assert.match(html, /name="step"/);
});

test('assembly conversations default to the latest started attempt without mutating project order', () => {
  const api = helpers();
  const project = {assembly_attempts: [
    {id: 'older', started_at: '2026-11-12T01:00:00Z'},
    {id: 'latest', started_at: '2026-11-12T02:00:00Z'},
    {id: 'middle', started_at: '2026-11-12T01:30:00Z'}
  ]};
  assert.equal(api.assemblyAttempts(project).map(attempt => attempt.id).join(','), 'latest,middle,older');
  assert.equal(project.assembly_attempts[0].id, 'older');
  assert.equal(api.assemblyAttempts({assembly_attempts: 3}).length, 0);
});

test('live session status controls follow-up availability even when persisted status is stale', () => {
  const api = helpers();
  assert.equal(api.conversationBusy({status: 'completed', session_status: {type: 'busy'}}), true);
  assert.equal(api.conversationBusy({status: 'running', session_status: {type: 'idle'}}), false);
  assert.equal(api.conversationBusy({status: 'idle', session_status: {type: 'retry'}}), true);
  assert.equal(api.conversationBusy({status: 'starting'}), true);
});

test('message data keeps tool arguments, multiline output and empty reasoning intact', () => {
  const api = helpers();
  const parts = [
    {type: 'reasoning', text: ''},
    {type: 'text', text: '<script>not executed</script>'},
    {type: 'tool', tool: 'exec', state: {status: 'completed', input: {code: 'text(1)'}, output: 'line 1\nline 2'}}
  ];
  assert.equal(api.messageParts({info: {role: 'assistant'}, parts}), parts);
  assert.equal(api.messageParts({content: 'follow-up'})[0].text, 'follow-up');
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('artifact links are scoped to the selected project and attempt and only report declared files', () => {
  const api = helpers();
  const links = api.artifactLinks('project one', {id: 'attempt_one', deliverables: {product_py: 'attempt/out/product.py', product_step: null}});
  assert.equal(links.length, 1);
  assert.equal(links[0].name, 'product.py');
  assert.equal(links[0].href, '/api/projects/project%20one/assembly/attempt_one/file?path=out%2Fproduct.py');
  assert.equal(api.artifactLinks('project one', {id: 'attempt_one'}).length, 0);
});

test('conversation UI provides manual follow-up, stop and download containers', () => {
  for (const id of ['assemblyAttemptSelect', 'assemblyMessages', 'assemblyFollowup', 'sendAssembly', 'stopAssembly', 'assemblyArtifactLinks']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /role="log"/);
  assert.match(source, /body: JSON\.stringify\(\{text\}\)/);
});
