import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {ROOT} from '../src/paths.mjs';

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('AssemblyRuntimeError: runtime path must be a directory, not a symlink');
  fs.chmodSync(directory, 0o700);
}

export function buildAssemblyConfig(baseConfig, {pluginPath, model}) {
  if (!baseConfig?.provider?.['cad-local'] || !baseConfig.provider['cad-local'].models?.[model]) throw Error('AssemblyRuntimeError: configured CAD model gateway was not found');
  const modelRef = `cad-local/${model}`;
  return {
    $schema: baseConfig.$schema,
    model: modelRef,
    small_model: modelRef,
    default_agent: 'cad-assembly',
    plugin: [pathToFileURL(pluginPath).href],
    instructions: [],
    enabled_providers: ['cad-local'],
    compaction: {...baseConfig.compaction},
    provider: { 'cad-local': structuredClone(baseConfig.provider['cad-local']) },
    agent: {
      'cad-assembly': {
        description: 'Compose reconstructed part notebooks into an assembly',
        mode: 'primary',
        model: modelRef,
        temperature: 1,
        prompt: '[CAD_CODE_ASSEMBLY_ROLE]',
        tools: {'*': false, exec: true, question: true, todowrite: true, task: false},
        permission: {'*': 'deny', exec: 'allow', question: 'allow', todowrite: 'allow', task: {'*': 'deny'}},
      },
      compaction: {model: modelRef, temperature: 1},
    },
    permission: {'*': 'deny', exec: 'allow', question: 'allow', todowrite: 'allow', task: {'*': 'deny'}},
  };
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function healthy(url, password) {
  try {
    const response = await fetch(new URL('/global/health', url), {
      headers: {authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64')},
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch { return false; }
}

export async function startAssemblyRuntime({runtimeDir, workspaceDir, contextFile, baseConfigPath, model, python, skill, assemblySkill, opencodeBin = 'opencode', startupTimeoutMs = 45000}) {
  ensurePrivateDirectory(runtimeDir);
  ensurePrivateDirectory(workspaceDir);
  // Each assembly backend owns its gateway, media sidecars and OpenCode database.
  // Reuse the credential path, never copy the external API secret into a project.
  const baseRuntime = path.dirname(baseConfigPath);
  const pointer = JSON.parse(fs.readFileSync(path.join(baseRuntime, 'connection.json'), 'utf8'));
  const credentials = process.env.CAD_CODE_CREDENTIALS || pointer.credentialFile;
  if (!credentials) throw Error('AssemblyRuntimeError: no configured credential reference');
  const pythonInfo = path.join(baseRuntime, 'python-environment.json');
  if (fs.existsSync(pythonInfo)) fs.copyFileSync(pythonInfo, path.join(runtimeDir, 'python-environment.json'));
  const ports = new Set();
  while (ports.size < 3) ports.add(await unusedPort());
  const [webPort, ocPort, gatewayPort] = [...ports];
  const env = {...process.env, PORT: String(webPort), CAD_CODE_OPENCODE_PORT: String(ocPort),
    CAD_CODE_GATEWAY_PORT: String(gatewayPort), CAD_CODE_MODEL: model,
    CAD_CODE_CREDENTIALS: credentials, CAD_CODE_RUNTIME: runtimeDir,
    CAD_CODE_WORKSPACE: workspaceDir, CAD_CODE_PYTHON: python, CAD_CODE_SKILL: skill,
    CAD_CODE_ASSEMBLY_SKILL: assemblySkill, CAD_CODE_ASSEMBLY_CONTEXT_FILE: contextFile,
    OPENCODE_BIN: opencodeBin};
  const log = fs.openSync(path.join(runtimeDir, 'launcher.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs'), '--managed-cli', '--web'],
    {cwd: ROOT, env, stdio: ['ignore', log, log]});
  fs.closeSync(log);
  let failure;
  child.once('error', error => { failure = error; });
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null) throw Error('AssemblyRuntimeError: backend failed to start; inspect its launcher.log');
    let connection;
    try { connection = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'cli-connection.json'), 'utf8')); } catch {}
    if (connection?.pid === child.pid && await healthy(connection.url, connection.password)) return {connection, stop};
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await stop();
  throw Error('AssemblyRuntimeError: backend readiness timed out');
}
