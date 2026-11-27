#!/usr/bin/env node
/**
 * Task 07 independent A01 runner.
 *
 * Builds the public site with an unreachable author-origin marker, serves it
 * from a static Astro preview on 43241, and runs the A01 Playwright probe while
 * no author Worker exists on 43262. It also scans the built public site for
 * token/secret markers and records the request/response evidence.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const siteDir = join(root, 'apps', 'site');
// R09-19: test output goes to gitignored test-results/, never below docs_AI/记录/.
const assetsDir = join(root, 'test-results', 'site-author-isolation');
const astroBin = join(root, 'node_modules', 'astro', 'bin', 'astro.mjs');
const playwrightBin = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const PORT = 43241;
const AUTHOR_PORT = 43262;
const AUTHOR_ORIGIN = 'https://indep-author.invalid';
const RUN_STARTED_AT = new Date().toISOString();

const logs = {
  build: join(assetsDir, 'indep-site-a01-build.log'),
  preview: join(assetsDir, 'indep-site-a01-preview.log'),
  playwright: join(assetsDir, 'indep-site-a01-playwright.log'),
  run: join(assetsDir, 'indep-site-a01-run.json'),
};

const children = [];
let exitCode = 1;

function log(message) {
  process.stdout.write(`[indep-site] ${message}\n`);
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

function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const socket = createServer();
    socket.once('error', () => resolvePromise(false));
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolvePromise(true)));
  });
}

function runLogged(command, args, options, logPath, label) {
  return new Promise((resolvePromise) => {
    const logFile = openLog(logPath, `# ${label}\ncwd: ${options.cwd}\nstarted: ${new Date().toISOString()}\n\n`);
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', logFile.fd, logFile.fd],
      windowsHide: true,
      shell: options.shell === true,
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

function stopChildren() {
  for (const entry of children) {
    const pid = entry.child.pid;
    if (pid && entry.child.exitCode === null) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    closeLog(entry.logFile, `\nstopped by runner at ${new Date().toISOString()}\n`);
  }
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...walkFiles(full));
    else files.push(full);
  }
  return files;
}

const SITE_SCAN_PATTERNS = [
  /ghu_[A-Za-z0-9_]+/gu,
  /ghr_[A-Za-z0-9_]+/gu,
  /client_secret/giu,
  /access_token/giu,
  /refresh_token/giu,
  /SESSION_SECRET/gu,
  /TOKEN_ENCRYPTION_KEY/gu,
  /BEGIN [A-Z ]*PRIVATE KEY/gu,
  /sp_session/gu,
  /\/api\/session/gu,
];

function scanSite() {
  const dist = join(siteDir, 'dist');
  const files = walkFiles(dist);
  const findings = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of SITE_SCAN_PATTERNS) {
      pattern.lastIndex = 0;
      const matches = [...text.matchAll(pattern)];
      if (matches.length > 0) {
        findings.push({
          file: file.slice(root.length + 1).split('\\').join('/'),
          pattern: pattern.source,
          count: matches.length,
          samples: matches.slice(0, 3).map((match) => match[0].slice(0, 40)),
        });
      }
    }
  }
  return { status: findings.length === 0 ? 'PASS' : 'REVIEW', filesScanned: files.length, findings };
}

async function waitForSite(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`site preview did not become ready: ${last}`);
}

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  for (const path of [astroBin, playwrightBin]) {
    if (!existsSync(path)) throw new Error(`missing ${path}; run npm ci first`);
  }
  if (!(await isPortFree(PORT))) throw new Error(`port ${PORT} is in use`);
  const authorPortFree = await isPortFree(AUTHOR_PORT);

  log('building the public site with an unreachable author origin');
  const buildExit = await runLogged(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build', '--workspace', '@selfpage/site', '--', '--force'],
    {
      cwd: root,
      env: { ...process.env, PUBLIC_AUTHOR_ORIGIN: AUTHOR_ORIGIN, BASE_PATH: '/', FORCE_COLOR: '0' },
      shell: process.platform === 'win32',
    },
    logs.build,
    'npm run build --workspace @selfpage/site',
  );
  if (buildExit !== 0) throw new Error(`site build failed (exit ${buildExit}); see ${logs.build}`);

  log(`starting static preview on ${PORT}`);
  const previewLog = openLog(
    logs.preview,
    `# astro preview\ncwd: ${siteDir}\nstarted: ${new Date().toISOString()}\n\n`,
  );
  const preview = spawn(
    process.execPath,
    [astroBin, 'preview', '--host', '127.0.0.1', '--port', String(PORT)],
    {
      cwd: siteDir,
      env: { ...process.env, PUBLIC_AUTHOR_ORIGIN: AUTHOR_ORIGIN, BASE_PATH: '/' },
      stdio: ['ignore', previewLog.fd, previewLog.fd],
      windowsHide: true,
    },
  );
  children.push({ child: preview, logFile: previewLog });
  await waitForSite();
  log('site preview is ready; no author Worker has been started');

  const playwrightExit = await new Promise((resolvePromise) => {
    const logFile = openLog(
      logs.playwright,
      `# independent A01 Playwright\nstarted: ${new Date().toISOString()}\n\n`,
    );
    const child = spawn(
      process.execPath,
      [playwrightBin, 'test', '--config', 'playwright.config.ts', 'tests/e2e/independent-author-isolation.spec.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          E2E_BASE_URL: `http://127.0.0.1:${PORT}`,
          INDEP_AUTHOR_ORIGIN: AUTHOR_ORIGIN,
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

  return { playwrightExit, authorPortFree };
}

try {
  const result = await main();
  const scan = scanSite();
  const report = {
    status: result.playwrightExit === 0 && scan.status === 'PASS' ? 'PASS' : 'REVIEW',
    startedAt: RUN_STARTED_AT,
    finishedAt: new Date().toISOString(),
    port: PORT,
    authorOriginMarker: AUTHOR_ORIGIN,
    authorWorkerStarted: false,
    authorPort43262ListeningBeforeProbe: !result.authorPortFree,
    playwrightExit: result.playwrightExit,
    publicSiteScan: scan,
    logs,
  };
  writeFileSync(logs.run, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  log(`public site scan: ${scan.status} (${scan.findings.length} findings)`);
  log(`independent A01: ${report.status}`);
  exitCode = result.playwrightExit === 0 ? 0 : 1;
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
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}

process.exit(exitCode);
