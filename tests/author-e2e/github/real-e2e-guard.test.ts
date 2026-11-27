/**
 * P1-4: the real Tier 2 runner must refuse to publish unless `/api/session`
 * reports the dedicated test repository. These tests exercise the guard with
 * the exact failure modes a misconfigured `.dev.vars` would produce.
 */
import { describe, expect, it } from 'vitest';
import {
  DEDICATED_TEST_REPOSITORY,
  assertDedicatedTestRepository,
} from './real-e2e-guard.mjs';

function session(repo: Record<string, unknown>, status: unknown = 'authorized'): unknown {
  return { status, user: { login: 'ShironeShiyaro', id: 315736688 }, repo };
}

describe('real Tier 2 dedicated-repository guard', () => {
  it('accepts only the committed test repository id and full name', () => {
    const result = assertDedicatedTestRepository(
      session({ id: 1471620960, fullName: 'ShironeShiyaro/selfpage-publish-test' }),
    );
    expect(result).toEqual({
      ok: true,
      repo: { id: 1471620960, fullName: 'ShironeShiyaro/selfpage-publish-test' },
    });
    expect(DEDICATED_TEST_REPOSITORY).toEqual({
      id: 1471620960,
      fullName: 'ShironeShiyaro/selfpage-publish-test',
    });
  });

  it('aborts when the configured repo id is the main repository or anything else', () => {
    for (const id of [999, 0, '1471620960', null, undefined]) {
      const result = assertDedicatedTestRepository(
        session({ id, fullName: 'ShironeShiyaro/selfpage-publish-test' }),
      );
      expect(result.ok, String(id)).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('1471620960');
      }
    }
  });

  it('aborts when the repo id matches but the full name is a different repository', () => {
    for (const fullName of [
      'ShironeShiyaro/selfpage',
      'someone/selfpage-publish-test',
      'ShironeShiyaro/selfpage-publish-test ',
      undefined,
    ]) {
      const result = assertDedicatedTestRepository(session({ id: 1471620960, fullName }));
      expect(result.ok, String(fullName)).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('ShironeShiyaro/selfpage-publish-test');
      }
    }
  });

  it('aborts without a session, a non-object body or an unauthorized status', () => {
    for (const body of [null, undefined, 'authorized', 42, {}]) {
      const result = assertDedicatedTestRepository(body);
      expect(result.ok, String(body)).toBe(false);
    }
    for (const status of ['anonymous', 'expired', 'forbidden']) {
      const result = assertDedicatedTestRepository(
        session({ id: 1471620960, fullName: 'ShironeShiyaro/selfpage-publish-test' }, status),
      );
      expect(result.ok, status).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/not authorized/u);
      }
    }
    const missingRepo = assertDedicatedTestRepository({ status: 'authorized', repo: null });
    expect(missingRepo.ok).toBe(false);
  });
});
