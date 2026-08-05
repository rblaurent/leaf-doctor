const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildDoctorLaunch } = require('./leaf-doctor');

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
  for (const script of scripts) {
    assert.doesNotThrow(() => new vm.Script(script));
  }
});
