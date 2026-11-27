#!/usr/bin/env node
// Independent 07.5 end-to-end environment.
//
// Builds the public site (preview on 4324) and the author client + test Worker
// (43243) with their real cross-origin configuration, prepares the X04 real
// Astro build fixture, then runs the independent Playwright specs serially and
// stops every process it started. It never reuses another server and never
// touches apps/** or packages/**.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildX04Fixture, probeTimeFallback } from './x04-build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const siteDir = join(root, 'apps', 'site');
const authorDir = join(root, 'apps', 'author');
// R09-19: test output goes to gitignored test-results/, never below docs_AI/记录/
// (docs_AI/记录/r075/assets/indep-075 is task 07.5's tracked evidence).
const assetsDir = join(root, 'test-results', 'independent-075');
const tmpRoot = join(root, 'test-results', 'indep-075');

const SITE_PORT = Number(process.env.INDEP_SITE_PORT ?? '4324');
// 4324/43243 are the assigned ports; explicit overrides exist for the rare case
// where a concurrent agent still holds one (recorded in the report).
const AUTHOR_PORT = Number(process.env.INDEP_AUTHOR_PORT ?? '43243');
const INSPECTOR_PORT = Number(
  process.env.INDEP_INSPECTOR_PORT ?? (AUTHOR_PORT === 43243 ? '9234' : String(AUTHOR_PORT + 6790)),
);
const SITE_URL = `http://localhost:${SITE_PORT}`;
const AUTHOR_URL = `http://localhost:${AUTHOR_PORT}`;

const astroBin = join(root, 'node_modules', 'astro', 'bin', 'astro.mjs');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const playwrightBin = join(root, 'node_modules', '@playwright', 'test', 'cli.js');

const children = [];
const logs = [];
let playwrightExit = 1;

function log(message) {
  process.stdout.write(`[indep-075] ${message}\n`);
}

function openLog(path, header) {
  const fd = openSync(path, 'w');
  writeSync(fd, header);
  return { path, fd, closed: false };
}

function closeLog(file, footer = '') {
  if (file.closed) return;
  try {
    if (footer) writeSync(file.fd, footer);
    closeSync(file.fd);
  } catch {
    // The file still holds everything written before it disappeared.
  }
  file.closed = true;
}

function startLogged(command, args, options, logName) {
  const file = openLog(
    join(assetsDir, logName),
    `$ ${command} ${args.join(' ')}\ncwd: ${options.cwd}\nstarted: ${new Date().toISOString()}\n\n`,
  );
  logs.push(relative(root, file.path).split('\\').join('/'));
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', file.fd, file.fd],
    windowsHide: true,
  });
  const entry = { child, file, logName };
  child.on('error', (error) => closeLog(file, `\nspawn error: ${error.message}\n`));
  child.on('exit', (code, signal) => closeLog(file, `\nexit: ${code} signal: ${String(signal)}\n`));
  children.push(entry);
  return entry;
}

function runLogged(command, args, options, logName) {
  const file = openLog(
    join(assetsDir, logName),
    `$ ${command} ${args.join(' ')}\ncwd: ${options.cwd}\nstarted: ${new Date().toISOString()}\n\n`,
  );
  logs.push(relative(root, file.path).split('\\').join('/'));
  const result = spawnSync(command, args, {
    ...options,
    stdio: ['ignore', file.fd, file.fd],
    windowsHide: true,
  });
  closeLog(file, `\nexit: ${result.status ?? 1}\n`);
  return result.status ?? 1;
}

function portIsOccupied(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(true));
    server.once('listening', () => {
      server.close(() => resolvePromise(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function waitForHttp(url, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = response.ok ? await response.text() : '';
      if (predicate(response, body)) {
        return;
      }
      last = `status=${response.status} body=${body.length}b`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
  }
  throw new Error(`${label} did not become ready at ${url} (${last})`);
}

function runPlaywright() {
  return new Promise((resolvePromise) => {
    const file = openLog(
      join(assetsDir, 'playwright.log'),
      `$ playwright test --config tests/independent-075/playwright.config.ts\nstarted: ${new Date().toISOString()}\n\n`,
    );
    logs.push(relative(root, file.path).split('\\').join('/'));
    const child = spawn(
      process.execPath,
      [playwrightBin, 'test', '--config', 'tests/independent-075/playwright.config.ts', ...process.argv.slice(2)],
      {
        cwd: root,
        env: {
          ...process.env,
          INDEP_SITE_URL: SITE_URL,
          INDEP_AUTHOR_URL: AUTHOR_URL,
          INDEP_ASSETS: assetsDir,
          INDEP_TMP: tmpRoot,
        },
        stdio: ['ignore', file.fd, file.fd],
        windowsHide: true,
      },
    );
    const entry = { child, file, logName: 'playwright.log' };
    children.push(entry);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      closeLog(file, `\nexit: ${code}\n`);
      resolvePromise(code);
    };
    child.on('error', (error) => {
      writeSync(file.fd, `\nspawn error: ${error.message}\n`);
      finish(1);
    });
    child.on('exit', (code) => finish(code ?? 1));
  });
}

function listenerPids(port) {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const pids = new Set();
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`).exec(line);
    if (match) pids.add(Number(match[1]));
  }
  return [...pids];
}

function killPortListeners(port) {
  for (const pid of listenerPids(port)) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
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
    closeLog(entry.file, `\nstopped by runner at ${new Date().toISOString()}\n`);
  }
  // A wrapper such as `wrangler dev` can exit while its child keeps the port,
  // so stop whatever still listens on the ports this run reserved.
  for (const port of [SITE_PORT, AUTHOR_PORT, INSPECTOR_PORT]) {
    killPortListeners(port);
  }
}

async function assertPortsFree() {
  for (const [label, port] of [
    ['site preview', SITE_PORT],
    ['author Worker', AUTHOR_PORT],
    ['author inspector', INSPECTOR_PORT],
  ]) {
    if (await portIsOccupied(port)) {
      throw new Error(`port ${port} (${label}) is already in use; refusing to run`);
    }
  }
}

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  await assertPortsFree();

  const skipBuild = process.env.INDEP_NO_BUILD === '1';
  let x04 = { build: { status: 0 }, articleFile: '', sanitizeFile: '' };
  let timeFallback = {
    loaded: false,
    totalPosts: 0,
    warnings: [],
    dateOnly: null,
    invalidTime: null,
  };
  let siteBuild = 0;
  let authorBuild = 0;
  if (skipBuild) {
    log('INDEP_NO_BUILD=1: reusing the existing site/author builds and X04 fixture');
    timeFallback = await probeTimeFallback({ tmpRoot, assetsDir });
  } else {
    log('preparing the X04 real Astro build fixture (temporary content root)');
    x04 = buildX04Fixture({ tmpRoot, assetsDir });
    writeFileSync(join(tmpRoot, 'x04-build.json'), `${JSON.stringify(x04, null, 2)}\n`, 'utf8');
    log(`X04 build exit ${x04.build.status}: ${relative(root, x04.articleFile)}`);

    log('probing the missing/invalid time fallback');
    timeFallback = await probeTimeFallback({ tmpRoot, assetsDir });
    log(
      `time fallback loaded=${timeFallback.loaded} warnings=${timeFallback.warnings.length} dateOnly=${JSON.stringify(timeFallback.dateOnly)}`,
    );

    log(`building the public site (PUBLIC_AUTHOR_ORIGIN=${AUTHOR_URL})`);
    siteBuild = runLogged(
      process.execPath,
      [astroBin, 'build'],
      {
        cwd: siteDir,
        env: {
          ...process.env,
          BASE_PATH: '/',
          PUBLIC_AUTHOR_ORIGIN: AUTHOR_URL,
          SELF_PAGE_CONTENT_ROOT: '',
        },
      },
      'site-build.log',
    );
    if (siteBuild !== 0) throw new Error(`public site build failed (exit ${siteBuild})`);

    log(`building the author client (PUBLIC_SITE_ORIGIN=${SITE_URL})`);
    authorBuild = runLogged(
      process.execPath,
      [viteBin, 'build'],
      {
        cwd: authorDir,
        env: {
          ...process.env,
          PUBLIC_SITE_ORIGIN: SITE_URL,
        },
      },
      'author-build.log',
    );
    if (authorBuild !== 0) throw new Error(`author client build failed (exit ${authorBuild})`);
  }

  log(`serving the built public site on ${SITE_PORT}`);
  const preview = startLogged(
    process.execPath,
    [join(here, 'static-server.mjs'), join(siteDir, 'dist'), String(SITE_PORT)],
    { cwd: siteDir },
    'site-preview.log',
  );

  log(`starting the author test Worker on ${AUTHOR_PORT}`);
  const worker = startLogged(
    process.execPath,
    [
      wranglerBin,
      'dev',
      '--port',
      String(AUTHOR_PORT),
      '--ip',
      '127.0.0.1',
      '--inspector-port',
      String(INSPECTOR_PORT),
      '--persist-to',
      join(tmpRoot, 'wrangler-state'),
      '--var',
      'APP_ENV:test',
    ],
    { cwd: authorDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    'author-worker.log',
  );

  await waitForHttp(
    `${SITE_URL}/blog/`,
    (response, body) => response.status === 200 && body.includes(`${AUTHOR_URL}/new/`),
    30_000,
    'public preview (with the author-origin New! marker)',
  );
  await waitForHttp(
    `${AUTHOR_URL}/api/health`,
    (response, body) => response.status === 200 && body.includes('"ok"'),
    90_000,
    'author Worker health',
  );

  const reset = await fetch(`${AUTHOR_URL}/api/test/reset`, { method: 'POST' });
  if (!reset.ok) throw new Error(`test reset failed with HTTP ${reset.status}`);
  const clock = await fetch(`${AUTHOR_URL}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ now: '2026-11-23T15:42:15Z' }),
  });
  if (!clock.ok) throw new Error(`test clock failed with HTTP ${clock.status}`);

  log('running the independent Playwright suite');
  playwrightExit = await runPlaywright();

  return {
    startedAt: RUN_STARTED_AT,
    finishedAt: new Date().toISOString(),
    status: playwrightExit === 0 ? 'PASS' : 'FAIL',
    node: process.version,
    site: { url: SITE_URL, port: SITE_PORT, previewPid: preview.child.pid, buildExit: siteBuild },
    author: {
      url: AUTHOR_URL,
      port: AUTHOR_PORT,
      workerPid: worker.child.pid,
      buildExit: authorBuild,
      appEnv: 'test',
      publicSiteOrigin: SITE_URL,
    },
    x04: {
      buildExit: x04.build.status,
      articleFile: relative(root, x04.articleFile).split('\\').join('/'),
      sanitizeFile: relative(root, x04.sanitizeFile).split('\\').join('/'),
    },
    timeFallback,
    playwright: {
      command: 'node node_modules/@playwright/test/cli.js test --config tests/independent-075/playwright.config.ts',
      exitCode: playwrightExit,
      browser: 'msedge (system channel)',
    },
    logs,
  };
}

const RUN_STARTED_AT = new Date().toISOString();

try {
  const report = await main();
  writeFileSync(join(assetsDir, 'run.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  log(`Playwright exit ${playwrightExit}`);
} catch (error) {
  const failure = error instanceof Error ? error.stack ?? error.message : String(error);
  log(`FAILED: ${failure}`);
  writeFileSync(
    join(assetsDir, 'run.json'),
    `${JSON.stringify(
      {
        startedAt: RUN_STARTED_AT,
        finishedAt: new Date().toISOString(),
        status: 'FAIL',
        failure,
        logs,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  playwrightExit = 1;
} finally {
  stopChildren();
  let stillUsed = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    stillUsed = [];
    for (const port of [SITE_PORT, AUTHOR_PORT, INSPECTOR_PORT]) {
      if (await portIsOccupied(port)) stillUsed.push(port);
    }
    if (stillUsed.length === 0) break;
  }
  if (stillUsed.length > 0) {
    log(`WARNING: ports still in use after cleanup: ${stillUsed.join(', ')}`);
  } else {
    log(`ports ${SITE_PORT}/${AUTHOR_PORT}/${INSPECTOR_PORT} are free after cleanup`);
  }
}

process.exit(playwrightExit);
