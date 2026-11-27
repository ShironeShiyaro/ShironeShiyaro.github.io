#!/usr/bin/env node
/**
 * Task 07 Tier 1 real-route integration runner.
 *
 * Ports (reserved for 07): mock GitHub 43261, test Worker 43262,
 * production-mode Worker 43263. The task 06 runner keeps its own 43243/43244.
 *
 * 1. `vite build` the author shell;
 * 2. start the mock GitHub server;
 * 3. start a test Worker with APP_ENV=test + the mock GitHub/oauth bases, and a
 *    production-mode Worker (no APP_ENV) for 404/isolation checks;
 * 4. run `tests/author-e2e/github/http.mjs` (real routes + real DO + mock GitHub);
 * 5. run Playwright real-mode UI specs;
 * 6. write logs and a JSON report under test-results/author-github-e2e/.
 *
 * R09-19 (task 09): the output used to be docs_AI/记录/r07/assets/, which is
 * task 07's tracked evidence — every run overwrote it. Rule for every runner in
 * this repository: test output goes to gitignored test-results/<suite>/, never
 * below docs_AI/记录/.
 *
 * The generated client/session secrets below are throwaway test values, not
 * user secrets. The real `.dev.vars` is never read by this runner.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanPersistDirs as cleanPersistStore } from './author-e2e/persist-dirs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const authorDir = join(root, 'apps', 'author');
const assetsDir = join(root, 'test-results', 'author-github-e2e');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const playwrightBin = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const mockServer = join(root, 'tests', 'author-e2e', 'github', 'mock-github-server.mjs');
const httpSpec = join(root, 'tests', 'author-e2e', 'github', 'http.mjs');

const MOCK_PORT = 43261;
const TEST_PORT = 43262;
const PROD_PORT = 43263;
const TEST_INSPECTOR_PORT = 9233;
const PROD_INSPECTOR_PORT = 9234;
const RUN_STARTED_AT = new Date().toISOString();
const SESSION_SECRET = randomBytes(36).toString('base64');
const TOKEN_KEY = randomBytes(32).toString('base64');
const logs = {
  build: join(assetsDir, 'github-e2e-build.log'),
  mock: join(assetsDir, 'github-e2e-mock.log'),
  testWorker: join(assetsDir, 'github-e2e-worker-test.log'),
  prodWorker: join(assetsDir, 'github-e2e-worker-prod.log'),
  http: join(assetsDir, 'github-e2e-http.log'),
  httpReport: join(assetsDir, 'github-e2e-http.json'),
  playwright: join(assetsDir, 'github-e2e-playwright.log'),
  run: join(assetsDir, 'github-e2e-run.json'),
};

const children = [];
let exitCode = 1;

function log(message) {
  process.stdout.write(`[github-e2e] ${message}\n`);
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
  if (logFile.closed) {
    return;
  }
  try {
    writeSync(logFile.fd, text);
  } catch {
    // fd already closed
  }
}

function closeLog(logFile, footer) {
  if (logFile.closed) {
    return;
  }
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
      if (settled) {
        return;
      }
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
        if (body?.status === 'ok') {
          return body;
        }
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
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already gone
          }
        }
      }
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

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  assertFile(viteBin, 'Vite');
  assertFile(wranglerBin, 'Wrangler');
  assertFile(playwrightBin, 'Playwright');
  assertFile(mockServer, 'Mock GitHub server');
  assertFile(httpSpec, 'HTTP integration spec');

  for (const port of [MOCK_PORT, TEST_PORT, PROD_PORT, TEST_INSPECTOR_PORT, PROD_INSPECTOR_PORT]) {
    if (await portIsOccupied(port)) {
      throw new Error(`Port ${port} is already in use; refusing to run task 07 integration.`);
    }
  }

  // P2-4: every run starts from a clean Durable Object store
  // (tests/author-e2e/persist-dirs.mjs); reusing it leaks the previous run's mock
  // session / publish rows / clock into this one. Safe here because the ports are
  // already ours, i.e. no other suite is using the store.
  cleanPersistStore(authorDir, ['.wrangler/author-github-e2e-test', '.wrangler/author-github-e2e-prod']);

  log('building the author client');
  const buildExit = await runLogged(
    process.execPath,
    [viteBin, 'build'],
    { cwd: authorDir },
    logs.build,
    'vite build',
  );
  if (buildExit !== 0) {
    throw new Error(`vite build failed (exit ${buildExit}); see ${logs.build}`);
  }

  log(`starting mock GitHub on ${MOCK_PORT}`);
  startLogged(
    process.execPath,
    [mockServer],
    { cwd: root, env: { ...process.env, MOCK_GITHUB_PORT: String(MOCK_PORT) } },
    logs.mock,
    'mock GitHub',
  );

  log(`starting real-route test Worker on ${TEST_PORT} (APP_ENV=test, mock GitHub base)`);
  startLogged(
    process.execPath,
    testWorkerArgs(TEST_PORT, TEST_INSPECTOR_PORT, '.wrangler/author-github-e2e-test', {
      APP_ENV: 'test',
      GITHUB_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      GITHUB_OAUTH_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      GITHUB_APP_CLIENT_ID: 'test-client-id',
      GITHUB_APP_CLIENT_SECRET: 'test-client-secret',
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
    'test Worker',
  );

  log(`starting production-mode Worker on ${PROD_PORT} (no APP_ENV, no GitHub config)`);
  startLogged(
    process.execPath,
    testWorkerArgs(PROD_PORT, PROD_INSPECTOR_PORT, '.wrangler/author-github-e2e-prod', {}),
    { cwd: authorDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    logs.prodWorker,
    'production Worker',
  );

  await Promise.all([waitForHealth(TEST_PORT), waitForHealth(PROD_PORT)]);
  log('Workers healthy');

  log('running HTTP integration assertions');
  const httpExit = await new Promise((resolvePromise) => {
    const logFile = openLog(logs.http, `# HTTP integration\nstarted: ${new Date().toISOString()}\n\n`);
    const child = spawn(process.execPath, [httpSpec], {
      cwd: root,
      env: {
        ...process.env,
        AUTHOR_GITHUB_TEST_BASE: `http://localhost:${TEST_PORT}`,
        AUTHOR_GITHUB_PROD_BASE: `http://localhost:${PROD_PORT}`,
        AUTHOR_MOCK_BASE: `http://127.0.0.1:${MOCK_PORT}`,
        AUTHOR_GITHUB_HTTP_REPORT: logs.httpReport,
      },
      stdio: ['ignore', logFile.fd, logFile.fd],
      windowsHide: true,
    });
    const entry = { child, logFile };
    children.push(entry);
    let settled = false;
    const finish = (code, signal) => {
      if (settled) {
        return;
      }
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
    throw new Error(`HTTP integration failed (exit ${httpExit}); see ${logs.http}`);
  }

  log('running Playwright real-mode UI specs');
  const playwrightExit = await new Promise((resolvePromise) => {
    const logFile = openLog(
      logs.playwright,
      `# Playwright real-mode UI\nstarted: ${new Date().toISOString()}\n\n`,
    );
    const child = spawn(
      process.execPath,
      [playwrightBin, 'test', '--config', 'playwright.github.config.ts'],
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
    const entry = { child, logFile };
    children.push(entry);
    let settled = false;
    const finish = (code, signal) => {
      if (settled) {
        return;
      }
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
  exitCode = result.playwrightExit;
  writeFileSync(
    logs.run,
    `${JSON.stringify(
      {
        startedAt: RUN_STARTED_AT,
        finishedAt: new Date().toISOString(),
        status: exitCode === 0 ? 'PASS' : 'FAIL',
        http: { exitCode: result.httpExit, log: logs.http, report: logs.httpReport },
        playwright: {
          exitCode: result.playwrightExit,
          log: logs.playwright,
          baseURL: `http://localhost:${TEST_PORT}`,
        },
        ports: { mockGithub: MOCK_PORT, testWorker: TEST_PORT, productionWorker: PROD_PORT },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  log(`HTTP exit code: ${result.httpExit}; Playwright exit code: ${result.playwrightExit}`);
} catch (error) {
  const failure = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${failure}`);
  writeFileSync(
    logs.run,
    `${JSON.stringify({ startedAt: RUN_STARTED_AT, finishedAt: new Date().toISOString(), status: 'FAIL', failure }, null, 2)}\n`,
    'utf8',
  );
  exitCode = 1;
} finally {
  stopChildren();
}

process.exit(exitCode);
