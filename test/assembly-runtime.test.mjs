import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildAssemblyConfig} from '../multi/assembly-runtime.mjs';

function baseConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {'cad-local': {name: 'local', npm: '@ai-sdk/openai', options: {baseURL: 'http://127.0.0.1:18135/v1', apiKey: 'gateway-token'}, models: {'gpt-6.1-sol': {name: 'gpt-6.1-sol', tool_call: true}}}},
    compaction: {auto: true, prune: false},
    agent: {'cad-code': {prompt: 'single part only'}},
  };
}

test('assembly runtime uses an isolated role and plugin while reusing the configured gateway model', () => {
  const config = buildAssemblyConfig(baseConfig(), {pluginPath: '/cad-code/multi/assembly-plugin.mjs', model: 'gpt-6.1-sol'});
  assert.equal(config.default_agent, 'cad-assembly');
  assert.equal(config.agent['cad-assembly'].model, 'cad-local/gpt-6.1-sol');
  assert.equal(config.agent['cad-assembly'].prompt, '[CAD_CODE_ASSEMBLY_ROLE]');
  assert.deepEqual(config.plugin, ['file:///cad-code/multi/assembly-plugin.mjs']);
  assert.equal(config.provider['cad-local'].options.apiKey, 'gateway-token');
  assert.equal(config.agent['cad-code'], undefined);
});

test('assembly runtime rejects a model that is absent from the saved local gateway config', () => {
  assert.throws(() => buildAssemblyConfig(baseConfig(), {pluginPath: '/cad-code/multi/assembly-plugin.mjs', model: 'missing-model'}), /model gateway was not found/);
});
