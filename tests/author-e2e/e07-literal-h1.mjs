#!/usr/bin/env node
/**
 * P0-2 end-to-end evidence: a published H1 with Markdown-looking characters is
 * literal text on the public article page.
 *
 * Steps:
 * 1. serialize a post through @selfpage/markdown and write the generated .md
 *    into a temporary content root (never repo `content/`);
 * 2. build the real Astro site with SELF_PAGE_CONTENT_ROOT pointing at that
 *    temp root and `--outDir` pointing INSIDE the temp root (repo
 *    `apps/site/dist` is never touched);
 * 3. serve that isolated build with a tiny static server on 43245 (not
 *    `astro preview`, so no repo dist/lock is involved) and open the article
 *    with system Edge;
 * 4. assert the single page H1's text equals the original title exactly and
 *    the H1 contains no rendered inline elements (no `<em>` from `*Stars*`,
 *    no swallowed `<Tags>`), while the file name still replaces `< > " | *`.
 *
 * Failure handling: every failure throws, the JSON is written once in
 * `finally` with status FAIL, and the process exits non-zero. It can never
 * overwrite a FAIL with PASS. Use SELF_PAGE_E07_FORCE_H1_MISMATCH=1 to verify
 * that failure path end to end (expects exit 1 and status FAIL).
 *
 * Do not run this script in parallel with the site E2E/preview port range:
 * it uses 43245 and an isolated temp build, but disk/CPU contention would make
 * the evidence noisy.
 *
 * Usage: node tests/author-e2e/e07-literal-h1.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { planPublish } from '../../packages/markdown/src/index.ts';
import { deriveBlogRoute, sanitizeBlogTitleForFileName } from '../../packages/content-model/src/slug.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
// R09-6 (task 09): this script used to write its build/preview/result files
// into `docs_AI/记录/r06/assets/`, overwriting task 06's tracked evidence on
// every run. Output now goes to the gitignored `test-results/author-e2e/`.
const assetsDir = join(repoRoot, 'test-results', 'author-e2e');
const contentDir = join(repoRoot, 'content');
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const PREVIEW_PORT = 43245;
const TITLE = 'Quotes "And" *Stars* <Tags> | Pipes';
const DATE = '2026-11-23';
const INSTANT = Date.parse('2026-11-23T15:42:15Z');
const FORCE_H1_MISMATCH = process.env.SELF_PAGE_E07_FORCE_H1_MISMATCH === '1';
const logs = {
  build: join(assetsDir, 'fix2-e07-site-build.log'),
  preview: join(assetsDir, 'fix2-e07-preview.log'),
  result: join(assetsDir, 'fix2-e07-literal-h1.json'),
};

class ProbeFailure extends Error {}

let previewServer = null;
let tempRoot = null;
let browser = null;
const report = {
  title: TITLE,
  date: DATE,
  status: 'FAIL',
  forcedFailureInjection: FORCE_H1_MISMATCH,
  checks: {},
};

function log(message) {
  process.stdout.write(`[e07-literal-h1] ${message}\n`);
}

/** Marks the run failed and stops immediately; the outer finally writes FAIL. */
function fail(message) {
  report.status = 'FAIL';
  report.failure = message;
  log(`FAILED: ${message}`);
  throw new ProbeFailure(message);
}

function writeResult() {
  writeFileSync(logs.result, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function freePort(port) {
  return new Promise((resolvePromise) => {
    const server = createNetServer();
    server.once('error', () => resolvePromise(false));
    server.once('listening', () => server.close(() => resolvePromise(true)));
    server.listen(port, '127.0.0.1');
  });
}

function killTree(pid) {
  if (!pid) {
    return;
  }
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

/** Runs a child with a hard timeout; stdout/stderr go straight to a UTF-8 log file. */
function runLogged(command, args, options, logPath, timeoutMs = 180_000) {
  return new Promise((resolvePromise) => {
    const fd = openSync(logPath, 'w');
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    let settled = false;
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      resolvePromise(code);
    };
    const timer = setTimeout(() => {
      log(`command timed out after ${timeoutMs}ms; killing child`);
      killTree(child.pid);
      child.once('exit', () => finish(124));
    }, timeoutMs);
    child.once('error', (error) => {
      log(`spawn error: ${error.message}`);
      finish(1);
    });
    child.once('exit', (code) => finish(code ?? 1));
  });
}

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function startStaticServer(rootDir, port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
        const relative = pathname.replace(/^\/+/, '');
        let filePath = normalize(join(rootDir, relative));
        if (!filePath.startsWith(normalize(rootDir))) {
          response.writeHead(403).end('forbidden');
          return;
        }
        if (!existsSync(filePath)) {
          response.writeHead(404).end('not found');
          return;
        }
        if (statSync(filePath).isDirectory()) {
          filePath = join(filePath, 'index.html');
        }
        if (!existsSync(filePath)) {
          response.writeHead(404).end('not found');
          return;
        }
        response.writeHead(200, {
          'content-type': MIME.get(extname(filePath)) ?? 'application/octet-stream',
        });
        createReadStream(filePath).pipe(response);
      } catch {
        response.writeHead(500).end('server error');
      }
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

async function waitForUrl(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  throw new Error(`static preview did not answer for ${url}: ${last}`);
}

function stopServers() {
  if (browser) {
    void browser.close().catch(() => {});
    browser = null;
  }
  if (previewServer) {
    previewServer.close();
    previewServer = null;
  }
}

try {
  mkdirSync(assetsDir, { recursive: true });
  if (!(await freePort(PREVIEW_PORT))) {
    fail(`port ${PREVIEW_PORT} is already in use`);
  }

  const planned = planPublish({ title: TITLE, body: 'Body after the literal heading.' }, INSTANT);
  if (!planned.ok) {
    fail(`serializer rejected the E07 title: ${JSON.stringify(planned.errors)}`);
  }
  const { post, fileName, path, timestamp } = planned.plan;
  report.serialized = {
    fileName,
    path,
    timestamp: timestamp.timestamp,
    frontMatter: post.frontMatter,
    visibleMarkdown: post.visibleMarkdown,
  };

  const expectedSafeTitle = sanitizeBlogTitleForFileName(TITLE);
  report.checks.fileNameUsesD22Sanitizer = fileName.startsWith(`${expectedSafeTitle}-`);
  report.checks.fileNameHasNoReplacedCharacters = !/[<>"|*]/.test(fileName);
  if (!report.checks.fileNameUsesD22Sanitizer) {
    fail(`unexpected file name: ${fileName}`);
  }
  if (!report.checks.fileNameHasNoReplacedCharacters) {
    fail(`file name still has < > " | *: ${fileName}`);
  }

  mkdirSync(join(repoRoot, '_tmp'), { recursive: true });
  tempRoot = mkdtempSync(join(repoRoot, '_tmp', 'e07-'));
  const tempContent = join(tempRoot, 'content');
  const outDir = join(tempRoot, 'site-dist');
  cpSync(contentDir, tempContent, { recursive: true });
  const relativeMarkdownPath = path.replace(/^content\//, '');
  const targetPath = join(tempContent, relativeMarkdownPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, post.markdown, 'utf8');
  const relativeWithoutExtension = relativeMarkdownPath.replace(/^blog\//, '').replace(/\.md$/, '');
  const route = deriveBlogRoute(relativeWithoutExtension);
  // Keep the temp build on the repository volume: Astro's asset move uses
  // rename(2) and fails with EXDEV when outDir is on another drive (e.g. %TEMP%).
  report.article = { relativePath: relativeMarkdownPath, route };

  log('building the public site against the temporary content root and isolated outDir');
  const build = await runLogged(
    process.execPath,
    [npmCli, 'run', 'build', '--workspace', '@selfpage/site', '--', '--outDir', outDir],
    { cwd: repoRoot, env: { ...process.env, SELF_PAGE_CONTENT_ROOT: tempContent } },
    logs.build,
  );
  report.buildExitCode = build;
  if (build !== 0) {
    fail(`site build failed with exit code ${build}; see ${logs.build}`);
  }

  writeFileSync(logs.preview, `static server root: ${outDir}\nport: ${PREVIEW_PORT}\n`, 'utf8');
  previewServer = await startStaticServer(outDir, PREVIEW_PORT);
  log(`serving isolated build on ${PREVIEW_PORT}`);

  const articleUrl = `http://127.0.0.1:${PREVIEW_PORT}/${route}`;
  report.article.url = articleUrl;
  await waitForUrl(articleUrl);

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(articleUrl, { waitUntil: 'networkidle' });
  const headings = page.locator('main h1');
  const count = await headings.count();
  const h1 = headings.first();
  const h1Text = count === 1 ? await h1.textContent() : null;
  const h1Html = count === 1 ? await h1.innerHTML() : null;
  const childElements = count === 1 ? await h1.locator('*').count() : -1;
  report.article.h1Count = count;
  report.article.h1Text = h1Text;
  report.article.h1Html = h1Html;
  report.article.h1ChildElements = childElements;

  const expectedTitle = FORCE_H1_MISMATCH ? `${TITLE} [forced]` : TITLE;
  report.checks.singleH1 = count === 1;
  report.checks.h1TextIsLiteral = h1Text === expectedTitle;
  report.checks.h1HasNoRenderedInlineMarkup = childElements === 0;
  report.checks.angleBracketsEscaped =
    typeof h1Html === 'string' && h1Html.includes('&lt;Tags&gt;') && !h1Html.includes('<Tags>');

  if (!report.checks.singleH1) {
    fail(`expected one main h1, found ${count}`);
  }
  if (!report.checks.h1TextIsLiteral) {
    fail(`H1 text mismatch: expected ${JSON.stringify(expectedTitle)}, got ${JSON.stringify(h1Text)}`);
  }
  if (!report.checks.h1HasNoRenderedInlineMarkup) {
    fail(`H1 has child elements: ${childElements}`);
  }
  if (!report.checks.angleBracketsEscaped) {
    fail('angle brackets were not escaped as text');
  }

  report.status = 'PASS';
  log('PASS: H1 is literal text and the file name still replaces < > " | *');
} catch (error) {
  if (!(error instanceof ProbeFailure)) {
    report.status = 'FAIL';
    report.failure = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${report.failure}`);
  }
} finally {
  stopServers();
  if (tempRoot) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best effort; OS temp directory
    }
  }
  writeResult();
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
