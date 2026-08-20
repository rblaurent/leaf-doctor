const http = require('http');
const net = require('net');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');

function loadRuntimeConfig(argv = process.argv.slice(2)) {
  if (argv.includes('--config-stdin')) {
    const value = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
    if (!value.trim()) throw new Error('Doctor received an empty startup configuration');
    return JSON.parse(value);
  }

  const configuredPath = process.env.LEAF_DOCTOR_CONFIG;
  const configPath = configuredPath ? path.resolve(configuredPath) : CONFIG_PATH;
  if (!fs.existsSync(configPath)) {
    throw new Error(`Doctor configuration not found at ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function normalizeConfig(value) {
  const next = value && typeof value === 'object' ? value : {};
  next.port = Number(next.port || 18899);
  next.bindAddress = next.bindAddress || '127.0.0.1';
  next.runtimeVersion = next.runtimeVersion || 'development';
  next.configRevision = Number(next.configRevision || 1);
  next.paths = next.paths || {};
  next.tunnel = next.tunnel || { enabled: false };
  next.services = next.services || {};
  const apiChecks = next.services.api?.checks;
  if (Array.isArray(apiChecks)) {
    next.services.api.checks = apiChecks.map(check =>
      check?.path === '/ai-session/quality-modes'
        ? { ...check, name: 'Discovery API', path: '/discover' }
        : check
    );
  }
  if (!next.authToken) next.authToken = crypto.randomBytes(32).toString('hex');
  if (!next.controlKey) next.controlKey = crypto.randomBytes(32).toString('hex');
  return next;
}

let config = normalizeConfig(loadRuntimeConfig());
let tunnelProc = null;
let suppressTunnelRestart = false;

const DOCTOR_PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    args: ['--print', '--dangerously-skip-permissions'],
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--color', 'never', '-'],
  },
};

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return null;
}

function checkAuth(req, url) {
  const queryToken = url.searchParams.get('token');
  const sessionToken = cookieValue(req, 'leaf_doctor_session');
  return safeEqual(queryToken, config.authToken) || safeEqual(sessionToken, config.authToken);
}

function isLoopback(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function checkControl(req) {
  return isLoopback(req) && safeEqual(req.headers['x-doctor-control'], config.controlKey);
}

function sessionCookie(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const secure = forwarded === 'https' ? '; Secure' : '';
  return `leaf_doctor_session=${encodeURIComponent(config.authToken)}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

function loginPage(message = '') {
  const escaped = String(message).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leaf Doctor</title><style>
  :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#101214;color:#f5f5f4}.card{width:min(26rem,calc(100vw - 2rem));padding:1.5rem;border:1px solid #34383d;border-radius:12px;background:#191c20;box-sizing:border-box}h1{margin:0 0 .4rem;font-size:1.2rem}p{color:#aeb4bb;font-size:.85rem;line-height:1.5}.error{color:#fb7185}input,button{width:100%;height:2.5rem;border-radius:7px;box-sizing:border-box}input{margin:.75rem 0;padding:0 .75rem;border:1px solid #454b52;background:#111315;color:inherit}button{border:0;background:#ef4444;color:white;font-weight:650;cursor:pointer}</style></head><body><form class="card" method="post" action="/session"><h1>Leaf Doctor</h1><p>Enter the recovery access token configured in RedLeaf.</p>${escaped ? `<p class="error">${escaped}</p>` : ''}<input name="token" type="password" autocomplete="current-password" autofocus required><button type="submit">Open Doctor</button></form></body></html>`;
}

function ping(port, pingPath, timeout = 5000) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}${pingPath}`, { timeout }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function pingAlive(port, pingPath, timeout = 5000) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}${pingPath}`, { timeout }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function exec(cmd, opts = {}) {
  try {
    return { ok: true, output: execSync(cmd, { encoding: 'utf8', timeout: 30000, ...opts }).trim() };
  } catch (e) {
    return { ok: false, output: e.stderr?.trim() || e.message };
  }
}

function checkPostgres(port) {
  return new Promise(resolve => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 3000 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function getStatus() {
  const svc = config.services;
  const [redleaf, redcompute, nova, codered] = await Promise.all([
    ping(svc.redleaf.port, svc.redleaf.pingPath),
    ping(svc.redcompute.port, svc.redcompute.pingPath),
    ping(svc.nova.port, svc.nova.pingPath),
    pingAlive(svc.codered.port, svc.codered.pingPath),
  ]);

  const apiChecks = svc.api?.checks || [];
  const apiResults = await Promise.all(
    apiChecks.map(c => ping(svc.api.port, c.path).then(up => ({ name: c.name, up })))
  );
  const apisOk = apiResults.length === 0 || apiResults.every(r => r.up);

  const pgPort = svc.postgres.port || 18832;
  const postgres = await checkPostgres(pgPort);

  const cfResult = exec('tasklist /FI "IMAGENAME eq cloudflared.exe" /NH');
  const tunnelRunning = cfResult.ok && cfResult.output.includes('cloudflared');

  return {
    timestamp: new Date().toISOString(),
    services: {
      postgres: { up: postgres, port: pgPort },
      redleaf: { up: redleaf, port: svc.redleaf.port },
      redcompute: { up: redcompute, port: svc.redcompute.port },
      codered: { up: codered },
      nova: { up: nova },
      apis: { up: apisOk, checks: apiResults },
      tunnel: { up: tunnelRunning },
    },
    allHealthy: postgres && redleaf && redcompute && nova && codered && apisOk,
  };
}

async function diagnose() {
  const report = [];
  const svc = config.services;

  report.push('=== LEAF DOCTOR DIAGNOSTIC REPORT ===');
  report.push(`Timestamp: ${new Date().toISOString()}`);
  report.push('');

  // PostgreSQL (managed child process of RedLeaf)
  report.push('--- PostgreSQL ---');
  const pgPort = svc.postgres.port || 18832;
  const pgProc = exec(`tasklist /FI "IMAGENAME eq ${svc.postgres.process || 'postgres.exe'}" /NH`);
  const pgProcessRunning = pgProc.ok && pgProc.output.includes('postgres');
  const pgListening = await checkPostgres(pgPort);
  if (!pgProcessRunning) {
    report.push(`DOWN: postgres.exe not running (managed by RedLeaf, starts automatically)`);
    report.push('FIX: Restart RedLeaf — it will spawn Postgres on boot');
  } else if (!pgListening) {
    report.push(`WARNING: postgres.exe running but not accepting connections on port ${pgPort}`);
  } else {
    report.push(`OK: Running and accepting connections on port ${pgPort}`);
  }
  report.push('');

  // RedLeaf
  report.push('--- RedLeaf (kernel) ---');
  const rlProc = exec('tasklist /FI "IMAGENAME eq RedLeaf.exe" /NH');
  const rlRunning = rlProc.ok && rlProc.output.includes('RedLeaf');
  const rlResponding = await ping(svc.redleaf.port, svc.redleaf.pingPath);
  if (!rlRunning) {
    report.push('CRITICAL: Process not running');
    const exeExists = fs.existsSync(config.paths.redleafExe);
    report.push(exeExists ? `Exe found at ${config.paths.redleafExe}` : 'WARNING: Exe not found, rebuild needed');
  } else if (!rlResponding) {
    report.push('WARNING: Process running but not responding on port ' + svc.redleaf.port);
    report.push('Possible: still starting, or hung');
  } else {
    report.push('OK: Running and responding');
  }
  report.push('');

  // RedCompute
  report.push('--- RedCompute ---');
  const rcProc = exec('tasklist /FI "IMAGENAME eq RedCompute.exe" /NH');
  const rcRunning = rcProc.ok && rcProc.output.includes('RedCompute');
  const rcResponding = await ping(svc.redcompute.port, svc.redcompute.pingPath);
  if (!rcRunning) {
    report.push('DOWN: Process not running (managed by RedLeaf, starts automatically)');
  } else if (!rcResponding) {
    report.push('WARNING: Process running but not responding');
  } else {
    report.push('OK: Running and responding');
  }
  report.push('');

  // Nova
  report.push('--- Nova ---');
  const novaUp = await ping(svc.nova.port, svc.nova.pingPath);
  report.push(novaUp ? 'OK: Plugin responding' : 'DOWN: Plugin not responding (requires RedLeaf)');
  report.push('');

  // CodeRed
  report.push('--- CodeRed ---');
  const crUp = await pingAlive(svc.codered.port, svc.codered.pingPath);
  report.push(crUp ? `OK: Responding on port ${svc.codered.port}` : `DOWN: Not responding on port ${svc.codered.port}`);
  report.push('');

  // API Validation
  report.push('--- API Health ---');
  const apiChecks = svc.api?.checks || [];
  for (const check of apiChecks) {
    const up = await ping(svc.api.port, check.path);
    report.push(`${up ? 'OK' : 'FAIL'}: ${check.name} (${check.path})`);
  }
  report.push('');

  // CF Tunnel
  report.push('--- Cloudflare Tunnel ---');
  const cfProc = exec('tasklist /FI "IMAGENAME eq cloudflared.exe" /NH');
  const cfRunning = cfProc.ok && cfProc.output.includes('cloudflared');
  report.push(cfRunning ? 'OK: cloudflared running' : 'DOWN: No cloudflared process (starts with RedLeaf)');
  report.push('');

  // System
  report.push('--- System ---');

  const driveNames = new Set([
    path.parse(process.env.SystemDrive || 'C:').name.replace(':', ''),
    path.parse(config.paths.redleafRoot || config.paths.redleafExe || '').root.replace(/[\\:]/g, ''),
  ].filter(Boolean));
  for (const drive of driveNames) {
    const disk = exec(`powershell -NoProfile -Command "(Get-PSDrive ${drive} -ErrorAction SilentlyContinue).Free / 1GB"`);
    if (disk.ok && disk.output) report.push(`${drive}: drive free: ${parseFloat(disk.output).toFixed(1)} GB`);
  }

  report.push('');
  report.push('=== END REPORT ===');

  return report.join('\n');
}

async function restart({ rebuild = true } = {}) {
  const steps = [];
  const svc = config.services;

  // Step 1: Rebuild and restart via rebuild.ps1 (handles stop, build, relaunch)
  if (rebuild) {
    const rebuildScript = config.paths.rebuildScript;
    if (!rebuildScript || !fs.existsSync(rebuildScript)) {
      steps.push('CRITICAL: No valid developer rebuild script is configured in Doctor extension settings.');
      steps.push('Use a quick restart or configure the workspace rebuild script in RedLeaf.');
      return { success: false, steps };
    }

    steps.push(`Running full rebuild (${rebuildScript})...`);
    const buildResult = exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${rebuildScript}"`,
      { timeout: 300000 }
    );
    if (!buildResult.ok) {
      steps.push(`BUILD FAILED: ${buildResult.output}`);
      steps.push('Aborting — the old binary is safer than a failed build.');
      steps.push('Fix the build errors and retry, or restart with rebuild=false for a quick process bounce.');
      return { success: false, steps };
    }
    steps.push('Rebuild succeeded (frontend + backend + relaunch)');
  } else {
    // Quick bounce: just kill and relaunch
    steps.push('Rebuild skipped (rebuild=false), quick process bounce');

    const rlProc = exec('tasklist /FI "IMAGENAME eq RedLeaf.exe" /NH');
    if (rlProc.ok && rlProc.output.includes('RedLeaf')) {
      steps.push('Stopping RedLeaf...');
      exec('taskkill /IM RedLeaf.exe /F');
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!fs.existsSync(config.paths.redleafExe)) {
      steps.push(`CRITICAL: RedLeaf exe not found at ${config.paths.redleafExe}`);
      return { success: false, steps };
    }

    steps.push('Starting RedLeaf...');
    const rl = spawn(config.paths.redleafExe, [], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(config.paths.redleafExe),
    });
    rl.unref();
    steps.push(`RedLeaf spawned (PID ${rl.pid})`);
  }

  // Step 5: Wait for RedLeaf to respond
  steps.push('Waiting for RedLeaf to come online...');
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (await ping(svc.redleaf.port, svc.redleaf.pingPath)) {
      ready = true;
      break;
    }
  }
  steps.push(ready ? 'RedLeaf is online' : 'TIMEOUT: RedLeaf did not respond within 60s');

  // Step 6: Wait for RedCompute (managed by RedLeaf)
  if (ready) {
    steps.push('Waiting for RedCompute...');
    let rcReady = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      if (await ping(svc.redcompute.port, svc.redcompute.pingPath)) {
        rcReady = true;
        break;
      }
    }
    steps.push(rcReady ? 'RedCompute is online' : 'WARNING: RedCompute did not respond within 30s');
  }

  // Step 7: Verify Nova
  if (ready) {
    await new Promise(r => setTimeout(r, 5000));
    const novaUp = await ping(svc.nova.port, svc.nova.pingPath);
    steps.push(novaUp ? 'Nova is online' : 'WARNING: Nova plugin not responding');
  }

  // If restart failed, offer to escalate to a coding-agent doctor session.
  if (!ready) {
    steps.push('');
    steps.push('ESCALATION: Simple restart failed. Use a Doctor button to spawn an AI coding session for deep diagnosis.');
  }

  return { success: ready, steps };
}

let doctorConversation = null;

function resolveDoctorCommand(provider, runtimeConfig = config, environment = process.env) {
  const configuredPath = runtimeConfig.paths?.[`${provider.id}Cli`];
  if (configuredPath) return configuredPath;

  if (process.platform === 'win32' && environment.APPDATA) {
    const npmShim = path.join(environment.APPDATA, 'npm', `${provider.command}.cmd`);
    if (fs.existsSync(npmShim)) return npmShim;
  }

  return provider.command;
}

function buildDoctorLaunch(
  providerId,
  fullPrompt,
  runtimeConfig = config,
  environment = process.env,
  session = {},
) {
  const provider = DOCTOR_PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Unsupported doctor provider '${providerId}'. Use claude or codex.`);
  }

  const dangerous = runtimeConfig.dangerousPermissions !== false;
  let args;
  if (providerId === 'claude') {
    args = ['--print'];
    if (dangerous) args.push('--dangerously-skip-permissions');
    if (session.resume) args.push('--resume', session.providerSessionId);
    else if (session.providerSessionId) args.push('--session-id', session.providerSessionId);
  } else {
    args = ['exec'];
    if (session.resume) args.push('resume');
    if (dangerous) args.push('--dangerously-bypass-approvals-and-sandbox');
    args.push('--json');
    if (session.resume) args.push(session.providerSessionId);
    args.push('-');
  }
  return {
    provider,
    command: resolveDoctorCommand(provider, runtimeConfig, environment),
    args,
    cwd: runtimeConfig.paths?.redleafRoot || path.dirname(runtimeConfig.paths?.redleafExe || process.cwd()),
    stdin: fullPrompt,
  };
}

function doctorBrokerUrl(pathname) {
  const port = Number(config.services?.redleaf?.port || 18804);
  return `http://127.0.0.1:${port}${pathname}`;
}

async function acquireExecutionIdentity(sessionId, providerId) {
  let response;
  try {
    response = await fetch(doctorBrokerUrl('/api/extensions/doctor/execution-token'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Doctor-Control': config.controlKey,
      },
      body: JSON.stringify({ sessionId, provider: providerId }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (error) {
    return { state: 'unavailable', detail: error.message };
  }

  // A stopped kernel or an older kernel without the broker must not make emergency filesystem
  // recovery impossible. In that case we launch without a bearer and say so explicitly.
  if (response.status === 404 || response.status === 503)
    return { state: 'unavailable', detail: `Token broker returned ${response.status}` };
  if (!response.ok)
    throw new Error(`Doctor execution-token broker rejected the request (${response.status})`);

  const issued = await response.json();
  if (typeof issued.accessToken !== 'string' || issued.accessToken.length < 32)
    throw new Error('Doctor execution-token broker returned no signed bearer');
  const expiresAt = Date.parse(issued.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000)
    throw new Error('Doctor execution-token broker returned an expired or near-expiry bearer');

  const verification = await fetch(doctorBrokerUrl('/auth/execution-context'), {
    headers: { Authorization: `Bearer ${issued.accessToken}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!verification.ok)
    throw new Error(`RedLeaf rejected the newly issued Doctor bearer (${verification.status})`);
  const context = await verification.json();
  const identity = context.identity;
  const hasSessionContext = Array.isArray(identity?.context)
    && identity.context.some(item => item.kind === 'doctor-session' && item.id === sessionId);
  if (context.tokenUse !== 'execution'
      || identity?.app?.id !== 'doctor'
      || identity?.actor?.id !== `doctor-${providerId}`
      || identity?.beneficiary?.kind !== 'system'
      || !hasSessionContext) {
    throw new Error('RedLeaf returned a signed bearer with the wrong Doctor execution identity');
  }

  return { state: 'verified', accessToken: issued.accessToken, expiresAt: issued.expiresAt };
}

function credentialNotice(credential) {
  if (credential.state === 'verified') {
    return 'A fresh signed Doctor execution token was verified against RedLeaf and is available in REDLEAF_EXECUTION_TOKEN for this turn. Never print, log, persist, or forward it. Send it only as a Bearer token to trusted loopback RedLeaf or RedCompute endpoints.';
  }
  return 'RedLeaf could not mint a signed execution token for this turn. REDLEAF_EXECUTION_TOKEN is deliberately absent. Limit yourself to public liveness/discovery, local files, logs, and process recovery. Do not call protected APIs or claim authenticated verification. After RedLeaf is restored, the next Doctor message will acquire a fresh token.';
}

function appendConversationOutput(conversation, text) {
  if (!text) return;
  conversation.output.push(text);
}

function createSecretRedactor(secrets, emit) {
  const values = secrets.filter(value => typeof value === 'string' && value.length > 0);
  let pending = '';

  const replace = text => {
    let result = text;
    for (const secret of values) result = result.split(secret).join('[REDACTED]');
    return result;
  };

  const write = chunk => {
    pending += String(chunk || '');
    if (!values.length) {
      emit(pending);
      pending = '';
      return;
    }

    pending = replace(pending);
    let held = 0;
    for (const secret of values) {
      const max = Math.min(secret.length - 1, pending.length);
      for (let length = max; length > held; length--) {
        if (pending.endsWith(secret.slice(0, length))) {
          held = length;
          break;
        }
      }
    }
    const safeLength = pending.length - held;
    if (safeLength > 0) emit(pending.slice(0, safeLength));
    pending = pending.slice(safeLength);
  };

  const flush = () => {
    if (pending) emit(replace(pending));
    pending = '';
  };
  return { write, flush };
}

function codexItemText(item, property) {
  const value = item?.[property];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(part => typeof part === 'string' ? part : part?.text || '')
      .filter(Boolean).join('\n\n');
  }
  return '';
}

function consumeCodexEvent(conversation, line) {
  let event;
  try { event = JSON.parse(line); }
  catch {
    appendConversationOutput(conversation, line + '\n');
    return;
  }

  if (event.type === 'thread.started') {
    const threadId = event.thread_id || event.threadId;
    if (threadId) conversation.providerSessionId = threadId;
    return;
  }

  const item = event.item || {};
  const itemType = String(item.type || '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  if (event.type === 'item.started' && itemType === 'commandExecution') {
    appendConversationOutput(conversation, `\n$ ${item.command || 'command'}\n`);
    return;
  }
  if (event.type === 'item.completed') {
    if (itemType === 'agentMessage') {
      appendConversationOutput(conversation, `${codexItemText(item, 'text')}\n`);
    } else if (itemType === 'commandExecution') {
      const output = item.aggregated_output || item.aggregatedOutput || '';
      if (output) appendConversationOutput(conversation, output.endsWith('\n') ? output : output + '\n');
    } else if (itemType === 'fileChange') {
      const paths = Array.isArray(item.changes)
        ? item.changes.map(change => change.path).filter(Boolean) : [];
      if (paths.length) appendConversationOutput(conversation, `Changed: ${paths.join(', ')}\n`);
    }
    return;
  }
  if (event.type === 'turn.failed') {
    appendConversationOutput(conversation, `\nTurn failed: ${event.error?.message || event.message || 'unknown error'}\n`);
  }
}

async function executeDoctorTurn(conversation, prompt, resume) {
  conversation.running = true;
  conversation.lastExitCode = null;
  conversation.credentialState = 'checking';

  let credential;
  try {
    credential = await acquireExecutionIdentity(conversation.id, conversation.provider.id);
  } catch (error) {
    conversation.running = false;
    conversation.credentialState = 'rejected';
    appendConversationOutput(conversation, `\n--- Credential error: ${error.message} ---\n`);
    return { status: 'error', message: error.message };
  }
  conversation.credentialState = credential.state;

  const turnPrompt = `${prompt}\n\nExecution identity for this turn:\n${credentialNotice(credential)}`;
  let launch;
  try {
    launch = buildDoctorLaunch(
      conversation.provider.id,
      turnPrompt,
      config,
      process.env,
      { resume, providerSessionId: conversation.providerSessionId },
    );
  } catch (error) {
    conversation.running = false;
    return { status: 'error', message: error.message };
  }

  const childEnvironment = { ...process.env };
  delete childEnvironment.REDLEAF_EXECUTION_TOKEN;
  if (credential.state === 'verified')
    childEnvironment.REDLEAF_EXECUTION_TOKEN = credential.accessToken;

  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnvironment,
    shell: true,
    timeout: 300000,
  });
  conversation.child = child;
  conversation.turnCount += 1;

  let codexBuffer = '';
  const consumeStdout = text => {
    if (conversation.provider.id !== 'codex') {
      appendConversationOutput(conversation, text);
      return;
    }
    codexBuffer += text;
    const lines = codexBuffer.split(/\r?\n/);
    codexBuffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) consumeCodexEvent(conversation, line);
  };
  const secrets = credential.state === 'verified' ? [credential.accessToken] : [];
  const stdoutRedactor = createSecretRedactor(secrets, consumeStdout);
  const stderrRedactor = createSecretRedactor(
    secrets,
    text => appendConversationOutput(conversation, text),
  );
  child.stdout.on('data', data => stdoutRedactor.write(data.toString()));
  child.stderr.on('data', data => stderrRedactor.write(data.toString()));

  const complete = code => {
    if (!conversation.running) return;
    stdoutRedactor.flush();
    stderrRedactor.flush();
    if (codexBuffer.trim()) consumeCodexEvent(conversation, codexBuffer);
    conversation.running = false;
    conversation.child = null;
    conversation.lastExitCode = code;
    conversation.completedAt = new Date().toISOString();
    if (!conversation.providerSessionId)
      appendConversationOutput(conversation, '\n--- Session identity was not reported; continuation is unavailable. ---\n');
    appendConversationOutput(conversation, `\n--- Doctor turn exited with code ${code} ---`);
    console.log(`${launch.provider.label} doctor turn exited with code ${code}`);
  };

  child.on('exit', complete);
  child.on('error', error => {
    appendConversationOutput(conversation, `\n--- Doctor turn error: ${error.message} ---\n`);
    complete(-1);
  });
  child.stdin.on('error', error => {
    appendConversationOutput(conversation, `\n--- Doctor prompt input error: ${error.message} ---\n`);
  });
  child.stdin.end(launch.stdin);

  return {
    status: 'started',
    provider: launch.provider.id,
    providerLabel: launch.provider.label,
    conversationId: conversation.id,
    credentialState: conversation.credentialState,
    message: `${launch.provider.label} Doctor turn started.`,
  };
}

async function runDoctor(providerId = config.doctorProvider || 'claude') {
  if (doctorConversation?.running) {
    return {
      status: 'already_running',
      provider: doctorConversation.provider.id,
      providerLabel: doctorConversation.provider.label,
      message: `A ${doctorConversation.provider.label} Doctor turn is already in progress.`,
    };
  }

  // Resolve against __dirname, not cwd -- the doctor is spawned detached and can
  // inherit an arbitrary working directory from whatever started it.
  const promptPath = path.resolve(__dirname, config.paths.doctorPrompt || 'doctor-prompt.md');
  if (!fs.existsSync(promptPath)) {
    return { status: 'error', message: `Doctor prompt not found at ${promptPath}` };
  }

  const prompt = fs.readFileSync(promptPath, 'utf8');
  const recoveryContext = {
    paths: config.paths,
    services: config.services,
    runtimeVersion: config.runtimeVersion,
  };
  const fullPrompt = `${prompt}\n\nRuntime context supplied by Doctor extension settings:\n${JSON.stringify(recoveryContext, null, 2)}\n\nDiagnose and fix the Leaf suite now. Run the diagnostic procedure, fix any issues found, and verify all services are running. Report everything you do.`;

  const provider = DOCTOR_PROVIDERS[providerId];
  if (!provider)
    return { status: 'error', message: `Unsupported doctor provider '${providerId}'.` };
  const id = crypto.randomUUID();
  doctorConversation = {
    id,
    child: null,
    output: [],
    provider,
    providerSessionId: providerId === 'claude' ? id : null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    running: false,
    turnCount: 0,
    credentialState: 'checking',
    lastExitCode: null,
  };
  return executeDoctorTurn(doctorConversation, fullPrompt, false);
}

async function sendDoctorMessage(message) {
  const text = String(message || '').trim();
  if (!text) return { status: 'error', message: 'Message is required.' };
  if (text.length > 32_000) return { status: 'error', message: 'Message is too long.' };
  if (!doctorConversation) return { status: 'error', message: 'Start a Doctor session first.' };
  if (doctorConversation.running)
    return { status: 'already_running', message: 'The current Doctor turn is still running.' };
  if (!doctorConversation.providerSessionId)
    return { status: 'error', message: 'The provider did not return a resumable session identity.' };

  appendConversationOutput(
    doctorConversation,
    `\n\n--- You ---\n${text}\n\n--- ${doctorConversation.provider.label} ---\n`,
  );
  return executeDoctorTurn(doctorConversation, text, true);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);

  // Minimal unauthenticated health contract for the extension bootstrapper.
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'leaf-doctor',
      version: config.runtimeVersion,
      configRevision: config.configRevision,
      port: config.port,
    }));
    return;
  }

  // The control API is loopback-only and uses a separate installation key.
  if (url.pathname.startsWith('/internal/')) {
    if (!checkControl(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/internal/reconcile') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const next = normalizeConfig(JSON.parse(body || '{}'));
      const restartRequired = next.port !== config.port || next.bindAddress !== config.bindAddress;
      const tunnelChanged = JSON.stringify(next.tunnel) !== JSON.stringify(config.tunnel)
        || next.paths?.cloudflared !== config.paths?.cloudflared;
      config = next;
      if (tunnelChanged && !restartRequired) restartTunnel();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, restartRequired, configRevision: config.configRevision }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/internal/shutdown') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(shutdown, 25);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  // A legacy token URL is accepted once, then exchanged for a clean cookie URL.
  if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
    if (safeEqual(url.searchParams.get('token'), config.authToken)) {
      res.writeHead(303, { 'Set-Cookie': sessionCookie(req), 'Location': '/' });
      res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage('That token is not valid.'));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/session') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(loginPage());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/session') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const contentType = String(req.headers['content-type'] || '');
    let token = '';
    if (contentType.includes('application/json')) {
      try { token = JSON.parse(body).token || ''; } catch {}
    } else {
      token = new URLSearchParams(body).get('token') || '';
    }
    if (!safeEqual(token, config.authToken)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage('That token is not valid.'));
      return;
    }
    res.writeHead(303, { 'Set-Cookie': sessionCookie(req), 'Location': '/' });
    res.end();
    return;
  }

  if (!checkAuth(req, url)) {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage());
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(DASHBOARD_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const status = await getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/diagnose') {
      const report = await diagnose();
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(report);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/restart') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let opts = {};
      if (body) {
        try { opts = JSON.parse(body); } catch {}
      }
      const rebuildParam = url.searchParams.get('rebuild');
      if (rebuildParam !== null) {
        opts.rebuild = rebuildParam !== 'false';
      }
      const rebuild = Object.hasOwn(opts, 'rebuild')
        ? opts.rebuild !== false
        : config.rebuildByDefault === true;
      const result = await restart({ rebuild });
      if (!result.success) {
        result.doctorAvailable = true;
        result.doctorHint = 'Restart failed. Choose Claude Code or Codex Doctor for deep diagnosis.';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/doctor') {
      const providerId = url.searchParams.get('provider') || config.doctorProvider || 'claude';
      const result = await runDoctor(providerId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/doctor/message') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 40_000) throw new Error('Doctor message body is too large');
      }
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { throw new Error('Doctor message body must be valid JSON'); }
      const result = await sendDoctorMessage(payload.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/doctor/status') {
      if (!doctorConversation) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: false, canMessage: false }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        running: doctorConversation.running,
        canMessage: !doctorConversation.running && !!doctorConversation.providerSessionId,
        conversationId: doctorConversation.id,
        startedAt: doctorConversation.startedAt,
        completedAt: doctorConversation.completedAt,
        provider: doctorConversation.provider.id,
        providerLabel: doctorConversation.provider.label,
        providerSessionIdAvailable: !!doctorConversation.providerSessionId,
        turnCount: doctorConversation.turnCount,
        credentialState: doctorConversation.credentialState,
        exitCode: doctorConversation.lastExitCode,
        outputSoFar: doctorConversation.output.join(''),
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    console.error('Request error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Tunnel management
function startTunnel() {
  if (!config.tunnel.enabled) {
    console.log('Tunnel disabled');
    return;
  }

  const cfPath = config.paths.cloudflared || 'cloudflared';
  if (path.isAbsolute(cfPath) && !fs.existsSync(cfPath)) {
    console.error(`cloudflared not found at ${cfPath}`);
    return;
  }

  const args = config.tunnel.configFile
    ? ['tunnel', '--config', config.tunnel.configFile, 'run']
    : ['tunnel', 'run', '--token', config.tunnel.token];
  if (!config.tunnel.configFile && !config.tunnel.token) {
    console.error('Cloudflare Tunnel is enabled but no token or config file is configured');
    return;
  }

  console.log('Starting doctor tunnel...');
  tunnelProc = spawn(cfPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tunnelProc.stdout.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[tunnel] ${line}`);
  });
  tunnelProc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[tunnel] ${line}`);
  });
  tunnelProc.on('exit', (code) => {
    console.log(`Tunnel exited with code ${code}`);
    tunnelProc = null;
    if (config.tunnel.enabled && !suppressTunnelRestart) {
      console.log('Restarting tunnel in 10s...');
      setTimeout(startTunnel, 10000);
    }
  });
}

function restartTunnel() {
  suppressTunnelRestart = true;
  if (tunnelProc) {
    tunnelProc.kill();
    tunnelProc = null;
  }
  setTimeout(() => {
    suppressTunnelRestart = false;
    startTunnel();
  }, 100);
}

function shutdown() {
  console.log('Shutting down...');
  if (tunnelProc) {
    tunnelProc.kill();
    tunnelProc = null;
  }
  server.close(() => process.exit(0));
}

if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(config.port, config.bindAddress, () => {
    console.log(`Leaf Doctor running on port ${config.port}`);
    console.log(`Dashboard: http://127.0.0.1:${config.port}/`);
    startTunnel();
  });
}

module.exports = {
  DOCTOR_PROVIDERS,
  buildDoctorLaunch,
  checkControl,
  createSecretRedactor,
  loadRuntimeConfig,
  normalizeConfig,
  resolveDoctorCommand,
};
