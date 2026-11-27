#!/usr/bin/env node
/**
 * Independent author E2E runner (task 06).
 *
 * The frozen public runner (`tests/run-author-e2e.mjs`) is owned by the
 * executor and hardcodes ports 43243/43244, which this independent role was
 * told not to occupy. This runner mirrors its lifecycle on the assigned ports:
 *
 * 1. fail fast if 43253/43254 are occupied;
 * 2. build the author client;
 * 3. start a test Worker (APP_ENV=test) on 43253 and a production-mode Worker
 *    (no APP_ENV) on 43254;
 * 4. wait for both /api/health endpoints;
 * 5. run only tests/author-e2e/independent.spec.ts;
 * 6. stop both Workers and keep logs under test-results/author-e2e/independent/.
 *
 * R09-6 (task 09): the output directory is no longer `docs_AI/记录/r06/assets/`
 * (task 06's tracked historical evidence, which every run used to overwrite).
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
// R09-6: the independent runner writes into its own gitignored subdirectory
// so a run can never overwrite the committed task 06 evidence.
const assetsDir = join(root, 'test-results', 'author-e2e', 'independent');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const playwrightBin = join(root, 'node_modules', '@playwright', 'test', 'cli.js');

const TEST_PORT = 43253;
const PROD_PORT = 43254;
const TEST_INSPECTOR_PORT = 9233;
const PROD_INSPECTOR_PORT = 9234;
const LOG_PREFIX = process.env.INDEP_LOG_PREFIX?.trim() || 'indep';
const RUN_STARTED_AT = new Date().toISOString();
const logs = {
  build: join(assetsDir, `${LOG_PREFIX}-author-e2e-build.log`),
  testWorker: join(assetsDir, `${LOG_PREFIX}-author-e2e-worker-test.log`),
  prodWorker: join(assetsDir, `${LOG_PREFIX}-author-e2e-worker-prod.log`),
  playwright: join(assetsDir, `${LOG_PREFIX}-author-e2e-playwright.log`),
  run: join(assetsDir, `${LOG_PREFIX}-author-e2e-run.json`),
};

const children = [];
let playwrightExitCode = 1;

function log(message) {
  process.stdout.write(`[author-e2e:independent] ${message}\n`);
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
    // keep the already-written evidence
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
  child.on('error', (error) => {
    appendLog(logFile, `\nprocess error: ${error.stack ?? error.message}\n`);
    closeLog(logFile, `\nspawn failed at ${new Date().toISOString()}\n`);
  });
  child.on('exit', (code, signal) => {
    closeLog(logFile, `\nexit code: ${code} signal: ${String(signal)} at ${new Date().toISOString()}\n`);
  });
  const entry = { child, logFile };
  children.push(entry);
  return entry;
}

function runLogged(command, args, options, logPath) {
  return new Promise((resolvePromise) => {
    const logFile = openLog(
      logPath,
      `$ ${command} ${args.join(' ')}\ncwd: ${options.cwd}\nstarted: ${new Date().toISOString()}\n\n`,
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
      resolvePromise({ exitCode });
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

// P2-4: start from a clean Durable Object store, exactly like the public runner.
// `.wrangler/` is gitignored; reusing these directories across runs leaks the
// previous run's mock session / publish rows / clock into the next one.
const TEST_PERSIST_DIR = '.wrangler/author-e2e-indep-test';
const PROD_PERSIST_DIR = '.wrangler/author-e2e-indep-prod';

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
      throw new Error(`Port ${port} is already in use; refusing to start the independent author E2E.`);
    }
  }

  // Only after the ports are ours, so a running suite is never disturbed.
  cleanPersistDirs();

  log('building the author client');
  const build = await runLogged(process.execPath, [viteBin, 'build'], { cwd: authorDir }, logs.build);
  if (build.exitCode !== 0) {
    throw new Error(`vite build failed with exit ${build.exitCode}; see ${logs.build}`);
  }

  log(`starting test Worker on ${TEST_PORT} (APP_ENV=test)`);
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

  log(`starting production-mode Worker on ${PROD_PORT}`);
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

  log('running Playwright on tests/author-e2e/independent.spec.ts');
  const playwrightExit = await new Promise((resolvePromise) => {
    const logFile = openLog(
      logs.playwright,
      `$ playwright test --config playwright.author.config.ts tests/author-e2e/independent.spec.ts\nstarted: ${new Date().toISOString()}\n\n`,
    );
    const child = spawn(
      process.execPath,
      [
        playwrightBin,
        'test',
        '--config',
        'playwright.author.config.ts',
        'tests/author-e2e/independent.spec.ts',
      ],
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
      closeLog(logFile, `\nexit code: ${code} signal: ${String(signal)} at ${new Date().toISOString()}\n`);
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
      command:
        'node node_modules/@playwright/test/cli.js test --config playwright.author.config.ts tests/author-e2e/independent.spec.ts',
      exitCode: playwrightExitCode,
      browser: 'msedge (system channel)',
      baseURL: `http://127.0.0.1:${TEST_PORT}`,
      productionBaseURL: `http://127.0.0.1:${PROD_PORT}`,
    },
    workers: {
      test: { port: TEST_PORT, appEnv: 'test', pid: result.testWorkerPid },
      production: { port: PROD_PORT, appEnv: null, pid: result.prodWorkerPid },
    },
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
