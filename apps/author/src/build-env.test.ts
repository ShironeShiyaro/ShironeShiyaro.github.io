import { describe, expect, it } from 'vitest';
import { resolveBuildEnv } from '../build-env.ts';

describe('author build env (P2-4)', () => {
  it('reads PUBLIC_SITE_ORIGIN from .env.local (the bug this fixes)', () => {
    const env = resolveBuildEnv({ PUBLIC_SITE_ORIGIN: 'https://example.com' }, {});
    expect(env.siteOrigin).toBe('https://example.com');
  });

  it('lets the real process environment win over an env file', () => {
    const env = resolveBuildEnv(
      { PUBLIC_SITE_ORIGIN: 'https://file.example', BASE_PATH: '/file/' },
      { PUBLIC_SITE_ORIGIN: 'https://process.example' },
    );
    expect(env.siteOrigin).toBe('https://process.example');
    expect(env.basePath).toBe('/file/');
  });

  it('trims values and treats blanks as unset', () => {
    const env = resolveBuildEnv(
      { PUBLIC_SITE_ORIGIN: '  https://example.com  ', SELF_PAGE_CONTENT_ROOT: '   ' },
      { PUBLIC_AUTHOR_ORIGIN: '' },
    );
    expect(env.siteOrigin).toBe('https://example.com');
    expect(env.contentRoot).toBeUndefined();
    expect(env.authorOrigin).toBeUndefined();
    expect(env.basePath).toBeUndefined();
  });

  it('leaves the origin unset when neither source configures it (local default)', () => {
    const env = resolveBuildEnv({}, {});
    expect(env.siteOrigin).toBeUndefined();
  });

  it('tolerates a UTF-8 BOM on the first key of .env.local', () => {
    const env = resolveBuildEnv({ '\uFEFFPUBLIC_SITE_ORIGIN': 'https://example.com' }, {});
    expect(env.siteOrigin).toBe('https://example.com');
  });
});
