#!/usr/bin/env node
// Static link checker for a built Astro site.
// Usage: node tests/check-build-links.mjs <dist-dir> <base-path>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

const [, , distArgument, baseArgument = '/'] = process.argv;

if (!distArgument) {
  console.error('Usage: node tests/check-build-links.mjs <dist-dir> <base-path>');
  process.exit(2);
}

const distRoot = resolve(distArgument);
if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
  console.error(`error: dist directory does not exist: ${distRoot}`);
  process.exit(2);
}

const base = normalizeBase(baseArgument);
const basePrefix = base === '/' ? '' : base.slice(0, -1);
const errors = [];
const checked = [];

function normalizeBase(value) {
  if (!value || value === '/') return '/';
  let result = value.trim();
  if (!result.startsWith('/')) result = `/${result}`;
  if (!result.endsWith('/')) result = `${result}/`;
  return result;
}

/** Every file under `directory` whose name satisfies `predicate`. */
function collectFiles(directory, predicate) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(absolutePath, predicate));
    else if (entry.isFile() && predicate(entry.name)) files.push(absolutePath);
  }
  return files;
}

/** HTML pages only; stylesheets use collectFiles with their own predicate. */
function walk(directory) {
  return collectFiles(directory, (name) => name.endsWith('.html'));
}

function toPosix(value) {
  return value.split(sep).join('/');
}

function stripQueryAndHash(value) {
  const hashIndex = value.indexOf('#');
  const hash = hashIndex === -1 ? '' : value.slice(hashIndex + 1);
  const withoutHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  return {
    path: queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex),
    hash,
  };
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveTargetPath(localPath) {
  const decoded = decodePath(localPath);
  const relativePath = decoded.replace(/^\/+/, '');
  const candidate = resolve(distRoot, relativePath);
  if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

function findFile(localPath) {
  const targetPath = resolveTargetPath(localPath);
  if (!targetPath) return null;
  const candidates = [];
  if (localPath.endsWith('/')) {
    candidates.push(join(targetPath, 'index.html'));
  } else {
    if (existsSync(targetPath) && statSync(targetPath).isFile()) candidates.push(targetPath);
    candidates.push(`${targetPath}.html`);
    candidates.push(join(targetPath, 'index.html'));
  }
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function hasAnchor(filePath, hash) {
  if (!hash) return true;
  const html = readFileSync(filePath, 'utf8');
  const decodedHash = decodePath(hash);
  const escaped = decodedHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:id|name)=["']${escaped}["']`).test(html);
}

/**
 * Resolve one site-internal reference to a path inside dist (R09-15).
 *
 * `fromRelativeFile` is the file that contains the reference (an HTML page, a
 * stylesheet, ...), used for relative references. Absolute references must
 * carry BASE_PATH exactly once, exactly like an `href` in the HTML.
 * Returns `{ localPath }` or `{ error }`; the caller decides the message.
 */
function localPathFor(rawPath, fromRelativeFile) {
  if (rawPath.startsWith('/')) {
    if (base !== '/' && !rawPath.startsWith(basePrefix)) {
      return { error: `missing BASE_PATH ${base}` };
    }
    if (base !== '/' && rawPath.startsWith(`${basePrefix}${basePrefix}/`)) {
      return { error: 'contains BASE_PATH twice' };
    }
    return { localPath: basePrefix === '' ? rawPath : rawPath.slice(basePrefix.length) || '/' };
  }
  if (rawPath === '') return { localPath: `/${fromRelativeFile}` };
  const directory = posix.dirname(`/${fromRelativeFile}`);
  return { localPath: posix.resolve(directory, rawPath) };
}

for (const htmlFile of walk(distRoot)) {
  const relativeFile = toPosix(relative(distRoot, htmlFile));
  const html = readFileSync(htmlFile, 'utf8');
  for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
    const rawValue = match[1] ?? '';
    if (
      rawValue === '' ||
      rawValue.startsWith('#') ||
      rawValue.startsWith('//') ||
      /^(?:https?:|mailto:|tel:|data:|blob:)/i.test(rawValue)
    ) {
      if (rawValue.startsWith('#')) {
        if (!hasAnchor(htmlFile, rawValue.slice(1))) {
          errors.push(`${relativeFile}: missing same-page anchor ${rawValue}`);
        }
      }
      continue;
    }
    if (/^javascript:/i.test(rawValue)) {
      errors.push(`${relativeFile}: javascript: URL is not allowed (${rawValue})`);
      continue;
    }

    const { path: rawPath, hash } = stripQueryAndHash(rawValue);
    const resolved = localPathFor(rawPath, relativeFile);
    if (resolved.error) {
      errors.push(`${relativeFile}: internal link ${resolved.error}: ${rawValue}`);
      continue;
    }
    const localPath = resolved.localPath;

    const targetFile = findFile(localPath);
    if (!targetFile) {
      errors.push(`${relativeFile}: broken internal link ${rawValue} (resolved ${localPath})`);
      continue;
    }
    if (hash && !hasAnchor(targetFile, hash)) {
      errors.push(`${relativeFile}: missing anchor #${hash} in ${rawValue}`);
      continue;
    }
    checked.push(`${relativeFile} -> ${rawValue}`);
  }

  // Inline <script> bodies are part of the shipped artifact: a boot script that
  // hard-codes "/demo/blog/nope/" is just as broken as a dead href, and no
  // href/src scanner would see it. Only absolute ('/...') string literals are
  // checked; relative strings in JS are ambiguous and would produce noise.
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=/.test(script[1])) continue;
    for (const literal of (script[2] ?? '').matchAll(/(['"])(\/[^'"\s<>]*)\1/g)) {
      const rawPath = literal[2];
      if (rawPath === '/' || rawPath.startsWith('//') || rawPath.includes('${')) continue;
      const { path: pathOnly } = stripQueryAndHash(rawPath);
      const resolved = localPathFor(pathOnly, relativeFile);
      if (resolved.error) {
        errors.push(`${relativeFile}: inline script path ${resolved.error}: ${rawPath}`);
        continue;
      }
      if (!findFile(resolved.localPath)) {
        errors.push(
          `${relativeFile}: inline script references a missing path ${rawPath} (resolved ${resolved.localPath})`,
        );
        continue;
      }
      checked.push(`${relativeFile} -> script:${rawPath}`);
    }
  }
}

// Stylesheets (R09-15): `background: url(/missing-bg.png)` is an internal
// asset reference that the HTML scan cannot see.
for (const cssFile of collectFiles(distRoot, (name) => name.endsWith('.css'))) {
  const relativeFile = toPosix(relative(distRoot, cssFile));
  const css = readFileSync(cssFile, 'utf8');
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const rawValue = (match[2] ?? '').trim();
    if (
      rawValue === '' ||
      rawValue.startsWith('#') ||
      rawValue.startsWith('//') ||
      /^(?:https?:|data:|blob:)/i.test(rawValue)
    ) {
      continue;
    }
    const { path: rawPath } = stripQueryAndHash(rawValue);
    const resolved = localPathFor(rawPath, relativeFile);
    if (resolved.error) {
      errors.push(`${relativeFile}: stylesheet url ${resolved.error}: ${rawValue}`);
      continue;
    }
    if (!findFile(resolved.localPath)) {
      errors.push(`${relativeFile}: broken stylesheet url ${rawValue} (resolved ${resolved.localPath})`);
      continue;
    }
    checked.push(`${relativeFile} -> url(${rawValue})`);
  }
}

if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} link problem(s) in ${distRoot} (BASE_PATH=${base})`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`PASS: ${checked.length} internal links checked in ${distRoot} (BASE_PATH=${base})`);
for (const entry of checked) console.log(`  ${entry}`);
