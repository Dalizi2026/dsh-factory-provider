// Actual DSH SettingsForms and Cordis fibers. Only the profile document editor
// is in-memory; no user profile, credentials or inference endpoint is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import * as plugin from '../lib/index.js';

const root = process.env.DSH_FACTORY_HOST_ROOT;
const host = name => import(pathToFileURL(path.join(root, '@deepseek-ai', name, 'lib/index.js')));
const nativeSettings = root && fs.existsSync(path.join(root, '@deepseek-ai/dsh-settings/lib/index.js'))
  ? await host('dsh-settings') : undefined;
const modern = typeof nativeSettings?.SettingsForms?.prototype.configure === 'function';
const settle = async (condition) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(condition(), 'settings reconciliation did not settle');
};

async function fixture(t) {
  const [{ Context, resolveConfig }, { volatileEntries, updateVolatile }, { SettingsForms }, pi] = await Promise.all([
    host('cordis'), host('cosmokit'), host('dsh-settings'), host('dsh-llm-pi-ai'),
  ]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-settings-'));
  process.env.DSH_FACTORY_JOURNAL = path.join(directory, 'journal.jsonl');
  const ctx = new Context(), rows = [], routes = new Map();
  const foreign = { api: 'openai-completions', baseURL: 'http://127.0.0.1:1/foreign', models: [{ id: 'fixture' }] };
  let tail = Promise.resolve(), edits = 0, committing = false, nestedWrites = 0;
  const editor = {
    configuration: () => rows.map(entry => ({ entry, inherited: entry.inherited, override: entry.options.config })),
    entries: () => rows,
    edit(entry, change) {
      if (committing) { nestedWrites++; throw new Error('HMR transactions cannot be nested'); }
      const run = () => {
        const raw = change(structuredClone(entry.options.config), structuredClone(entry.inherited));
        const fiber = entry.fiber;
        const candidate = resolveConfig(fiber.runtime, fiber.ctx.waterfall(fiber, 'internal/config', raw, () => raw));
        const paths = volatileEntries(fiber.config).flatMap(({ path, ref }) => {
          const next = path.reduce((value, key) => value[key], candidate);
          if (JSON.stringify(next.get()) === JSON.stringify(ref.get())) return [];
          updateVolatile(ref, next);
          return [path];
        });
        entry.options.config = raw;
        edits++;
        const carrier = Object.create(fiber.ctx);
        carrier[Context.filter] = owner => owner.fiber === fiber;
        committing = true;
        try { fiber.ctx.emit(carrier, 'loader/volatile-update', paths); }
        finally { committing = false; }
      };
      const task = tail.then(run);
      tail = task.catch(() => {});
      return task;
    },
  };
  ctx.provide('configEditor', editor);
  ctx.provide('profileContext', { home: directory });
  ctx.provide('loader', { await: async () => {} });
  const settings = new SettingsForms(ctx);
  assert.equal(typeof settings.register, 'undefined');
  assert.equal(typeof settings.installSection, 'undefined');
  const piRaw = { providers: { foreign } };
  const piFork = ctx.plugin({ name: 'llm-pi-ai', Config: pi.Config, apply() {} }, piRaw);
  await piFork;
  const entry = (id, fiber, raw) => ({ id, options: { id, name: id, config: structuredClone(raw) }, fiber: fiber.ctx.fiber, inherited: structuredClone(raw) });
  const piEntry = entry('llm-pi-ai', piFork, piRaw);
  rows.push(piEntry);
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (handler) void handler(req, res);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.provide('webServer', { port: server.address().port, register: route => {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  } });
  const raw = { routes: ['generic'], modelAllowlist: ['glm-5.3-flash'], proactiveRefreshMinutes: 0,
    modelCompactionTokens: { 'glm-5.3-flash': 800000 } };
  const factory = ctx.plugin(plugin, raw);
  rows.push(entry(plugin.name, factory, raw));
  await factory;
  const providers = () => piFork.config.providers.get();
  await settle(() => providers()['factory-g']);
  const bridge = async (endpoint, data) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dsh-factory-provider/${endpoint}`, data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    });
    return response.json();
  };
  t.after(async () => {
    await factory.dispose();
    await settle(() => !providers()['factory-g'] && !providers()['factory-s']);
    assert.equal(routes.size, 0, 'unload releases gateway routes');
    assert.equal(settings.presentations.has(factory.ctx.fiber), false, 'unload releases page policy');
    await piFork.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { ctx, factory, settings, bridge, providers, edits: () => edits, nestedWrites: () => nestedWrites, routes };
}

test('native SettingsForms: fiber-owned settings mount without removed APIs and preserve saved values', { skip: !modern }, async t => {
  const f = await fixture(t);
  const descriptor = f.settings.describe().find(row => row.ns === plugin.name);
  assert.equal(descriptor.autoGenerate, false, 'keep the custom settings page');
  assert.equal(descriptor.value.modelCompactionTokens['glm-5.3-flash'], 800000);
  const config = await f.bridge('config');
  assert.deepEqual(config.value.config.routes, ['generic']);
  assert.equal(config.value.config.modelCompactionTokens['glm-5.3-flash'], 800000);
  assert.deepEqual(f.providers().foreign.baseURL, 'http://127.0.0.1:1/foreign');
  assert.equal(f.providers()['factory-g'].models.length, 1);
});

test('native SettingsForms: bridge edits apply routes and thresholds live without announcement recursion', { skip: !modern }, async t => {
  const f = await fixture(t);
  const before = await f.bridge('config');
  const result = await f.bridge('config', { expectedRevision: before.value.revision, ops: [
    { op: 'set', path: ['routes'], value: ['standard'] },
    { op: 'set', path: ['modelAllowlist'], value: ['muse-spark-open'] },
    { op: 'set', path: ['modelCompactionTokens'], value: { 'muse-spark-open': 220000 } },
  ] });
  assert.equal(result.ok, true, JSON.stringify(result));
  await settle(() => f.providers()['factory-s'] && !f.providers()['factory-g']);
  assert.equal(f.providers()['factory-s'].models[0].id, 'muse-spark-open');
  assert.equal((await f.bridge('config')).value.config.modelCompactionTokens['muse-spark-open'], 220000);
  const edits = f.edits();
  f.ctx.emit('loader/volatile-update', [['providers']]);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(f.edits(), edits, 'catalog notifications must not rewrite plugin settings');
  assert.equal(f.nestedWrites(), 0, 'provider updates run outside the host settings transaction');
  assert.deepEqual(Object.keys(f.providers()).sort(), ['factory-s', 'foreign']);
});

test('native SettingsForms: direct host edits validate thresholds before committing and respect revisions', { skip: !modern }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.settings.mutate(plugin.name, [{ op: 'set', path: ['modelCompactionTokens'], value: { 'qwen3.8-max': 900000 } }]), /Invalid compaction threshold/);
  assert.equal((await f.bridge('config')).value.config.modelCompactionTokens['glm-5.3-flash'], 800000);
  const before = f.settings.describe().find(row => row.ns === plugin.name);
  await f.settings.mutate(plugin.name, [{ op: 'set', path: ['quotaFloat'], value: true }], before.revision);
  assert.equal((await f.bridge('config')).value.config.quotaFloat, true);
  await assert.rejects(f.settings.mutate(plugin.name, [{ op: 'set', path: ['quotaFloat'], value: false }], before.revision), /revision|conflict/i);
});

test('native SettingsForms: disabling removes only owned models and re-enabling restores them without remount', { skip: !modern }, async t => {
  const f = await fixture(t);
  const fiber = f.factory.ctx.fiber;
  await f.settings.mutate(plugin.name, [{ op: 'set', path: ['enabled'], value: false }]);
  await settle(() => !f.providers()['factory-g']);
  assert.deepEqual(Object.keys(f.providers()), ['foreign']);
  assert(f.routes.has('/api/dsh-factory-provider/config'));
  await f.settings.mutate(plugin.name, [{ op: 'set', path: ['enabled'], value: true }]);
  await settle(() => f.providers()['factory-g']);
  assert.equal(f.factory.ctx.fiber, fiber);
  assert.equal((await f.bridge('config')).value.config.modelCompactionTokens['glm-5.3-flash'], 800000);
});
