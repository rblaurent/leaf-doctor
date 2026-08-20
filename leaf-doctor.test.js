const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');

const { buildDoctorLaunch, createSecretRedactor, normalizeConfig } = require('./leaf-doctor');

const config = {
  paths: {
    redleafRoot: 'C:\\work\\redleaf',
    claudeCli: 'C:\\tools\\claude.cmd',
    codexCli: 'C:\\tools\\codex.cmd',
  },
};

test('builds a Claude Code doctor launch without putting the prompt in shell arguments', () => {
  const launch = buildDoctorLaunch('claude', 'repair prompt', config, {}, {
    providerSessionId: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(launch.provider.label, 'Claude Code');
  assert.equal(launch.command, 'C:\\tools\\claude.cmd');
  assert.deepEqual(launch.args, [
    '--print',
    '--dangerously-skip-permissions',
    '--session-id',
    '11111111-1111-4111-8111-111111111111',
  ]);
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
    '--json',
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
    'exec', '--json', '-',
  ]);
});

test('resumes the exact provider session for follow-up messages', () => {
  const session = {
    resume: true,
    providerSessionId: '22222222-2222-4222-8222-222222222222',
  };
  assert.deepEqual(buildDoctorLaunch('claude', 'follow up', config, {}, session).args, [
    '--print',
    '--dangerously-skip-permissions',
    '--resume',
    session.providerSessionId,
  ]);
  assert.deepEqual(buildDoctorLaunch('codex', 'follow up', config, {}, session).args, [
    'exec',
    'resume',
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    session.providerSessionId,
    '-',
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
  assert.match(html, /id="doctor-composer"/);
  assert.match(html, /\/doctor\/message/);
  assert.match(html, /Signed execution identity verified/);
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

test('redacts execution tokens even when stdout splits the secret across chunks', () => {
  const secret = 'signed-token-that-must-never-reach-the-dashboard';
  let output = '';
  const redactor = createSecretRedactor([secret], text => output += text);
  redactor.write(`before ${secret.slice(0, 17)}`);
  assert.equal(output, 'before ');
  redactor.write(`${secret.slice(17)} after`);
  redactor.flush();
  assert.equal(output, 'before [REDACTED] after');
  assert.doesNotMatch(output, /signed-token/);
});

test('plugin explicitly declares the privileged execution-token capability', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin.json'), 'utf8'));
  assert.ok(manifest.permissions.some(permission =>
    permission.kind === 'os' && permission.target === 'issue-system-execution-token'));
});

test('Doctor verifies a fresh execution identity and resumes the exact Claude session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-doctor-conversation-'));
  const providerScript = path.join(root, 'fake-provider.js');
  const providerShim = path.join(root, 'fake-claude.cmd');
  fs.writeFileSync(providerScript, `
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  console.log('MODE ' + (args.includes('--resume') ? 'resume' : 'initial'));
  console.log('SIGNED ' + Boolean(process.env.REDLEAF_EXECUTION_TOKEN));
  console.log('RAW ' + process.env.REDLEAF_EXECUTION_TOKEN);
  console.log('PROMPT ' + input.split('\\n')[0]);
});
`);
  fs.writeFileSync(providerShim, `@echo off\r\n"${process.execPath}" "${providerScript}" %*\r\n`);

  let requestedIdentity = null;
  const broker = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/extensions/doctor/execution-token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      requestedIdentity = JSON.parse(body);
      assert.equal(req.headers['x-doctor-control'], 'c'.repeat(64));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        accessToken: 'signed-test-token-'.padEnd(64, 't'),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/auth/execution-context') {
      assert.match(req.headers.authorization || '', /^Bearer signed-test-token-/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tokenUse: 'execution',
        identity: {
          app: { id: 'doctor' },
          actor: { id: `doctor-${requestedIdentity.provider}` },
          beneficiary: { kind: 'system' },
          context: [{ kind: 'doctor-session', id: requestedIdentity.sessionId }],
        },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve));
  const brokerPort = broker.address().port;
  const doctorPort = 20000 + Math.floor(Math.random() * 1000);
  const runtimeConfig = {
    port: doctorPort,
    bindAddress: '127.0.0.1',
    runtimeVersion: 'conversation-test',
    configRevision: 1,
    authToken: 'a'.repeat(64),
    controlKey: 'c'.repeat(64),
    doctorProvider: 'claude',
    paths: { redleafRoot: root, claudeCli: providerShim },
    tunnel: { enabled: false },
    services: { redleaf: { port: brokerPort } },
  };
  const child = spawn(process.execPath, [path.join(__dirname, 'leaf-doctor.js'), '--config-stdin'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(runtimeConfig));

  const waitForStatus = async predicate => {
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${doctorPort}/doctor/status`, {
          headers: { Cookie: `leaf_doctor_session=${runtimeConfig.authToken}` },
        });
        if (response.ok) {
          const status = await response.json();
          if (predicate(status)) return status;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for Doctor conversation state');
  };

  try {
    await waitForStatus(status => status.running === false);
    const headers = {
      Cookie: `leaf_doctor_session=${runtimeConfig.authToken}`,
      'Content-Type': 'application/json',
    };
    const start = await fetch(`http://127.0.0.1:${doctorPort}/doctor?provider=claude`, {
      method: 'POST', headers,
    });
    assert.equal((await start.json()).credentialState, 'verified');
    let status = await waitForStatus(value => value.turnCount === 1 && !value.running);
    assert.equal(status.credentialState, 'verified');
    assert.match(status.outputSoFar, /MODE initial/);
    assert.match(status.outputSoFar, /SIGNED true/);
    assert.match(status.outputSoFar, /RAW \[REDACTED\]/);
    assert.doesNotMatch(status.outputSoFar, /signed-test-token/);
    assert.equal(status.canMessage, true);

    const followUp = await fetch(`http://127.0.0.1:${doctorPort}/doctor/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'The issue is the missing callback. Check that path.' }),
    });
    assert.equal((await followUp.json()).credentialState, 'verified');
    status = await waitForStatus(value => value.turnCount === 2 && !value.running);
    assert.match(status.outputSoFar, /MODE resume/);
    assert.match(status.outputSoFar, /The issue is the missing callback/);
    assert.equal(status.conversationId, requestedIdentity.sessionId);
  } finally {
    try {
      await fetch(`http://127.0.0.1:${doctorPort}/internal/shutdown`, {
        method: 'POST', headers: { 'X-Doctor-Control': runtimeConfig.controlKey },
      });
    } catch {}
    await new Promise(resolve => broker.close(resolve));
    if (!child.killed) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
