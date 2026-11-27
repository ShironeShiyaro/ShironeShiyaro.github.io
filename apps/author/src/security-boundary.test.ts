/**
 * Task 07 security-boundary unit tests.
 *
 * These do not need a Worker runtime: they cover the pure guards and crypto
 * primitives that the Durable Object relies on before any GitHub request.
 */
import { describe, expect, it } from 'vitest';
import {
  findEncodedSeparator,
  findLevelOneHeading,
  findRawPathSeparator,
} from '../worker/content-guard.ts';
import {
  assertSafePublishPath,
  buildPublishPlan,
  validatePublishPayload,
} from '../worker/validate.ts';
import {
  bytesToBase64,
  decryptSecret,
  encryptSecret,
  randomToken,
  timingSafeEqual,
} from '../worker/crypto.ts';
import {
  hasAnyGitHubConfiguration,
  isMockSurfaceEnabled,
  resolveGitHubConfig,
  type AuthorWorkerEnv,
} from '../worker/env.ts';

const VALID_IDS = {
  draftId: '2f9c2b1e-5c7a-4b6e-9f0d-3a1b2c3d4e5f',
  attemptId: 'attempt-0001',
};

function configuredEnv(overrides: Partial<AuthorWorkerEnv> = {}): AuthorWorkerEnv {
  return {
    ASSETS: { fetch: async () => new Response('') },
    SESSION_SECRET: 's'.repeat(48),
    TOKEN_ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(7)),
    GITHUB_APP_CLIENT_ID: 'Iv23liTestClientId',
    GITHUB_APP_CLIENT_SECRET: 'test-client-secret-value',
    GITHUB_APP_ID: '5919244',
    GITHUB_ALLOWED_USER_ID: '315736688',
    GITHUB_ALLOWED_REPO_ID: '1471620960',
    GITHUB_REPO_OWNER: 'ShironeShiyaro',
    GITHUB_REPO_NAME: 'selfpage-publish-test',
    GITHUB_REPO_BRANCH: 'main',
    GITHUB_CONTENT_ROOT: 'content/blog',
    ...overrides,
  };
}

describe('body single-H1 guard', () => {
  it('rejects ATX H1 outside fenced code and accepts H2/body text', () => {
    expect(findLevelOneHeading('normal body')).toBeNull();
    expect(findLevelOneHeading('## Second level is allowed')).toBeNull();
    expect(findLevelOneHeading('# Extra title')).toEqual({ line: 1, text: 'Extra title' });
    expect(findLevelOneHeading('text\n\n# Extra title\nmore')).toEqual({
      line: 3,
      text: 'Extra title',
    });
    expect(findLevelOneHeading('  ### not level one')).toBeNull();
    expect(findLevelOneHeading('#hashtag')).toBeNull();
  });

  it('ignores hashes inside backtick and tilde fences', () => {
    const body = '```md\n# inside fence\n```\n\n~~~\n# inside tilde\n~~~\n';
    expect(findLevelOneHeading(body)).toBeNull();
  });

  it('rejects a Setext H1 outside a fence', () => {
    expect(findLevelOneHeading('Another title\n===')).toEqual({
      line: 2,
      text: 'Another title',
    });
    expect(findLevelOneHeading('text\n\n---\n')).toBeNull();
  });

  it('handles CRLF input', () => {
    expect(findLevelOneHeading('line\r\n\r\n# H1\r\n')).toEqual({ line: 3, text: 'H1' });
  });
});

describe('title path-smuggling guards', () => {
  it('detects raw separators, NUL and percent-encoded separators', () => {
    expect(findRawPathSeparator('../.github/workflows/pwn.yml')).toBe('/');
    expect(findRawPathSeparator('C:\\temp')).toBe('\\');
    expect(findRawPathSeparator('safe title')).toBeNull();
    expect(findEncodedSeparator('..%2f..%2f.github')).toBe('%2f');
    expect(findEncodedSeparator('%2e%2e%5c')).toBe('%2e%2e');
    expect(findEncodedSeparator('100% done')).toBeNull();
  });
});

describe('strict publish payload', () => {
  it('accepts the documented structured shape and rejects unknown fields', () => {
    const accepted = validatePublishPayload({
      title: '中文标题',
      body: 'Body',
      ...VALID_IDS,
      newTimestamp: true,
    });
    expect(accepted.ok).toBe(true);

    const unexpected = validatePublishPayload({
      title: 'Title',
      body: 'Body',
      ...VALID_IDS,
      path: '../.github/workflows/pwn.yml',
      author: 'attacker',
    });
    expect(unexpected.ok).toBe(false);
    if (!unexpected.ok) {
      expect(unexpected.status).toBe(422);
      expect(unexpected.issues[0]?.code).toBe('unexpected_field');
    }
  });

  it('rejects invalid identifiers and non-boolean newTimestamp', () => {
    for (const ids of [
      { draftId: '', attemptId: 'a' },
      { draftId: '../../etc/passwd', attemptId: 'a' },
      { draftId: 'ok', attemptId: 'a'.repeat(200) },
    ]) {
      const result = validatePublishPayload({ title: 'T', body: 'B', ...ids });
      expect(result.ok).toBe(false);
    }
    const newTimestamp = validatePublishPayload({
      title: 'T',
      body: 'B',
      ...VALID_IDS,
      newTimestamp: 'yes',
    });
    expect(newTimestamp.ok).toBe(false);
  });

  it('rejects traversal titles, encoded separators and extra H1 bodies', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ title: '../.github/workflows/pwn.yml', body: 'B' }, 'title_path_separator'],
      [{ title: '..\\pwn', body: 'B' }, 'title_path_separator'],
      [{ title: '..%2f.github', body: 'B' }, 'title_encoded_separator'],
      [{ title: 'Title', body: '# Extra H1' }, 'body_extra_h1'],
      [{ title: 'Title', body: '```\n# not H1\n```\n# real H1' }, 'body_extra_h1'],
    ];
    for (const [input, code] of cases) {
      const result = validatePublishPayload({ ...input, ...VALID_IDS });
      expect(result.ok, code).toBe(false);
      if (!result.ok) {
        expect(result.issues.map((issue) => issue.code)).toContain(code);
      }
    }
  });
});

describe('serializer plan guards', () => {
  const instant = Date.parse('2026-11-23T15:42:15Z');

  it('keeps Chinese characters in the generated path and matches the front matter date', () => {
    const result = buildPublishPlan({ title: '终于写好了这个页面', body: '正文' }, instant);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.path).toBe(
        'content/blog/2026/终于写好了这个页面-2026-11-23-23-42-15.md',
      );
      expect(result.plan.post.frontMatter).toContain('date: 2026-11-23');
      expect(result.plan.post.visibleMarkdown.startsWith('# 终于写好了这个页面\n\n2026-11-23')).toBe(
        true,
      );
    }
  });

  it('rejects 61 code points, >232 safe UTF-8 bytes and >256 KiB bodies', () => {
    const long = buildPublishPlan({ title: 'a'.repeat(61), body: 'B' }, instant);
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.issues.map((issue) => issue.code)).toContain('title_too_long');
    }

    const bytes = buildPublishPlan({ title: '😀'.repeat(59), body: 'B' }, instant);
    expect(bytes.ok).toBe(false);
    if (!bytes.ok) {
      expect(bytes.issues.map((issue) => issue.code)).toContain('title_filename_too_long');
    }

    const body = buildPublishPlan({ title: 'T', body: 'x'.repeat(256 * 1024 + 1) }, instant);
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.issues.map((issue) => issue.code)).toContain('body_too_large');
    }
  });

  it('asserts the exact content root/shape and rejects unsafe paths', () => {
    expect(assertSafePublishPath('content/blog/2026/A-2026-11-23-23-42-15.md', 'A-2026-11-23-23-42-15.md', '2026-11-23')).toEqual([]);
    expect(
      assertSafePublishPath('content/other/2026/a.md', 'a.md', '2026-11-23'),
    ).not.toEqual([]);
    expect(
      assertSafePublishPath('content/blog/2026/../pwn.md', '../pwn.md', '2026-11-23'),
    ).not.toEqual([]);
    expect(
      assertSafePublishPath('content/blog/2026/..', '..', '2026-11-23'),
    ).not.toEqual([]);
  });
});

describe('AES-GCM token storage', () => {
  it('round-trips a token and rejects a different key or tampering', async () => {
    const key = bytesToBase64(new Uint8Array(32).fill(3));
    const otherKey = bytesToBase64(new Uint8Array(32).fill(4));
    const cipher = await encryptSecret('ghu_example_token_value', key);
    expect(cipher.startsWith('v1.')).toBe(true);
    expect(cipher).not.toContain('ghu_');
    await expect(decryptSecret(cipher, key)).resolves.toBe('ghu_example_token_value');
    await expect(decryptSecret(cipher, otherKey)).rejects.toBeTruthy();
    const parts = cipher.split('.');
    await expect(
      decryptSecret(`${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -2)}xx`, key),
    ).rejects.toBeTruthy();
  });

  it('generates distinct URL-safe opaque values', () => {
    const first = randomToken(32);
    const second = randomToken(32);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it('accepts a long passphrase as key material', async () => {
    const passphrase = 'a-long-random-deployment-passphrase-32+';
    const cipher = await encryptSecret('ghu_passphrase_token', passphrase);
    await expect(decryptSecret(cipher, passphrase)).resolves.toBe('ghu_passphrase_token');
  });

  it('compares strings without early length-dependent success', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('configuration', () => {
  it('accepts a complete config and ignores test GitHub bases in production', () => {
    const normal = resolveGitHubConfig(configuredEnv());
    expect(normal.ok).toBe(true);
    if (normal.ok) {
      expect(normal.config.apiBase).toBe('https://api.github.com');
      expect(normal.config.oauthBase).toBe('https://github.com');
      expect(normal.config.testGitHub).toBe(false);
    }

    const productionWithBase = resolveGitHubConfig(
      configuredEnv({ GITHUB_API_BASE: 'http://127.0.0.1:43261', GITHUB_OAUTH_BASE: 'http://127.0.0.1:43261' }),
    );
    expect(productionWithBase.ok).toBe(true);
    if (productionWithBase.ok) {
      expect(productionWithBase.config.apiBase).toBe('https://api.github.com');
      expect(productionWithBase.config.testGitHub).toBe(false);
    }

    const testWithBase = resolveGitHubConfig(
      configuredEnv({
        APP_ENV: 'test',
        GITHUB_API_BASE: 'http://127.0.0.1:43261',
        GITHUB_OAUTH_BASE: 'http://127.0.0.1:43261',
      }),
    );
    expect(testWithBase.ok).toBe(true);
    if (testWithBase.ok) {
      expect(testWithBase.config.apiBase).toBe('http://127.0.0.1:43261');
      expect(testWithBase.config.testGitHub).toBe(true);
    }
  });

  it('rejects invalid numeric IDs, a misplaced content root and bad keys without echoing values', () => {
    const numeric = resolveGitHubConfig(configuredEnv({ GITHUB_ALLOWED_REPO_ID: 'not-a-number' }));
    expect(numeric.ok).toBe(false);
    if (!numeric.ok) {
      expect(numeric.invalid).toContain('GITHUB_ALLOWED_REPO_ID');
      expect(JSON.stringify(numeric)).not.toContain('not-a-number');
    }

    const root = resolveGitHubConfig(configuredEnv({ GITHUB_CONTENT_ROOT: 'content/secret' }));
    expect(root.ok).toBe(false);

    const badKey = resolveGitHubConfig(
      configuredEnv({ TOKEN_ENCRYPTION_KEY: bytesToBase64(new Uint8Array(16)) }),
    );
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) {
      expect(badKey.invalid).toContain('TOKEN_ENCRYPTION_KEY');
    }

    expect(
      resolveGitHubConfig(configuredEnv({ TOKEN_ENCRYPTION_KEY: 'p'.repeat(40) })).ok,
    ).toBe(true);
    expect(
      resolveGitHubConfig(configuredEnv({ TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) })).ok,
    ).toBe(true);
  });

  it('detects an entirely unconfigured build and the mock surface', () => {
    expect(hasAnyGitHubConfiguration({ ASSETS: { fetch: async () => new Response('') } })).toBe(false);
    expect(hasAnyGitHubConfiguration(configuredEnv())).toBe(true);
    expect(isMockSurfaceEnabled(configuredEnv({ APP_ENV: 'test' }))).toBe(true);
    expect(
      isMockSurfaceEnabled(
        configuredEnv({ APP_ENV: 'test', GITHUB_API_BASE: 'http://127.0.0.1:43261' }),
      ),
    ).toBe(false);
    expect(isMockSurfaceEnabled(configuredEnv({ APP_ENV: 'production' }))).toBe(false);
  });
});
