#!/usr/bin/env node
/**
 * Task 07 independent Tier 1 runner.
 *
 * Owns ports 43261 (mock GitHub), 43262 (real-route test Worker) and 43263
 * (production-mode Worker). It builds the author client, starts the services,
 * runs `tests/author-e2e/github/independent-http.mjs` and the independent
 * Playwright spec, stops every child it started, then scans the test logs for
 * token/secret/OAuth-query leaks.
 *
 * This runner never reads `.dev.vars`; its client id/secret, session secret and
 * token key are throwaway per-run values.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanPersistDirs as cleanPersistStore } from './author-e2e/persist-dirs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const authorDir = join(root, 'apps', 'author');
// R09-19: test output goes to gitignored test-results/, never below docs_AI/记录/
// (docs_AI/记录/r07/assets/ is task 07's tracked evidence).
const assetsDir = join(root, 'test-results', 'author-github-e2e', 'independent');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const playwrightBin = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const mockServer = join(root, 'tests', 'author-e2e', 'github', 'mock-github-server.mjs');
const httpSpec = join(root, 'tests', 'author-e2e', 'github', 'independent-http.mjs');

const MOCK_PORT = 43261;
const TEST_PORT = 43262;
const PROD_PORT = 43263;
const TEST_INSPECTOR_PORT = 9233;
const PROD_INSPECTOR_PORT = 9234;
const RUN_STARTED_AT = new Date().toISOString();
const CLIENT_SECRET = 'test-client-secret';
const SESSION_SECRET = randomBytes(36).toString('base64');
const TOKEN_KEY = randomBytes(32).toString('base64');

const logs = {
  build: join(assetsDir, 'indep-github-build.log'),
  mock: join(assetsDir, 'indep-github-mock.log'),
  testWorker: join(assetsDir, 'indep-github-worker-test.log'),
  prodWorker: join(assetsDir, 'indep-github-worker-prod.log'),
  http: join(assetsDir, 'indep-github-http.log'),
  httpReport: join(assetsDir, 'indep-github-http.json'),
  playwright: join(assetsDir, 'indep-github-ui.log'),
  scan: join(assetsDir, 'indep-github-scan.json'),
  run: join(assetsDir, 'indep-github-run.json'),
};

const children = [];
let exitCode = 1;

function log(message) {
  process.stdout.write(`[indep-github] ${message}\n`);
}

function assertFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}. Run npm ci first.`);
  }
}

function openLog(path, header) {
  mkdirSync(assetsDir, { recursive: true });
  const fd = openSync(path, 'w');
  writeSync(fd, header);
  return { fd, closed: false };
}

function append(logFile, text) {
  if (logFile.closed) return;
  try {
    writeSync(logFile.fd, text);
  } catch {
    // fd already closed
  }
}

function closeLog(logFile, footer) {
  if (logFile.closed) return;
  append(logFile, footer);
  try {
    closeSync(logFile.fd);
  } catch {
    // already closed
  }
  logFile.closed = true;
}

function portIsOccupied(port) {
  return new Promise((resolvePromise) => {
    const socket = createServer();
    socket.once('error', () => resolvePromise(true));
    socket.once('listening', () => socket.close(() => resolvePromise(false)));
    socket.listen(port, '127.0.0.1');
  });
}

function startLogged(command, args, options, logPath, label) {
  const logFile = openLog(logPath, `# ${label}\ncwd: ${options.cwd}\nstarted: ${new Date().toISOString()}\n\n`);
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', logFile.fd, logFile.fd],
    windowsHide: true,
  });
  child.on('error', (error) => append(logFile, `\nprocess error: ${error.message}\n`));
  child.on('exit', (code, signal) =>
    closeLog(logFile, `\nexit code: ${code} signal: ${String(signal)} at ${new Date().toISOString()}\n`),
  );
  children.push({ child, logFile });
  return child;
}

function runLogged(command, args, options, logPath, label) {
  return new Promise((resolvePromise) => {
    const logFile = openLog(logPath, `# ${label}\ncwd: ${options.cwd}\nstarted: ${new Date().toISOString()}\n\n`);
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', logFile.fd, logFile.fd],
      windowsHide: true,
    });
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      closeLog(logFile, `\nexit code: ${code} signal: ${String(signal)} at ${new Date().toISOString()}\n`);
      resolvePromise(code ?? 1);
    };
    child.on('error', (error) => {
      append(logFile, `\nprocess error: ${error.message}\n`);
      finish(1);
    });
    child.on('exit', finish);
  });
}

async function waitForHealth(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.status === 'ok') return body;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  throw new Error(`Worker on port ${port} did not become healthy: ${lastError}`);
}

function stopChildren() {
  for (const entry of children) {
    const pid = entry.child.pid;
    if (pid && entry.child.exitCode === null) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    closeLog(entry.logFile, `\nstopped by runner at ${new Date().toISOString()}\n`);
  }
}

function testWorkerArgs(port, inspectorPort, persistDir, extraVars) {
  const args = [
    wranglerBin,
    'dev',
    '--port',
    String(port),
    '--ip',
    '127.0.0.1',
    '--inspector-port',
    String(inspectorPort),
    '--persist-to',
    persistDir,
  ];
  for (const [name, value] of Object.entries(extraVars)) {
    args.push('--var', `${name}:${value}`);
  }
  return args;
}

const SCAN_PATTERNS = [
  { name: 'github user token', pattern: /ghu_[A-Za-z0-9_]+/gu },
  { name: 'github refresh token', pattern: /ghr_[A-Za-z0-9_]+/gu },
  { name: 'client secret assignment', pattern: /client_secret\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{8,}/giu },
  { name: 'access token JSON field', pattern: /"access_token"\s*:/giu },
  { name: 'pkce verifier field', pattern: /"code_verifier"\s*:/giu },
  { name: 'oauth query code', pattern: /[?&]code=[A-Za-z0-9]/gu },
  { name: 'oauth query state', pattern: /[?&]state=[A-Za-z0-9_-]{20,}/gu },
  { name: 'private key', pattern: /BEGIN [A-Z ]*PRIVATE KEY/gu },
];

function scanLogs() {
  const files = [logs.mock, logs.testWorker, logs.prodWorker, logs.http, logs.playwright];
  const findings = [];
  const informational = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const { name, pattern } of SCAN_PATTERNS) {
      pattern.lastIndex = 0;
      const matches = [...text.matchAll(pattern)];
      if (matches.length > 0) {
        findings.push({
          file: file.split('\\').join('/').replace(`${root.split('\\').join('/')}/`, ''),
          pattern: name,
          count: matches.length,
          samples: matches.slice(0, 3).map((match) => match[0].slice(0, 40)),
        });
      }
    }
    // Wrangler prints binding names with a hidden placeholder; this is not a
    // secret value and is recorded as informational rather than a finding.
    for (const match of text.matchAll(/env\.GITHUB_APP_CLIENT_SECRET \("\(hidden\)"\)/gu)) {
      informational.push({
        file: file.split('\\').join('/').replace(`${root.split('\\').join('/')}/`, ''),
        note: 'binding name printed with (hidden) placeholder',
        count: 1,
        line: match[0],
      });
    }
    for (const secret of [SESSION_SECRET, TOKEN_KEY, CLIENT_SECRET]) {
      if (secret.length >= 8 && text.includes(secret)) {
        findings.push({
          file: file.split('\\').join('/').replace(`${root.split('\\').join('/')}/`, ''),
          pattern: 'configured secret value',
          count: 1,
          samples: ['[redacted]'],
        });
      }
    }
  }
  return {
    scannedFiles: files.filter((file) => existsSync(file)).length,
    patternCount: SCAN_PATTERNS.length,
    findings,
    informational,
    status: findings.length === 0 ? 'PASS' : 'REVIEW',
  };
}

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  for (const path of [viteBin, wranglerBin, playwrightBin, mockServer, httpSpec]) {
    assertFile(path, path);
  }
  for (const port of [MOCK_PORT, TEST_PORT, PROD_PORT, TEST_INSPECTOR_PORT, PROD_INSPECTOR_PORT]) {
    if (await portIsOccupied(port)) {
      throw new Error(`Port ${port} is already in use; refusing to run independent task 07 integration.`);
    }
  }

  // P2-4: clean Durable Object store for every run (tests/author-e2e/persist-dirs.mjs);
  // only after the ports are ours, so no running suite loses its store.
  cleanPersistStore(authorDir, ['.wrangler/author-github-indep-test', '.wrangler/author-github-indep-prod']);

  log('building the author client');
  const buildExit = await runLogged(
    process.execPath,
    [viteBin, 'build'],
    { cwd: authorDir },
    logs.build,
    'vite build',
  );
  if (buildExit !== 0) throw new Error(`vite build failed (exit ${buildExit}); see ${logs.build}`);

  log(`starting mock GitHub on ${MOCK_PORT}`);
  startLogged(
    process.execPath,
    [mockServer],
    { cwd: root, env: { ...process.env, MOCK_GITHUB_PORT: String(MOCK_PORT) } },
    logs.mock,
    'mock GitHub',
  );

  log(`starting real-route test Worker on ${TEST_PORT}`);
  startLogged(
    process.execPath,
    testWorkerArgs(TEST_PORT, TEST_INSPECTOR_PORT, '.wrangler/author-github-indep-test', {
      APP_ENV: 'test',
      GITHUB_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      GITHUB_OAUTH_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      GITHUB_APP_CLIENT_ID: 'test-client-id',
      GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
      GITHUB_APP_ID: '5919244',
      GITHUB_ALLOWED_USER_ID: '315736688',
      GITHUB_ALLOWED_REPO_ID: '1471620960',
      GITHUB_REPO_OWNER: 'ShironeShiyaro',
      GITHUB_REPO_NAME: 'selfpage-publish-test',
      GITHUB_REPO_BRANCH: 'main',
      GITHUB_CONTENT_ROOT: 'content/blog',
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
    }),
    { cwd: authorDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    logs.testWorker,
    'test Worker (independent)',
  );

  log(`starting production-mode Worker on ${PROD_PORT}`);
  startLogged(
    process.execPath,
    testWorkerArgs(PROD_PORT, PROD_INSPECTOR_PORT, '.wrangler/author-github-indep-prod', {}),
    { cwd: authorDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    logs.prodWorker,
    'production Worker (independent)',
  );

  await Promise.all([waitForHealth(TEST_PORT), waitForHealth(PROD_PORT)]);
  log('Workers healthy');

  log('running independent HTTP probes');
  const httpExit = await new Promise((resolvePromise) => {
    const logFile = openLog(logs.http, `# independent HTTP probes\nstarted: ${new Date().toISOString()}\n\n`);
    const child = spawn(process.execPath, [httpSpec], {
      cwd: root,
      env: {
        ...process.env,
        AUTHOR_GITHUB_TEST_BASE: `http://localhost:${TEST_PORT}`,
        AUTHOR_GITHUB_PROD_BASE: `http://localhost:${PROD_PORT}`,
        AUTHOR_MOCK_BASE: `http://127.0.0.1:${MOCK_PORT}`,
        INDEP_REPO_ROOT: root,
        INDEP_HTTP_REPORT: logs.httpReport,
        INDEP_SESSION_SECRET: SESSION_SECRET,
        INDEP_TOKEN_KEY: TOKEN_KEY,
        INDEP_CLIENT_SECRET: CLIENT_SECRET,
      },
      stdio: ['ignore', logFile.fd, logFile.fd],
      windowsHide: true,
    });
    children.push({ child, logFile });
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      closeLog(logFile, `\nexit code: ${code} signal: ${String(signal)} at ${new Date().toISOString()}\n`);
      resolvePromise(code ?? 1);
    };
    child.on('error', (error) => {
      append(logFile, `\nprocess error: ${error.message}\n`);
      finish(1);
    });
    child.on('exit', finish);
  });
  if (httpExit !== 0) {
    log(`independent HTTP probes failed (exit ${httpExit}); continuing to UI probes`);
  }

  log('running independent Playwright UI probes');
  const playwrightExit = await new Promise((resolvePromise) => {
    const logFile = openLog(logs.playwright, `# independent Playwright UI\nstarted: ${new Date().toISOString()}\n\n`);
    const child = spawn(
      process.execPath,
      [playwrightBin, 'test', '--config', 'playwright.github-independent.config.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          AUTHOR_GITHUB_BASE_URL: `http://localhost:${TEST_PORT}`,
          AUTHOR_GITHUB_PROD_BASE_URL: `http://localhost:${PROD_PORT}`,
          AUTHOR_MOCK_BASE: `http://127.0.0.1:${MOCK_PORT}`,
        },
        stdio: ['ignore', logFile.fd, logFile.fd],
        windowsHide: true,
      },
    );
    children.push({ child, logFile });
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      closeLog(logFile, `\nexit code: ${code} signal: ${String(signal)} at ${new Date().toISOString()}\n`);
      resolvePromise(code ?? 1);
    };
    child.on('error', (error) => {
      append(logFile, `\nprocess error: ${error.message}\n`);
      finish(1);
    });
    child.on('exit', finish);
  });

  return { httpExit, playwrightExit };
}

try {
  const result = await main();
  exitCode = result.httpExit === 0 && result.playwrightExit === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${failure}`);
  exitCode = 1;
} finally {
  stopChildren();
  // Give the OS a moment to flush the child log files before scanning.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  let scan = { status: 'NOT RUN', findings: [] };
  try {
    scan = scanLogs();
  } catch (error) {
    scan = { status: 'ERROR', findings: [{ pattern: 'scan error', count: 1, samples: [String(error)] }] };
  }
  const httpReportPath = logs.httpReport;
  let httpReport = null;
  try {
    httpReport = JSON.parse(readFileSync(httpReportPath, 'utf8'));
  } catch {
    httpReport = null;
  }
  writeFileSync(
    logs.scan,
    `${JSON.stringify(scan, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    logs.run,
    `${JSON.stringify(
      {
        startedAt: RUN_STARTED_AT,
        finishedAt: new Date().toISOString(),
        status: exitCode === 0 && scan.status === 'PASS' ? 'PASS' : exitCode === 0 ? 'REVIEW' : 'FAIL',
        http: {
          report: httpReport,
          log: logs.http,
        },
        playwright: { log: logs.playwright, baseURL: `http://localhost:${TEST_PORT}` },
        secretScan: scan,
        ports: { mockGithub: MOCK_PORT, testWorker: TEST_PORT, productionWorker: PROD_PORT },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  log(`secret scan: ${scan.status} (${scan.findings.length} findings)`);
  log(`independent run: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
}

process.exit(exitCode);
