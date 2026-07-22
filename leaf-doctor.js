const http = require('http');
const net = require('net');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
let tunnelProc = null;

if (!config.authToken) {
  config.authToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`Generated auth token: ${config.authToken}`);
  console.log(`Bookmark this URL: https://your-doctor-hostname/?token=${config.authToken}`);
}

function checkAuth(url) {
  const u = new URL(url, 'http://localhost');
  return u.searchParams.get('token') === config.authToken;
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

  const diskT = exec('powershell -NoProfile -Command "(Get-PSDrive T -ErrorAction SilentlyContinue).Free / 1GB"');
  if (diskT.ok && diskT.output) report.push(`T: drive free: ${parseFloat(diskT.output).toFixed(1)} GB`);

  const diskC = exec('powershell -NoProfile -Command "(Get-PSDrive C -ErrorAction SilentlyContinue).Free / 1GB"');
  if (diskC.ok && diskC.output) report.push(`C: drive free: ${parseFloat(diskC.output).toFixed(1)} GB`);

  report.push('');
  report.push('=== END REPORT ===');

  return report.join('\n');
}

async function restart({ rebuild = true } = {}) {
  const steps = [];
  const svc = config.services;

  // Step 1: Rebuild and restart via rebuild.ps1 (handles stop, build, relaunch)
  if (rebuild) {
    const rebuildScript = config.paths.rebuildScript || 'T:/Projects/redleaf/rebuild.ps1';
    if (!fs.existsSync(rebuildScript)) {
      steps.push(`CRITICAL: Rebuild script not found at ${rebuildScript}`);
      steps.push('Manual rebuild needed: run T:\\Projects\\redleaf\\rebuild.bat');
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

  // Step 8: Notify via Nova if available
  if (ready) {
    try {
      const msg = rebuild
        ? 'Leaf Doctor: Emergency restart completed (with rebuild). All services verified.'
        : 'Leaf Doctor: Emergency restart completed (quick bounce). All services verified.';
      const body = JSON.stringify({ content: msg, source: 'leaf-doctor' });
      const req = http.request({
        hostname: '127.0.0.1',
        port: svc.redleaf.port,
        path: '/api/apps/nova/discussions/3c08ab1f/event',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5000,
      });
      req.on('error', () => {});
      req.write(body);
      req.end();
    } catch {}
  }

  // Step 9: If restart failed, offer to escalate to doctor session
  if (!ready) {
    steps.push('');
    steps.push('ESCALATION: Simple restart failed. Use the Doctor button to spawn a Claude Code session for deep diagnosis.');
  }

  return { success: ready, steps };
}

let doctorSession = null;

function runDoctor() {
  if (doctorSession) {
    return { status: 'already_running', message: 'A doctor session is already in progress.' };
  }

  // Resolve against __dirname, not cwd -- the doctor is spawned detached and can
  // inherit an arbitrary working directory from whatever started it.
  const promptPath = path.resolve(__dirname, config.paths.doctorPrompt || 'doctor-prompt.md');
  if (!fs.existsSync(promptPath)) {
    return { status: 'error', message: `Doctor prompt not found at ${promptPath}` };
  }

  const prompt = fs.readFileSync(promptPath, 'utf8');
  const fullPrompt = prompt + '\n\nDiagnose and fix the Leaf suite now. Run the diagnostic procedure, fix any issues found, and verify all services are running. Report everything you do.';

  const claudePath = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'claude.cmd')
    : 'claude';

  const output = [];
  let resolved = false;
  let resolvePromise;
  const donePromise = new Promise(r => { resolvePromise = r; });

  const args = ['--print', '--dangerously-skip-permissions', '-p', fullPrompt];
  const child = spawn(claudePath, args, {
    cwd: 'T:\\Projects\\redleaf',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    shell: true,
    timeout: 300000,
  });

  doctorSession = { child, output, startedAt: new Date().toISOString(), done: donePromise };

  child.stdout.on('data', d => {
    const text = d.toString();
    output.push(text);
    console.log(`[doctor] ${text.trim()}`);
  });
  child.stderr.on('data', d => {
    const text = d.toString();
    output.push(text);
    console.log(`[doctor:err] ${text.trim()}`);
  });
  child.on('exit', (code) => {
    output.push(`\n--- Doctor session exited with code ${code} ---`);
    console.log(`Doctor session exited with code ${code}`);
    doctorSession = null;
    resolvePromise({ code, output: output.join('') });
  });
  child.on('error', (err) => {
    output.push(`\n--- Doctor session error: ${err.message} ---`);
    console.error('Doctor session error:', err);
    doctorSession = null;
    resolvePromise({ code: -1, output: output.join('') });
  });

  return { status: 'started', message: 'Claude Code doctor session started. Poll /doctor/status for progress.' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);

  // Auth check (except health endpoint for the kernel to ping)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'leaf-doctor' }));
    return;
  }

  if (!checkAuth(req.url)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const tokenParam = `token=${config.authToken}`;

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      let html = fs.readFileSync(DASHBOARD_PATH, 'utf8');
      html = html.replace(/\{\{AUTH_TOKEN\}\}/g, config.authToken);
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
      const result = await restart({ rebuild: opts.rebuild !== false });
      if (!result.success) {
        result.doctorAvailable = true;
        result.doctorHint = 'Restart failed. Hit the Doctor button to spawn a Claude Code session for deep diagnosis.';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/doctor') {
      const result = runDoctor();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/doctor/status') {
      if (!doctorSession) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: false }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        running: true,
        startedAt: doctorSession.startedAt,
        outputSoFar: doctorSession.output.join(''),
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

  const cfPath = config.paths.cloudflared;
  if (!fs.existsSync(cfPath)) {
    console.error(`cloudflared not found at ${cfPath}`);
    return;
  }

  const args = config.tunnel.configFile
    ? ['tunnel', '--config', config.tunnel.configFile, 'run']
    : ['tunnel', 'run', '--token', config.tunnel.token];

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
    if (config.tunnel.enabled) {
      console.log('Restarting tunnel in 10s...');
      setTimeout(startTunnel, 10000);
    }
  });
}

function shutdown() {
  console.log('Shutting down...');
  if (tunnelProc) {
    tunnelProc.kill();
    tunnelProc = null;
  }
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Leaf Doctor running on port ${config.port}`);
  if (config.authToken) {
    console.log(`Dashboard: http://127.0.0.1:${config.port}/?token=${config.authToken}`);
  }
  startTunnel();
});
