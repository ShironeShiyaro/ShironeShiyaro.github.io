import { describe, expect, it } from 'vitest';
import {
  buildAuthorNewHref,
  normalizeBasePath,
  resolvePublicUrl,
  withBasePath,
} from './paths.ts';

describe('normalizeBasePath', () => {
  it('normalises the root and missing values', () => {
    expect(normalizeBasePath(undefined)).toBe('/');
    expect(normalizeBasePath('')).toBe('/');
    expect(normalizeBasePath('/')).toBe('/');
  });

  it('adds a trailing slash and keeps one leading slash', () => {
    expect(normalizeBasePath('/demo')).toBe('/demo/');
    expect(normalizeBasePath('/demo/')).toBe('/demo/');
    expect(normalizeBasePath('/a/b')).toBe('/a/b/');
  });

  it('rejects values that cannot be a public base path', () => {
    expect(() => normalizeBasePath('demo')).toThrow(/start with/);
    expect(() => normalizeBasePath('//demo')).toThrow(/protocol-relative/);
    expect(() => normalizeBasePath('/demo//')).toThrow(/empty path segments/);
    expect(() => normalizeBasePath('/demo?x=1')).toThrow(/must not contain/);
    expect(() => normalizeBasePath('/a/../b')).toThrow(/\.\./);
    expect(() => normalizeBasePath('/demo site')).toThrow(/whitespace/);
  });

  it('warns when a missing trailing slash is normalised', () => {
    const warnings: string[] = [];
    expect(normalizeBasePath('/demo', (message) => warnings.push(message))).toBe('/demo/');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('missing a trailing slash');
    expect(warnings[0]).toContain('/demo/');

    const noWarnings: string[] = [];
    expect(normalizeBasePath('/demo/', (message) => noWarnings.push(message))).toBe('/demo/');
    expect(normalizeBasePath('/', (message) => noWarnings.push(message))).toBe('/');
    expect(noWarnings).toEqual([]);
  });
});

describe('withBasePath', () => {
  it('prefixes internal paths exactly once', () => {
    expect(withBasePath('/', '/blog/')).toBe('/blog/');
    expect(withBasePath('/', '/')).toBe('/');
    expect(withBasePath('/demo/', '/blog/')).toBe('/demo/blog/');
    expect(withBasePath('/demo/', '/')).toBe('/demo/');
    expect(withBasePath('/demo/', 'blog/2025/post/')).toBe('/demo/blog/2025/post/');
  });

  it('rejects double base paths instead of silently repairing them', () => {
    expect(() => withBasePath('/demo/', '/demo/blog/')).toThrow(/already contains BASE_PATH/);
    expect(() => withBasePath('/demo/', 'demo/blog/')).toThrow(/already contains BASE_PATH/);
  });

  it('rejects absolute, protocol-relative and malformed internal paths', () => {
    expect(() => withBasePath('/', 'https://example.org/')).toThrow(/must not be an absolute/);
    expect(() => withBasePath('/', '//example.org/')).toThrow(/protocol-relative/);
    expect(() => withBasePath('/', 'blog//post/')).toThrow(/double slash/);
    expect(() => withBasePath('/', 'blog\\post')).toThrow(/separators/);
  });
});

describe('buildAuthorNewHref', () => {
  it('uses the documented default author origin', () => {
    expect(buildAuthorNewHref()).toBe('https://selfpage-author.invalid/new/');
  });

  it('builds the New! URL from a custom origin', () => {
    expect(buildAuthorNewHref('https://author.example')).toBe('https://author.example/new/');
    expect(buildAuthorNewHref('https://author.example/app')).toBe('https://author.example/app/new/');
    expect(buildAuthorNewHref('http://localhost:8787')).toBe('http://localhost:8787/new/');
  });

  it('rejects origins that are not safe public configuration', () => {
    expect(() => buildAuthorNewHref('http://author.example')).toThrow(/https/);
    expect(() => buildAuthorNewHref('https://user:pass@author.example')).toThrow(/credentials/);
    expect(() => buildAuthorNewHref('https://author.example/?x=1')).toThrow(/query/);
    expect(() => buildAuthorNewHref('not a url')).toThrow(/valid absolute URL/);
  });
});

describe('resolvePublicUrl', () => {
  it('keeps absolute http(s) publication links', () => {
    expect(resolvePublicUrl('https://example.org/paper', '/demo/')).toBe('https://example.org/paper');
    expect(resolvePublicUrl('http://example.org/paper', '/demo/')).toBe('http://example.org/paper');
  });

  it('prefixes explicitly site-relative publication links with BASE_PATH', () => {
    expect(resolvePublicUrl('/papers/two', '/demo/')).toBe('/demo/papers/two');
    expect(resolvePublicUrl('/papers/two', '/')).toBe('/papers/two');
  });

  it('rejects unsafe or ambiguous links', () => {
    expect(() => resolvePublicUrl('javascript:alert(1)', '/')).toThrow(/unsupported link protocol/);
    expect(() => resolvePublicUrl('//evil.example/p', '/')).toThrow(/protocol-relative/);
    expect(() => resolvePublicUrl('papers/two', '/')).toThrow(/site-relative/);
    expect(() => resolvePublicUrl('  ', '/')).toThrow(/must not be empty/);
    expect(() => resolvePublicUrl('https://example.org/a b', '/')).toThrow(/whitespace/);
  });

  it('rejects site-relative paths that can leave BASE_PATH or change meaning', () => {
    expect(() => resolvePublicUrl('/../elsewhere', '/demo/')).toThrow(/\.\./);
    expect(() => resolvePublicUrl('/papers/../../elsewhere', '/demo/')).toThrow(/\.\./);
    expect(() => resolvePublicUrl('/papers/./two', '/demo/')).toThrow(/\./);
    expect(() => resolvePublicUrl('/%2e%2e/elsewhere', '/demo/')).toThrow(/percent-encoded/);
    expect(() => resolvePublicUrl('/x?y=1', '/demo/')).toThrow(/query string or fragment/);
    expect(() => resolvePublicUrl('/x#y', '/demo/')).toThrow(/query string or fragment/);
    expect(resolvePublicUrl('/papers/two', '/demo/')).toBe('/demo/papers/two');
    expect(resolvePublicUrl('/', '/demo/')).toBe('/demo/');
  });
});
