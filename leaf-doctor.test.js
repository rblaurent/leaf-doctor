const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const { buildDoctorLaunch, normalizeConfig } = require('./leaf-doctor');

const config = {
  paths: {
    redleafRoot: 'C:\\work\\redleaf',
    claudeCli: 'C:\\tools\\claude.cmd',
    codexCli: 'C:\\tools\\codex.cmd',
  },
};

test('builds a Claude Code doctor launch without putting the prompt in shell arguments', () => {
  const launch = buildDoctorLaunch('claude', 'repair prompt', config, {});

  assert.equal(launch.provider.label, 'Claude Code');
  assert.equal(launch.command, 'C:\\tools\\claude.cmd');
  assert.deepEqual(launch.args, ['--print', '--dangerously-skip-permissions']);
  assert.equal(launch.stdin, 'repair prompt');
  assert.equal(launch.cwd, 'C:\\work\\redleaf');
});

test('builds a Codex doctor launch with unattended full-access parity', () => {
  const launch = buildDoctorLaunch('codex', 'repair prompt', config, {});

  assert.equal(launch.provider.label, 'Codex');
  assert.equal(launch.command, 'C:\\tools\\codex.cmd');
  assert.deepEqual(launch.args, [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--color',
    'never',
    '-',
  ]);
  assert.equal(launch.stdin, 'repair prompt');
  assert.equal(launch.cwd, 'C:\\work\\redleaf');
});

test('rejects unknown doctor providers', () => {
  assert.throws(
    () => buildDoctorLaunch('other', 'repair prompt', config, {}),
    /Unsupported doctor provider 'other'/,
  );
});

test('can disable unrestricted provider flags from extension settings', () => {
  const safeConfig = { ...config, dangerousPermissions: false };
  assert.deepEqual(buildDoctorLaunch('claude', 'repair', safeConfig, {}).args, ['--print']);
  assert.deepEqual(buildDoctorLaunch('codex', 'repair', safeConfig, {}).args, [
    'exec', '--color', 'never', '-',
  ]);
});

test('normalizes the detached runtime contract', () => {
  const normalized = normalizeConfig({ port: '18900', configRevision: 4 });
  assert.equal(normalized.port, 18900);
  assert.equal(normalized.bindAddress, '127.0.0.1');
  assert.equal(normalized.configRevision, 4);
  assert.equal(normalized.authToken.length, 64);
  assert.equal(normalized.controlKey.length, 64);
});

test('normalizes the legacy authenticated API probe to public discovery', () => {
  const normalized = normalizeConfig({
    services: {
      api: {
        checks: [
          { name: 'Entities API', path: '/api/entities?type=agent&limit=1' },
          { name: 'Compute Sessions', path: '/ai-session/quality-modes' },
        ],
      },
    },
  });

  assert.deepEqual(normalized.services.api.checks, [
    { name: 'Entities API', path: '/api/entities?type=agent&limit=1' },
    { name: 'Discovery API', path: '/discover' },
  ]);
});

test('dashboard exposes both doctor providers and has valid client JavaScript', () => {
  const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

  assert.equal(scripts.length, 2, 'dashboard startup and application scripts are present');
  assert.match(html, /data-provider="claude"/);
  assert.match(html, /data-provider="codex"/);
  assert.match(html, /data-design-system="@redbamboo\/ui"/);
  assert.match(html, /data-slot="app-shell"/);
  assert.match(html, /data-slot="app-header"/);
  assert.match(html, /data-slot="card"/);
  assert.match(html, /data-slot="button"/);
  assert.match(html, /data-slot="badge"/);
  assert.doesNotMatch(html, /\{\{AUTH_TOKEN\}\}/);
  for (const script of scripts) {
    assert.doesNotThrow(() => new vm.Script(script));
  }
});

test('detached runtime accepts stdin config, authenticates, reconciles, and shuts down', async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const runtimeConfig = {
    port,
    bindAddress: '127.0.0.1',
    runtimeVersion: 'test-version',
    configRevision: 1,
    authToken: 'a'.repeat(64),
    controlKey: 'b'.repeat(64),
    paths: {},
    tunnel: { enabled: false },
    services: {},
  };
  const child = spawn(process.execPath, [path.join(__dirname, 'leaf-doctor.js'), '--config-stdin'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(runtimeConfig)),
  ]));

  try {
    let health;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) { health = await response.json(); break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(health?.version, 'test-version');
    assert.equal(health?.configRevision, 1);

    const login = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      body: new URLSearchParams({ token: runtimeConfig.authToken }),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);

    const next = { ...runtimeConfig, configRevision: 2, doctorProvider: 'codex' };
    const reconcile = await fetch(`http://127.0.0.1:${port}/internal/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Doctor-Control': runtimeConfig.controlKey },
      body: JSON.stringify(next),
    });
    assert.equal(reconcile.status, 200);
    assert.deepEqual(await reconcile.json(), { ok: true, restartRequired: false, configRevision: 2 });

    const shutdown = await fetch(`http://127.0.0.1:${port}/internal/shutdown`, {
      method: 'POST',
      headers: { 'X-Doctor-Control': runtimeConfig.controlKey },
    });
    assert.equal(shutdown.status, 202);
    await new Promise(resolve => child.once('exit', resolve));
  } finally {
    if (!child.killed) child.kill();
  }
});
