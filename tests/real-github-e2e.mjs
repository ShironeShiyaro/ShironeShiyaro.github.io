#!/usr/bin/env node
/**
 * Task 07 Tier 2 real-GitHub E2E (A20).
 *
 * DEFAULT SKIP. Runs only with REAL_GITHUB_E2E=1, against the dedicated test
 * App (`selfpage-publish-test`) and test repository, with credentials supplied
 * by the local gitignored `.dev.vars` through Wrangler (`--env-file`).
 *
 * Manual boundary: the script opens a HEADED browser at http://localhost:8787
 * and the user personally clicks "Continue with GitHub", signs in and
 * authorizes. The script never fills credentials, never reads `.dev.vars`
 * values, never prints OAuth code/state, and never writes the main site repo.
 *
 * Automated boundary: after the user finishes authorization, the script fills a
 * test post, clicks Publish once, then verifies the commit/file through the
 * public GitHub API and reports residual cleanup.
 *
 * Usage:
 *   $env:REAL_GITHUB_E2E=1
 *   node tests/real-github-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanPersistDirs as cleanPersistStore } from './author-e2e/persist-dirs.mjs';
import { assertDedicatedTestRepository } from './author-e2e/github/real-e2e-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const authorDir = join(root, 'apps', 'author');
// R09-19: test output goes to gitignored test-results/, never below docs_AI/记录/.
const assetsDir = join(root, 'test-results', 'real-github-e2e');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const devVars = join(root, '.dev.vars');
const BASE_URL = 'http://localhost:8787';
const PORT = 8787;
const INSPECTOR_PORT = 9235;
const OWNER = 'ShironeShiyaro';
const REPO = 'selfpage-publish-test';
const BRANCH = 'main';
const RUN_STARTED_AT = new Date().toISOString();
const logs = {
  build: join(assetsDir, 'real-github-e2e-build.log'),
  worker: join(assetsDir, 'real-github-e2e-worker.log'),
  script: join(assetsDir, 'real-github-e2e-script.log'),
  report: join(assetsDir, 'real-github-e2e-report.json'),
};
const children = [];
let browser = null;
let exitCode = 0;

function log(message) {
  process.stdout.write(`[real-github-e2e] ${message}\n`);
}

function redact(text) {
  return text
    .replace(/\b(ghu_|ghr_)[A-Za-z0-9_]+/gu, '$1[redacted]')
    .replace(/\b(client_secret|access_token|refresh_token|code_verifier|code|state)=([^&\s]+)/gu, '$1=[redacted]');
}

function openLog(path, header) {
  mkdirSync(assetsDir, { recursive: true });
  const fd = openSync(path, 'w');
  writeSync(fd, header);
  return { path, fd, closed: false };
}

function append(logFile, text) {
  if (!logFile.closed) {
    try {
      writeSync(logFile.fd, redact(text));
    } catch {
      // closed
    }
  }
}

function closeLog(logFile, footer = '') {
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
  try {
    writeFileSync(logFile.path, redact(readFileSync(logFile.path, 'utf8')), 'utf8');
  } catch {
    // leave the log as-is
  }
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

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.status === 'ok') {
          return true;
        }
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  throw new Error(`Worker did not become healthy: ${lastError}`);
}

function stopChildren() {
  for (const entry of children) {
    const pid = entry.child.pid;
    if (pid && entry.child.exitCode === null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
    closeLog(entry.logFile, `\nstopped at ${new Date().toISOString()}\n`);
  }
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function verifyWithPublicApi(commit) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'SelfPage-Real-E2E',
    'x-github-api-version': '2022-11-28',
  };
  const commitResponse = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/commits/${commit.sha}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!commitResponse.ok) {
    return { ok: false, limited: true, reason: `commit API HTTP ${commitResponse.status}` };
  }
  const commitBody = await commitResponse.json();
  const files = Array.isArray(commitBody.files) ? commitBody.files : [];
  const expected = files.length === 1 && files[0].filename === commit.path && files[0].status === 'added';
  const messageMatches =
    typeof commitBody.commit?.message === 'string' && commitBody.commit.message.includes('Draft-ID:');
  const contentsResponse = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${commit.path.split('/').map(encodeURIComponent).join('/')}?ref=${BRANCH}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  let contentMatches = false;
  if (contentsResponse.ok) {
    const contents = await contentsResponse.json();
    if (typeof contents.content === 'string') {
      contentMatches =
        Buffer.from(contents.content.replace(/\n/gu, ''), 'base64').toString('utf8') === commit.markdown;
    }
  }
  return {
    ok: expected && messageMatches && contentMatches,
    files: files.map((file) => ({ filename: file.filename, status: file.status })),
    expected,
    messageMatches,
    contentMatches,
    commitUrl: commitBody.html_url,
  };
}

async function main() {
  if (process.env.REAL_GITHUB_E2E !== '1') {
    log('SKIP: set REAL_GITHUB_E2E=1 to run the real GitHub Tier 2 test.');
    writeFileSync(
      logs.report,
      `${JSON.stringify(
        {
          status: 'NOT RUN',
          reason: 'REAL_GITHUB_E2E is not 1',
          required: 'REAL_GITHUB_E2E=1 and a filled root .dev.vars; user completes GitHub authorization in the headed browser',
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return { skipped: true };
  }

  mkdirSync(assetsDir, { recursive: true });
  log('This test opens a HEADED browser. You must complete GitHub sign-in/authorization yourself.');
  if (!existsSync(devVars)) {
    throw new Error('The root .dev.vars file is missing; ask the user to fill the test App credentials.');
  }
  if (await portIsOccupied(PORT)) {
    throw new Error(`Port ${PORT} is already in use; close the other author dev server first.`);
  }

  // P2-4: a real run also starts from a clean Durable Object store
  // (tests/author-e2e/persist-dirs.mjs). Previous sessions/publish rows in
  // `.wrangler/real-github-e2e` would otherwise silently influence this one.
  cleanPersistStore(authorDir, ['.wrangler/real-github-e2e']);

  log('building the author client');
  const buildExit = await runLogged(
    process.execPath,
    [viteBin, 'build'],
    { cwd: authorDir },
    logs.build,
    'vite build',
  );
  if (buildExit !== 0) {
    throw new Error(`vite build failed (${buildExit}); see ${logs.build}`);
  }

  log(`starting author Worker on ${PORT} in production mode (test clock/mock routes 404)`);
  startLogged(
    process.execPath,
    [
      wranglerBin,
      'dev',
      '--port',
      String(PORT),
      '--inspector-port',
      String(INSPECTOR_PORT),
      '--persist-to',
      '.wrangler/real-github-e2e',
      '--env-file',
      '../../.dev.vars',
    ],
    { cwd: authorDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    logs.worker,
    'author Worker (Tier 2)',
  );
  await waitForHealth();

  const sessionProbe = await fetch(`${BASE_URL}/api/session`);
  if (sessionProbe.status === 404) {
    throw new Error(
      'The Worker did not load GitHub configuration from .dev.vars (try `wrangler dev --env-file ../../.dev.vars`).',
    );
  }
  const clockProbe = await fetch(`${BASE_URL}/api/test/clock`, { method: 'POST' });
  if (clockProbe.status !== 404) {
    throw new Error('Test clock is not 404 in production mode; refusing the Tier 2 run.');
  }

  browser = await chromium.launch({ channel: 'msedge', headless: false });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/`);
  await page.getByTestId('post-title').waitFor({ state: 'visible' });
  await page.getByTestId('auth-continue').waitFor({ state: 'visible' });

  log('ACTION REQUIRED: in the browser window, click "Continue with GitHub", then sign in and authorize the test App.');
  log('Do NOT paste credentials into this chat. Waiting up to 5 minutes for the user to finish...');

  const waitStarted = Date.now();
  const timeoutMs = Number(process.env.REAL_GITHUB_E2E_TIMEOUT_MS ?? 300_000);
  let authorized = false;
  while (Date.now() - waitStarted < timeoutMs) {
    if (await page.getByText(/Signed in with GitHub as/).isVisible().catch(() => false)) {
      authorized = true;
      break;
    }
    await page.waitForTimeout(1_500);
  }
  if (!authorized) {
    throw new Error('NOT RUN: the user did not complete GitHub authorization within the wait window.');
  }

  const accountText = await page.locator('.status-panel--auth').innerText();
  log(`authorization completed (${/as @[^\s.]+/u.exec(accountText)?.[0] ?? 'account hidden'})`);

  // A20/P1-4: the Worker decides the write target from `.dev.vars`. Verify
  // that target before filling the form or clicking Publish; a main-repository
  // misconfiguration must abort with zero writes. The probe runs in the page so
  // it uses the real same-origin session Cookie.
  const authorizedSessionProbe = await page.evaluate(async () => {
    try {
      const response = await fetch('/api/session', { headers: { accept: 'application/json' } });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      return { status: 0, body: null };
    }
  });
  const repositoryGuard = assertDedicatedTestRepository(
    authorizedSessionProbe.status === 200 ? authorizedSessionProbe.body : null,
  );
  if (!repositoryGuard.ok) {
    throw new Error(
      `${repositoryGuard.reason} Refusing to publish: the configured repository is not the dedicated test repository ` +
        `(${OWNER}/${REPO}, id 1471620960). Nothing was published and no repository write was attempted.`,
    );
  }
  log(
    `repository guard passed: ${repositoryGuard.repo.fullName} (id ${repositoryGuard.repo.id}) is the dedicated test repository`,
  );

  const draftSuffix = Date.now().toString(36);
  const title = `SelfPage E2E 中文标题 ${draftSuffix}`;
  const body = `Tier 2 real GitHub publish check ${draftSuffix}.\n\n- one\n- two\n`;
  await page.getByTestId('post-title').evaluate((element, value) => {
    element.textContent = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }, title);
  await page.getByTestId('post-body').evaluate((element, value) => {
    element.textContent = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }, body);

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/posts') && response.request().method() === 'POST',
    { timeout: 60_000 },
  );
  await page.getByTestId('publish-button').click();
  const response = await responsePromise;
  const payload = await readJsonResponse(response);
  if (response.status() !== 201 || !payload?.commit) {
    throw new Error(`publish failed: HTTP ${response.status()} ${JSON.stringify(payload)}`);
  }

  const commit = {
    sha: payload.commit.sha,
    url: payload.commit.url ?? `https://github.com/${OWNER}/${REPO}/commit/${payload.commit.sha}`,
    path: payload.commit.path,
    markdown: payload.markdown,
    timestamp: payload.timestamp,
    date: payload.date,
  };
  log(`published path=${commit.path} sha=${commit.sha}`);

  let deployment = null;
  try {
    const deploymentResponse = await fetch(`${BASE_URL}/api/deployments/${commit.sha}`);
    deployment = { status: deploymentResponse.status, body: await readJsonResponse(deploymentResponse) };
  } catch (error) {
    deployment = { status: 0, error: error instanceof Error ? error.message : String(error) };
  }

  let verification;
  try {
    verification = await verifyWithPublicApi(commit);
  } catch (error) {
    verification = { ok: false, limited: true, reason: error instanceof Error ? error.message : String(error) };
  }

  const expectedSuffix = new RegExp(`-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}\\.md$`, 'u');
  if (!expectedSuffix.test(commit.path) || !commit.path.includes('SelfPage E2E 中文标题')) {
    throw new Error(`unexpected published path: ${commit.path}`);
  }
  if (!commit.markdown.includes(`# ${title}`) || !commit.markdown.includes(`date: ${commit.date}`)) {
    throw new Error('published Markdown does not match the serializer contract');
  }

  const result = {
    status: verification.ok ? 'PASS' : verification.limited ? 'LIMITED' : 'FAIL',
    startedAt: RUN_STARTED_AT,
    finishedAt: new Date().toISOString(),
    command: 'REAL_GITHUB_E2E=1 node tests/real-github-e2e.mjs',
    workerMode: 'production (no APP_ENV); test clock and mock routes return 404',
    manualSteps: [
      'Open http://localhost:8787 in the headed browser',
      'Click "Continue with GitHub"',
      'Sign in and authorize the dedicated test App on the test repository only',
    ],
    automatedSteps: [
      'Assert /api/session repo id/full name is the dedicated test repository before any publish',
      'Fill a Chinese-title Markdown post and click Publish once',
      'Verify the public commit/file and report the commit SHA/URL',
    ],
    repositoryGuard: { status: 'PASS', repo: repositoryGuard.repo },
    commit,
    verification,
    deployment,
    actionsToPublicArticle: {
      status: 'NOT RUN',
      reason:
        'The dedicated test repository has no site source or GitHub Pages workflow, so Actions → public article cannot be verified there.',
    },
    cleanup: {
      status: 'MANUAL',
      path: commit.path,
      sha: commit.sha,
      instruction:
        'Ask the user before deleting. If approved, delete this one file with a separate commit and keep the SHAs in the report.',
    },
  };
  writeFileSync(logs.report, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  log(`verification=${result.status}; commit=${commit.sha}; path=${commit.path}`);
  log('Cleanup is manual (not performed): ' + commit.path + ' @ ' + commit.sha);
  return result;
}

try {
  const result = await main();
  if (!result?.skipped && result.status !== 'PASS') {
    exitCode = 1;
  }
} catch (error) {
  const failure = error instanceof Error ? error.message : String(error);
  log(`FAILED/NOT RUN: ${failure}`);
  writeFileSync(
    logs.report,
    `${JSON.stringify(
      {
        status: failure.startsWith('NOT RUN') ? 'NOT RUN' : 'FAIL',
        startedAt: RUN_STARTED_AT,
        finishedAt: new Date().toISOString(),
        failure,
        manualSteps: [
          'Open http://localhost:8787 in the headed browser',
          'Click "Continue with GitHub"',
          'Sign in and authorize the dedicated test App on the test repository only',
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  exitCode = 1;
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  stopChildren();
}

process.exit(exitCode);
