// Full official Web profile, real Loader, ConfigEditor and HMR, isolated from
// the user's home and credentials. No inference requests or package downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = process.env.DSH_FACTORY_HOST_ROOT;
const cli = root && path.join(root, '@deepseek-ai/dsh/lib/bin.js');
const ready = cli && fs.existsSync(cli) && fs.existsSync(path.join(root, '@deepseek-ai/dsh-web-app/cordis.patch.yml'));

test('full native profile: first install, live settings, disable/enable and upgrade reload use real HMR', { skip: !ready, timeout: 90000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-profile-'));
  const profile = path.join(directory, 'profiles/web');
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('..', import.meta.url)), path.join(profile, 'node_modules/dsh-factory-provider'), 'junction');
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'factory-profile-fixture', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-factory-provider'] } } }));
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: dsh-factory-provider\n  config:\n    proactiveRefreshMinutes: 0\n');
  let child, stopped, transcript = '';
  const stop = async () => {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await stopped; } finally { clearTimeout(timer); child = undefined; }
  };
  t.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const boot = async () => {
    transcript = '';
    child = spawn(process.execPath, [cli, '--profile', 'web', '--port', '0', '--no-open'], {
      cwd: directory, env: { ...process.env, DSH_HOME: directory, FACTORY_API_KEY: '',
        DSH_FACTORY_ACCOUNTS_DIR: path.join(directory, 'accounts'), DSH_FACTORY_JOURNAL: path.join(directory, 'journal.jsonl') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let launchError;
    child.once('error', error => { launchError = error; });
    stopped = new Promise(resolve => child.once('close', resolve));
    const append = chunk => { transcript += chunk; };
    child.stdout.on('data', append); child.stderr.on('data', append);
    for (let n = 0; n < 600; n++) {
      if (launchError) throw launchError;
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(transcript);
      if (match) return match[1];
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`isolated host did not start: ${transcript.replace(/token=[^\s]+/g, 'token=REDACTED').slice(-3000)}`);
  };
  let base = await boot();
  const bridge = async (endpoint, body) => {
    const response = await fetch(`${base}/api/dsh-factory-provider/${endpoint}`, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const settled = async keys => {
    for (let n = 0; n < 200; n++) {
      const { plugin } = await bridge('status');
      if (plugin.reconcile === 'applied' && JSON.stringify(plugin.keys?.slice().sort()) === JSON.stringify(keys.slice().sort())) {
        assert.equal(plugin.error, undefined);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`provider update did not settle: ${JSON.stringify((await bridge('status')).plugin)}`);
  };
  await settled(['factory-a', 'factory-g', 'factory-o', 'factory-google', 'factory-xai', 'factory-s']);
  const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal((await bridge('status')).version, packageVersion, 'the running gateway reports the installed package version');
  const save = async fields => {
    const before = (await bridge('config')).value;
    const result = await bridge('config', { expectedRevision: before.revision,
      ops: Object.entries(fields).map(([field, value]) => ({ op: 'set', path: [field], value })) });
    assert.equal(result.ok, true, JSON.stringify(result));
  };
  const selected = { routes: ['generic', 'google'], modelAllowlist: ['glm-5.3-flash', 'gemini-4-argon'],
    modelCompactionTokens: { 'glm-5.3-flash': 810000 }, anthropicCacheTTL: '1h' };
  await save(selected);
  await settled(['factory-g', 'factory-google']);
  await save({ enabled: false }); await settled([]);
  await save({ enabled: true }); await settled(['factory-g', 'factory-google']);
  await stop();
  base = await boot();
  await settled(['factory-g', 'factory-google']);
  const restored = (await bridge('config')).value.config;
  for (const [field, value] of Object.entries(selected)) assert.deepEqual(restored[field], value, field);
  assert.equal(restored.enabled, true);
  const journal = fs.readFileSync(path.join(directory, 'journal.jsonl'), 'utf8');
  assert(!journal.includes('cannot be nested'), 'no nested HMR failure during real file-backed configuration edits');
});
