#!/usr/bin/env node
/**
 * Author-end to end runner.
 *
 * 1. fail fast when either E2E port is occupied;
 * 2. `vite build` the author client;
 * 3. start a test Worker (`APP_ENV=test`, port 43243) and a production-mode
 *    Worker (no APP_ENV, port 43244) with separate Wrangler persistence dirs;
 * 4. wait for both `/api/health` endpoints, inject the fixed test clock;
 * 5. run `playwright.author.config.ts` with the system Edge channel;
 * 6. stop both Workers and write logs/PIDs under `test-results/author-e2e/`.
 *
 * R09-6 (task 09): logs used to be written to `docs_AI/记录/r06/assets/`, which
 * is task 06's tracked historical evidence — every run overwrote it, so a fresh
 * run's numbers could not be told apart from the committed evidence. The output
 * directory is now `test-results/author-e2e/` (gitignored).
 * `docs_AI/记录/r06/assets/` must stay byte-identical.
 *
 * Where the logs survive: locally they stay in `test-results/author-e2e/`
 * (gitignored, overwritten by the next run); in GitHub Actions the job that runs
 * this suite uploads `test-results/` with `actions/upload-artifact`
 * (`if: always()`), so a failed run's logs are downloadable from that run. If
 * that upload step is ever removed from `.github/workflows/ci.yml`, this
 * paragraph is wrong and must be updated with it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanPersistDirs as cleanPersistStore } from './author-e2e/persist-dirs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const authorDir = join(root, 'apps', 'author');
// R09-6: never write below `docs_AI/记录/` here; that tree is historical,
// tracked evidence and must not be rewritten by a test run.
const assetsDir = join(root, 'test-results', 'author-e2e');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const playwrightBin = join(root, 'node_modules', '@playwright', 'test', 'cli.js');

const TEST_PORT = 43243;
const PROD_PORT = 43244;
const TEST_INSPECTOR_PORT = 9231;
const PROD_INSPECTOR_PORT = 9232;
const FIXED_CLOCK = '2026-11-23T15:42:15Z';
// R09-9: the author shell bakes its navigation from the same content tree as the
// public site (apps/author/vite.config.ts), so a real publish changes the nav.
// The 2026-11-27 publish added a third 2026 post and two exact-count assertions
// in shell.spec.ts failed (Expected 2, Received 3) — locally and in CI. Point
// the test build at the committed, byte-identical snapshot instead: the E2E
// suite then tests the navigation behaviour, not today's article count.
// This is the same seam R09-8 used for packages/content-model/src/load.test.ts;
// real content is still built and checked by `npm run check` / `npm run build`.
const E2E_CONTENT_ROOT = join(root, 'tests', 'fixtures', 'valid', 'site-content', 'content');
const RUN_STARTED_AT = new Date().toISOString();
const logs = {
  build: join(assetsDir, 'author-e2e-build.log'),
  testWorker: join(assetsDir, 'author-e2e-worker-test.log'),
  prodWorker: join(assetsDir, 'author-e2e-worker-prod.log'),
  playwright: join(assetsDir, 'author-e2e-playwright.log'),
  run: join(assetsDir, 'author-e2e-run.json'),
};

const children = [];
let playwrightExitCode = 1;

function log(message) {
  process.stdout.write(`[author-e2e] ${message}\n`);
}

function assertFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}. Run npm ci first.`);
  }
}

function openLog(path, header) {
  const fd = openSync(path, 'w');
  writeSync(fd, header);
  return { path, fd, closed: false };
}

function appendLog(logFile, text) {
  if (logFile.closed) {
    return;
  }
  try {
    writeSync(logFile.fd, text);
  } catch {
    // fd already gone; the file still contains everything written before that.
  }
}

function closeLog(logFile, footer) {
  if (logFile.closed) {
    return;
  }
  if (footer) {
    appendLog(logFile, footer);
  }
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
    socket.once('listening', () => {
      socket.close(() => resolvePromise(false));
    });
    socket.listen(port, '127.0.0.1');
  });
}

function startLogged(command, args, options, logPath) {
  const logFile = openLog(
    logPath,
    `$ ${command} ${args.join(' ')}\ncwd: ${options.cwd}\nstarted: ${new Date().toISOString()}\n\n`,
  );
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', logFile.fd, logFile.fd],
    windowsHide: true,
  });
  const entry = { child, logFile };
  child.on('error', (error) => {
    appendLog(logFile, `\nprocess error: ${error.stack ?? error.message}\n`);
    closeLog(logFile, `\nspawn failed at ${new Date().toISOString()}\n`);
  });
  child.on('exit', (code, signal) => {
    closeLog(logFile, `\nexit code: ${code} signal: ${String(signal)} at ${new Date().toISOString()}\n`);
  });
  children.push(entry);
  return entry;
}

function runLogged(command, args, options, logPath) {
  return new Promise((resolvePromise) => {
    const startedAt = new Date().toISOString();
    const logFile = openLog(
      logPath,
      `$ ${command} ${args.join(' ')}\ncwd: ${options.cwd}\nstarted: ${startedAt}\n\n`,
    );
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', logFile.fd, logFile.fd],
      windowsHide: true,
    });
    let settled = false;
    const finish = (exitCode, extra) => {
      if (settled) {
        return;
      }
      settled = true;
      closeLog(logFile, extra);
      resolvePromise({ exitCode, startedAt, finishedAt: new Date().toISOString() });
    };
    child.on('error', (error) => {
      appendLog(logFile, `\nprocess error: ${error.stack ?? error.message}\n`);
      finish(1);
    });
    child.on('exit', (code, signal) => {
      finish(code ?? 1, `\nexit code: ${code} signal: ${String(signal)} at ${new Date().toISOString()}\n`);
    });
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
        lastError = `unexpected body ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
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
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
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

function writeRunReport(report) {
  writeFileSync(logs.run, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

// Per-run Wrangler persistence directories (`.wrangler/` is gitignored) and the
// P2-4 rule: every run starts from a CLEAN Durable Object store.
//
// These directories used to survive from one run to the next. The test Worker
// keeps the single-author DO state — mock session, publish/dedupe rows, the
// injected fixed clock — in there, so a second run started from whatever the
// first left behind. That is the most plausible explanation for 79/1 vs 80/0 on
// identical code (E11 began from an already-expired session), and it makes
// "stable" untestable by re-running the suite. The shared helper is used by every
// author-app runner (tests/author-e2e/persist-dirs.mjs).
const TEST_PERSIST_DIR = '.wrangler/author-e2e-test';
const PROD_PERSIST_DIR = '.wrangler/author-e2e-prod';

function cleanPersistDirs() {
  for (const directory of cleanPersistStore(authorDir, [TEST_PERSIST_DIR, PROD_PERSIST_DIR])) {
    log(`cleaned previous Durable Object store: ${directory}`);
  }
}

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  assertFile(viteBin, 'Vite binary');
  assertFile(wranglerBin, 'Wrangler binary');
  assertFile(playwrightBin, 'Playwright CLI');

  for (const port of [TEST_PORT, PROD_PORT, TEST_INSPECTOR_PORT, PROD_INSPECTOR_PORT]) {
    if (await portIsOccupied(port)) {
      throw new Error(`Port ${port} is already in use; refusing to run the author E2E suite.`);
    }
  }

  // Only after the ports are ours: clearing the store under a running suite would
  // pull the ground out from under it.
  cleanPersistDirs();

  log(`building the author client with Vite (content root: ${E2E_CONTENT_ROOT})`);
  const build = await runLogged(
    process.execPath,
    [viteBin, 'build'],
    { cwd: authorDir, env: { ...process.env, SELF_PAGE_CONTENT_ROOT: E2E_CONTENT_ROOT } },
    logs.build,
  );
  if (build.exitCode !== 0) {
    throw new Error(`vite build failed with exit code ${build.exitCode}; see ${logs.build}`);
  }

  log(`starting test Worker on ${TEST_PORT} with APP_ENV=test`);
  const testWorker = startLogged(
    process.execPath,
    [
      wranglerBin,
      'dev',
      '--port',
      String(TEST_PORT),
      '--ip',
      '127.0.0.1',
      '--inspector-port',
      String(TEST_INSPECTOR_PORT),
      '--persist-to',
      TEST_PERSIST_DIR,
      '--var',
      'APP_ENV:test',
    ],
    { cwd: authorDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    logs.testWorker,
  );

  log(`starting production-mode Worker on ${PROD_PORT} (no APP_ENV)`);
  const prodWorker = startLogged(
    process.execPath,
    [
      wranglerBin,
      'dev',
      '--port',
      String(PROD_PORT),
      '--ip',
      '127.0.0.1',
      '--inspector-port',
      String(PROD_INSPECTOR_PORT),
      '--persist-to',
      PROD_PERSIST_DIR,
    ],
    { cwd: authorDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    logs.prodWorker,
  );

  await Promise.all([waitForHealth(TEST_PORT), waitForHealth(PROD_PORT)]);
  log('both Workers are healthy');

  const clockResponse = await fetch(`http://127.0.0.1:${TEST_PORT}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ now: FIXED_CLOCK }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!clockResponse.ok) {
    throw new Error(`test clock injection failed with HTTP ${clockResponse.status}`);
  }
  const clockBody = await clockResponse.json();
  log(`test clock set to ${clockBody.now} (${clockBody.date} Asia/Shanghai)`);

  log('running Playwright with the system Edge channel');
  const playwrightExit = await new Promise((resolvePromise) => {
    const logFile = openLog(
      logs.playwright,
      `$ playwright test --config playwright.author.config.ts\nstarted: ${new Date().toISOString()}\n\n`,
    );
    const child = spawn(
      process.execPath,
      [playwrightBin, 'test', '--config', 'playwright.author.config.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          AUTHOR_E2E_BASE_URL: `http://127.0.0.1:${TEST_PORT}`,
          AUTHOR_E2E_PROD_BASE_URL: `http://127.0.0.1:${PROD_PORT}`,
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
      closeLog(
        logFile,
        `\nexit code: ${code} signal: ${String(signal)} at ${new Date().toISOString()}\n`,
      );
      resolvePromise(code ?? 1);
    };
    child.on('error', (error) => {
      appendLog(logFile, `\nprocess error: ${error.stack ?? error.message}\n`);
      finish(1, null);
    });
    child.on('exit', (code, signal) => finish(code, signal));
  });

  return {
    testWorkerPid: testWorker.child.pid,
    prodWorkerPid: prodWorker.child.pid,
    clock: clockBody,
    playwrightExit,
  };
}

try {
  const result = await main();
  playwrightExitCode = result.playwrightExit;
  writeRunReport({
    startedAt: RUN_STARTED_AT,
    finishedAt: new Date().toISOString(),
    status: playwrightExitCode === 0 ? 'PASS' : 'FAIL',
    node: process.version,
    playwright: {
      command: 'node node_modules/@playwright/test/cli.js test --config playwright.author.config.ts',
      exitCode: playwrightExitCode,
      browser: 'msedge (system channel)',
      baseURL: `http://127.0.0.1:${TEST_PORT}`,
      productionBaseURL: `http://127.0.0.1:${PROD_PORT}`,
    },
    workers: {
      test: { port: TEST_PORT, appEnv: 'test', pid: result.testWorkerPid },
      production: { port: PROD_PORT, appEnv: null, pid: result.prodWorkerPid },
    },
    clock: result.clock,
    logs,
  });
  log(`Playwright exit code: ${playwrightExitCode}`);
} catch (error) {
  const failure = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${failure}`);
  writeRunReport({
    startedAt: RUN_STARTED_AT,
    finishedAt: new Date().toISOString(),
    status: 'FAIL',
    failure,
    logs,
  });
  playwrightExitCode = 1;
} finally {
  stopChildren();
}

process.exit(playwrightExitCode);
