#!/usr/bin/env node
/**
 * Focused independent retest runner for the task 07 fix round (HEAD 848fced).
 *
 * Owns 43261 (mock GitHub), 43262 (test Worker), 43263 (production-mode
 * Worker). Builds the author client, runs focused-http.mjs and the focused
 * Playwright spec, then stops every child. It never reads `.dev.vars`.
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
// R09-19: test output goes to gitignored test-results/, never below docs_AI/记录/.
const assetsDir = join(root, 'test-results', 'author-github-e2e', 'focused');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const playwrightBin = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const mockServer = join(root, 'tests', 'author-e2e', 'github', 'mock-github-server.mjs');
const httpSpec = join(root, 'tests', 'author-e2e', 'github', 'focused-http.mjs');

const MOCK_PORT = 43261;
const TEST_PORT = 43262;
const PROD_PORT = 43263;
const TEST_INSPECTOR_PORT = 9233;
const PROD_INSPECTOR_PORT = 9234;
const STARTED_AT = new Date().toISOString();
const CLIENT_SECRET = 'test-client-secret';
const SESSION_SECRET = randomBytes(36).toString('base64');
const TOKEN_KEY = randomBytes(32).toString('base64');

const logs = {
  build: join(assetsDir, 'indep2-focus-build.log'),
  mock: join(assetsDir, 'indep2-focus-mock.log'),
  testWorker: join(assetsDir, 'indep2-focus-worker-test.log'),
  prodWorker: join(assetsDir, 'indep2-focus-worker-prod.log'),
  http: join(assetsDir, 'indep2-focus-http.log'),
  httpReport: join(assetsDir, 'indep2-focus-http.json'),
  ui: join(assetsDir, 'indep2-focus-ui.log'),
  run: join(assetsDir, 'indep2-focus-run.json'),
};

const children = [];
let exitCode = 1;

function log(message) {
  process.stdout.write(`[indep2-focus] ${message}\n`);
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
    // closed
  }
}

function closeLog(logFile, footer) {
  if (logFile.closed) return;
  append(logFile, footer);
  try {
    closeSync(logFile.fd);
  } catch {
    // closed
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
  for (const [name, value] of Object.entries(extraVars)) args.push('--var', `${name}:${value}`);
  return args;
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

function scanWorkerLog() {
  const files = [logs.testWorker, logs.prodWorker];
  const findings = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of [
      /[?&]code=[A-Za-z0-9]/gu,
      /[?&]state=[A-Za-z0-9_-]{20,}/gu,
      /\b(ghu_|ghr_)[A-Za-z0-9_]+/gu,
      /client_secret\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{8,}/giu,
      /BEGIN [A-Z ]*PRIVATE KEY/gu,
    ]) {
      const matches = [...text.matchAll(pattern)];
      if (matches.length > 0) {
        findings.push({
          file: file.slice(root.length + 1).split('\\').join('/'),
          pattern: pattern.source,
          count: matches.length,
        });
      }
    }
  }
  const callbackLines = files
    .filter((file) => existsSync(file))
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split(/\r?\n/u)
        .filter((line) => line.includes('/auth/github/callback')),
    );
  return {
    findings,
    status: findings.length === 0 ? 'PASS' : 'REVIEW',
    callbackLogLines: callbackLines.length,
    callbackHasQuery: callbackLines.some((line) => line.includes('?')),
  };
}

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  for (const path of [viteBin, wranglerBin, playwrightBin, mockServer, httpSpec]) {
    if (!existsSync(path)) throw new Error(`missing ${path}; run npm ci first`);
  }
  for (const port of [MOCK_PORT, TEST_PORT, PROD_PORT, TEST_INSPECTOR_PORT, PROD_INSPECTOR_PORT]) {
    if (await portIsOccupied(port)) throw new Error(`port ${port} is already in use`);
  }

  // P2-4: clean Durable Object store for every run (tests/author-e2e/persist-dirs.mjs);
  // only after the ports are ours, so no running suite loses its store.
  cleanPersistStore(authorDir, ['.wrangler/author-github-focused-test', '.wrangler/author-github-focused-prod']);

  log('building author client');
  const buildExit = await runLogged(process.execPath, [viteBin, 'build'], { cwd: authorDir }, logs.build, 'vite build');
  if (buildExit !== 0) throw new Error(`vite build failed: ${buildExit}`);

  log('starting mock GitHub, test Worker, production-mode Worker');
  startLogged(
    process.execPath,
    [mockServer],
    { cwd: root, env: { ...process.env, MOCK_GITHUB_PORT: String(MOCK_PORT) } },
    logs.mock,
    'mock GitHub',
  );
  startLogged(
    process.execPath,
    testWorkerArgs(TEST_PORT, TEST_INSPECTOR_PORT, '.wrangler/author-github-focused-test', {
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
    'test Worker (focused)',
  );
  startLogged(
    process.execPath,
    testWorkerArgs(PROD_PORT, PROD_INSPECTOR_PORT, '.wrangler/author-github-focused-prod', {}),
    { cwd: authorDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    logs.prodWorker,
    'production Worker (focused)',
  );

  await Promise.all([waitForHealth(TEST_PORT), waitForHealth(PROD_PORT)]);
  log('workers healthy');

  const httpExit = await new Promise((resolvePromise) => {
    const logFile = openLog(logs.http, `# focused HTTP\nstarted: ${new Date().toISOString()}\n\n`);
    const child = spawn(process.execPath, [httpSpec], {
      cwd: root,
      env: {
        ...process.env,
        AUTHOR_GITHUB_TEST_BASE: `http://localhost:${TEST_PORT}`,
        AUTHOR_GITHUB_PROD_BASE: `http://localhost:${PROD_PORT}`,
        AUTHOR_MOCK_BASE: `http://127.0.0.1:${MOCK_PORT}`,
        INDEP_REPO_ROOT: root,
        INDEP_FOCUS_HTTP_REPORT: logs.httpReport,
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

  const uiExit = await new Promise((resolvePromise) => {
    const logFile = openLog(logs.ui, `# focused UI\nstarted: ${new Date().toISOString()}\n\n`);
    const child = spawn(
      process.execPath,
      [playwrightBin, 'test', '--config', 'playwright.github-focused.config.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          AUTHOR_GITHUB_BASE_URL: `http://localhost:${TEST_PORT}`,
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

  return { httpExit, uiExit };
}

try {
  const result = await main();
  exitCode = result.httpExit === 0 && result.uiExit === 0 ? 0 : 1;
  const scan = scanWorkerLog();
  const httpReport = existsSync(logs.httpReport)
    ? JSON.parse(readFileSync(logs.httpReport, 'utf8'))
    : null;
  writeFileSync(
    logs.run,
    `${JSON.stringify(
      {
        startedAt: STARTED_AT,
        finishedAt: new Date().toISOString(),
        status: exitCode === 0 && scan.status === 'PASS' ? 'PASS' : 'REVIEW',
        profile: 'focused-retest-848fced',
        http: { exitCode: result.httpExit, report: httpReport, log: logs.http },
        playwright: { exitCode: result.uiExit, log: logs.ui, baseURL: `http://localhost:${TEST_PORT}` },
        workerLogScan: scan,
        ports: { mockGithub: MOCK_PORT, testWorker: TEST_PORT, productionWorker: PROD_PORT },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  log(`worker log scan: ${scan.status}; callback lines=${scan.callbackLogLines}, query=${scan.callbackHasQuery}`);
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  writeFileSync(
    logs.run,
    `${JSON.stringify({ startedAt: STARTED_AT, finishedAt: new Date().toISOString(), status: 'FAIL', failure: String(error) }, null, 2)}\n`,
    'utf8',
  );
  exitCode = 1;
} finally {
  stopChildren();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}

process.exit(exitCode);
