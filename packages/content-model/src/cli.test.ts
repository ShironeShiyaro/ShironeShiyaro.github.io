import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cliPath = join(repoRoot, 'packages', 'content-model', 'src', 'cli.ts');
const fixtureRoot = join(repoRoot, 'tests', 'fixtures');
const validRoot = join(fixtureRoot, 'valid', 'minimal', 'content');
const invalidRoot = join(fixtureRoot, 'invalid', 'bad-blog', 'content');
const blogFilenameRoot = join(fixtureRoot, 'invalid', 'blog-filename', 'content');
const manualDateRoot = join(fixtureRoot, 'valid', 'manual-date-warning', 'content');
const timeFallbackRoot = join(fixtureRoot, 'valid', 'time-fallback', 'content');
const securityAuditRoot = join(fixtureRoot, 'valid', 'security-audit', 'content');

const cliEnv = {
  ...process.env,
  BASE_PATH: '/demo/',
  PUBLIC_AUTHOR_ORIGIN: 'https://author.example',
};

function runCli(args: string[], env: NodeJS.ProcessEnv = cliEnv) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
}

describe('content CLI', () => {
  it('validates a valid content root and prints a summary', () => {
    const result = runCli(['validate', validRoot]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Content is valid');
    expect(result.stderr).toContain('duplicate Home heading');
  });

  it('fails a valid-looking invalid root with file paths on stderr', () => {
    const result = runCli(['validate', invalidRoot]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Content validation failed');
    expect(result.stderr).toContain('content/blog/2025/missing-h1-2025-01-01-00-00-00.md');
    expect(result.stderr).toContain('content/blog/2025/date-mismatch-2025-01-03-00-00-00.md');
  });

  it('writes a NavigationManifest with BASE_PATH and PUBLIC_AUTHOR_ORIGIN applied', () => {
    const directory = mkdtempSync(join(tmpdir(), 'selfpage-cli-'));
    try {
      const outputPath = join(directory, 'manifest.json');
      const result = runCli(['manifest', validRoot, outputPath]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Wrote navigation manifest');

      const manifest = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        home: { href: string; children: Array<{ id: string }> };
        publications: { children: unknown[] };
        blog: { href: string; newHref: string; years: Array<{ year: string }> };
      };
      expect(manifest.home.href).toBe('/demo/');
      expect(manifest.home.children.map((child) => child.id)).toEqual(['about-me', 'about-me-2', 'skills']);
      expect(manifest.publications.children).toEqual([]);
      expect(manifest.blog.href).toBe('/demo/blog/');
      expect(manifest.blog.newHref).toBe('https://author.example/new/');
      expect(manifest.blog.years.map((year) => year.year)).toEqual(['2025', '2024']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports the actual content-root path passed to the CLI (T-P2-1)', () => {
    const result = runCli(['validate', 'tests/fixtures/invalid/bad-blog/content']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'tests/fixtures/invalid/bad-blog/content/blog/2025/missing-h1-2025-01-01-00-00-00.md',
    );
  });

  it('rejects a blog file name that breaks the date/title contract', () => {
    const result = runCli(['validate', blogFilenameRoot]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('content/blog/2025/missing-timestamp.md');
    expect(result.stderr).toContain('must end with -YYYY-MM-DD');
    expect(result.stderr).toContain('content/blog/2025/Wrong Title-2025-01-06-00-00-00.md');
    expect(result.stderr).toContain('does not match sanitised H1/title');
  });

  it('warns, but accepts, a missing or invalid file-name time (P1-5/D35)', () => {
    const result = runCli(['validate', timeFallbackRoot]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Content is valid');
    expect(result.stderr).toContain('content/blog/2025/Date Only-2025-01-03.md');
    expect(result.stderr).toContain('no -HH-mm-ss publication time');
    expect(result.stderr).toContain('content/blog/2025/Bad Time-2025-01-04-25-10-10.md');
    expect(result.stderr).toContain('not a valid 24-hour time');
    expect(result.stderr).toContain('only the date is displayed');
  });

  it('warns, but accepts, a manual file-name date mismatch (D11)', () => {
    const result = runCli(['validate', manualDateRoot]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('file name date "2025-01-02" does not match visible date "2025-01-03"');
    expect(result.stderr).toContain('manual content is accepted');
    expect(result.stdout).toContain('Content is valid');
  });

  it('prints the security audit as warnings while accepting trusted content', () => {
    const result = runCli(['validate', securityAuditRoot]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('security audit: raw <script>');
    expect(result.stderr).toContain('security audit: inline event handler');
    expect(result.stderr).toContain('security audit: javascript: link');
  });

  it('reports a missing BASE_PATH trailing slash as a warning (T-P2-2)', () => {
    const result = runCli(['validate', validRoot], { ...cliEnv, BASE_PATH: '/demo' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('missing a trailing slash');
    expect(result.stderr).toContain('/demo/');
  });

  it('exits with a usage error when arguments are missing', () => {
    const validate = runCli(['validate']);
    expect(validate.status).toBe(2);
    expect(validate.stderr).toContain('requires a <content-root>');

    const manifest = runCli(['manifest', validRoot]);
    expect(manifest.status).toBe(2);
    expect(manifest.stderr).toContain('requires <content-root> and <output-file>');

    const unknown = runCli(['nope']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown command');
  });
});
