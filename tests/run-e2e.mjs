#!/usr/bin/env node
// Content build checks, then two real browser passes:
//   1. demo BASE_PATH=/demo/ build on a dedicated port;
//   2. root BASE_PATH=/ build on a dedicated port.
// The script owns both preview servers, verifies a per-run build marker before
// running Playwright, refuses to reuse an occupied port, and records PID/log
// paths. Playwright's managed `webServer` is not used because its teardown can
// hang on Windows when the preview child inherits the stdout pipe.
//
// R09-9: the E2E pages are built from the committed, byte-identical content
// snapshot at tests/fixtures/valid/site-content/content, not from the live
// content/ tree. A real publish must not change what this suite asserts: before
// this, adding the fifth published article broke exact counts/labels here too
// (the author E2E reproduced the same class of failure). Real content still
// gets built by `npm run build` and is validated by `tests/check-content-build.mjs`
// inside this runner; the browser suite tests the site, not today's article list.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const siteRoot = join(repoRoot, 'apps', 'site');
const astroBin = join(repoRoot, 'node_modules', 'astro', 'bin', 'astro.mjs');
const playwrightCli = join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const artifactDir = join(repoRoot, 'test-results', 'e2e-preview');
const e2eContentRoot = join(repoRoot, 'tests', 'fixtures', 'valid', 'site-content', 'content');
mkdirSync(artifactDir, { recursive: true });

const rootPort = Number(process.env.E2E_ROOT_PORT ?? '43211');
const demoPort = Number(process.env.E2E_DEMO_PORT ?? '43212');
const previewTimeoutMs = Number(process.env.E2E_PREVIEW_TIMEOUT_MS ?? '30000');
const rootUrl = `http://127.0.0.1:${rootPort}/`;
const demoUrl = `http://127.0.0.1:${demoPort}/demo/`;
const runId = `e2e-${Date.now().toString(36)}-${process.pid}`;
const marker = `https://${runId}.invalid`;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCliPath = process.env.npm_execpath;

const childEnv = {
  ...process.env,
  PUBLIC_AUTHOR_ORIGIN: marker,
  // R11/2026-11-27: expose the frozen content snapshot to the Playwright
  // process too. `tests/e2e/home.spec.ts` derives the expected Home sections
  // from the resume Markdown; without this it read the real `content/` while
  // the preview was built from the snapshot, so editing the resume turned the
  // gate red even though the page under test had not changed.
  SELF_PAGE_CONTENT_ROOT: e2eContentRoot,
  FORCE_COLOR: '0',
};
delete childEnv.NO_COLOR;
if (!childEnv.SITE_URL || childEnv.SITE_URL.trim() === '') {
  delete childEnv.SITE_URL;
}

const previewRecords = [];
const activePreviews = new Set();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function forceKillTree(child) {
  if (!child) return;
  child.kill('SIGKILL');
  if (process.platform === 'win32' && child.pid !== undefined) {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function assertPortsFree() {
  for (const [label, port] of [
    ['root', rootPort],
    ['demo', demoPort],
  ]) {
    if (!(await isPortFree(port))) {
      console.error(
        `error: ${label} E2E port ${port} is already in use; refusing to reuse or stop an external service. ` +
          'Stop that process or set E2E_ROOT_PORT/E2E_DEMO_PORT.',
      );
      process.exit(1);
    }
  }
}

function buildSite(basePath, label) {
  const args = ['run', 'build', '--workspace', '@selfpage/site', '--', '--force'];
  const env = { ...childEnv, BASE_PATH: basePath, SELF_PAGE_CONTENT_ROOT: e2eContentRoot };
  console.log(`\n[e2e] building ${label} site (BASE_PATH=${basePath}, content root=${e2eContentRoot})`);
  const result =
    npmCliPath && npmCliPath.endsWith('.js')
      ? spawnSync(process.execPath, [npmCliPath, ...args], { cwd: repoRoot, stdio: 'inherit', env })
      : spawnSync(npmCommand, args, {
          cwd: repoRoot,
          stdio: 'inherit',
          env,
          shell: process.platform === 'win32',
        });
  if (result.status !== 0) {
    throw new Error(`${label} site build failed with exit code ${result.status ?? 'unknown'}`);
  }
}

async function startPreview({ label, port, basePath, url }) {
  const logPath = join(artifactDir, `e2e-preview-${label}.log`);
  const fd = openSync(logPath, 'w');
  const child = spawn(
    process.execPath,
    [astroBin, 'preview', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: siteRoot,
      stdio: ['ignore', fd, fd],
      env: { ...childEnv, BASE_PATH: basePath },
      windowsHide: true,
    },
  );
  closeSync(fd);
  activePreviews.add(child);

  const deadline = Date.now() + previewTimeoutMs;
  // The author-origin marker only appears in the Blog branch (New!), which is
  // rendered only while Blog is the current navigation branch. Probe the Blog
  // index instead of the Home page so the readiness check still observes it.
  const probeUrl = new URL('blog/', url).href;
  let lastObservation = 'no response yet';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      lastObservation = `preview exited with code ${child.exitCode}`;
      break;
    }
    try {
      const response = await fetch(probeUrl, { redirect: 'manual' });
      const body = response.status === 200 ? await response.text() : '';
      if (response.status === 200 && body.includes(`${marker}/new/`)) {
        recordPreview(label, port, child.pid, logPath);
        console.log(`[e2e] preview ${label}: pid=${child.pid} port=${port} log=${relative(repoRoot, logPath)}`);
        return child;
      }
      lastObservation = `status=${response.status} marker=${body.includes(`${marker}/new/`)}`;
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }

  activePreviews.delete(child);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000);
  }
  if (child.exitCode === null) {
    forceKillTree(child);
    await waitForExit(child, 5_000);
  }
  console.error(`error: ${label} astro preview did not become ready at ${probeUrl} (${lastObservation})`);
  console.error(`error: preview log: ${relative(repoRoot, logPath)}`);
  throw new Error(`${label} preview did not become ready`);
}

function recordPreview(label, port, pid, logPath) {
  previewRecords.push({
    label,
    port,
    pid,
    log: relative(repoRoot, logPath).split('\\').join('/'),
    marker,
    runId,
  });
  writeFileSync(
    join(artifactDir, 'preview-pids.txt'),
    `${previewRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

async function stopPreview(child, label) {
  if (!child) return;
  activePreviews.delete(child);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    let exited = await waitForExit(child, 5_000);
    if (!exited) {
      console.error(`[e2e] preview ${label} did not exit after SIGKILL; using taskkill tree cleanup`);
      forceKillTree(child);
      exited = await waitForExit(child, 5_000);
    }
    if (!exited) console.error(`[e2e] warning: preview ${label} pid=${child.pid} may still be running`);
    else console.log(`[e2e] stopped preview ${label}: pid=${child.pid}`);
  }
}

function runPlaywright(files, baseUrl) {
  const env = { ...childEnv, E2E_BASE_URL: baseUrl };
  const result = spawnSync(process.execPath, [playwrightCli, 'test', ...files, ...process.argv.slice(2)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  });
  return result.status ?? 1;
}

const onSignal = (signal) => {
  for (const child of activePreviews) {
    forceKillTree(child);
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
};
process.once('SIGINT', () => onSignal('SIGINT'));
process.once('SIGTERM', () => onSignal('SIGTERM'));

let exitCode = 0;
try {
  await assertPortsFree();

  console.log('\n[e2e] build-level content checks');
  const contentBuild = spawnSync(
    process.execPath,
    [join(repoRoot, 'tests', 'check-content-build.mjs')],
    { cwd: repoRoot, stdio: 'inherit', env: childEnv },
  );
  if (contentBuild.status !== 0) throw new Error('content build checks failed');

  buildSite('/demo/', 'demo');
  const demoPreview = await startPreview({
    label: 'demo',
    port: demoPort,
    basePath: '/demo/',
    url: demoUrl,
  });
  try {
    exitCode = runPlaywright(['tests/e2e/demo.spec.ts'], demoUrl);
  } finally {
    await stopPreview(demoPreview, 'demo');
  }
  if (exitCode !== 0) throw new Error(`demo-base Playwright run failed with exit code ${exitCode}`);

  buildSite('/', 'root');
  const rootPreview = await startPreview({
    label: 'root',
    port: rootPort,
    basePath: '/',
    url: rootUrl,
  });
  try {
    exitCode = runPlaywright(
      [
        'tests/e2e/smoke.spec.ts',
        'tests/e2e/shell.spec.ts',
        'tests/e2e/home.spec.ts',
        'tests/e2e/navigation.spec.ts',
        'tests/e2e/blog.spec.ts',
        'tests/e2e/settings.spec.ts',
        // Task 08 independent verification (test subagent): own probes plus the
        // required axe scan. They run in the same root-base pass as the rest.
        'tests/e2e/settings-independent.spec.ts',
        'tests/e2e/interaction-independent.spec.ts',
        'tests/e2e/a11y.spec.ts',
        // Black-box DEF-08-01 regression: coarse-pointer target sizes at 320px.
        'tests/e2e/coarse-targets.spec.ts',
      ],
      rootUrl,
    );
  } finally {
    await stopPreview(rootPreview, 'root');
  }
} catch (error) {
  exitCode = exitCode || 1;
  console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`);
  for (const child of activePreviews) {
    forceKillTree(child);
  }
} finally {
  process.exitCode = exitCode;
}
