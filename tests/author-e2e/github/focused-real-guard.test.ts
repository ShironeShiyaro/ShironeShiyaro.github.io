/**
 * Independent focused retest for P1-4: the real Tier 2 script must refuse to
 * publish unless `/api/session` names the dedicated test repository.
 *
 * This file uses its own assertions; it does not run the real Tier 2 script and
 * never touches a real repository.
 */
import { describe, expect, it } from 'vitest';
import {
  DEDICATED_TEST_REPOSITORY,
  assertDedicatedTestRepository,
} from './real-e2e-guard.mjs';

function session(repo: unknown, status: unknown = 'authorized'): unknown {
  return { status, user: { login: 'ShironeShiyaro', id: 315736688 }, repo };
}

describe('independent real Tier 2 repository guard', () => {
  it('accepts only the exact dedicated repository id and full name', () => {
    expect(DEDICATED_TEST_REPOSITORY).toEqual({
      id: 1471620960,
      fullName: 'ShironeShiyaro/selfpage-publish-test',
    });
    expect(
      assertDedicatedTestRepository(
        session({ id: 1471620960, fullName: 'ShironeShiyaro/selfpage-publish-test' }),
      ),
    ).toEqual({
      ok: true,
      repo: { id: 1471620960, fullName: 'ShironeShiyaro/selfpage-publish-test' },
    });
  });

  it('aborts on a wrong numeric id, including the main repository', () => {
    for (const id of [1471620961, 1, 0, '1471620960', null, undefined]) {
      const result = assertDedicatedTestRepository(
        session({ id, fullName: 'ShironeShiyaro/selfpage-publish-test' }),
      );
      expect(result.ok, String(id)).toBe(false);
      if (!result.ok) expect(result.reason).toContain('1471620960');
    }
  });

  it('aborts on a wrong or non-exact full name even with the right id', () => {
    for (const fullName of [
      'ShironeShiyaro/ShironeShiyaro.github.io',
      'ShironeShiyaro/selfpage',
      'someone/selfpage-publish-test',
      'ShironeShiyaro/selfpage-publish-test ',
      'ShironeShiyaro/SelfPage-Publish-Test',
      undefined,
    ]) {
      const result = assertDedicatedTestRepository(session({ id: 1471620960, fullName }));
      expect(result.ok, String(fullName)).toBe(false);
      if (!result.ok) expect(result.reason).toContain('ShironeShiyaro/selfpage-publish-test');
    }
  });

  it('aborts without an authorized session object or repository', () => {
    for (const body of [null, undefined, 'authorized', 42, {}, { status: 'authorized' }]) {
      expect(assertDedicatedTestRepository(body).ok, String(body)).toBe(false);
    }
    for (const status of ['anonymous', 'expired', 'forbidden', 'permission_denied']) {
      expect(
        assertDedicatedTestRepository(
          session({ id: 1471620960, fullName: 'ShironeShiyaro/selfpage-publish-test' }, status),
        ).ok,
        status,
      ).toBe(false);
    }
  });

  it('is wired into the real script before the form and the Publish click', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../real-github-e2e.mjs', import.meta.url), 'utf8');
    const guardCall = source.indexOf('assertDedicatedTestRepository(');
    const formFill = source.indexOf("getByTestId('post-title').evaluate");
    const publishClick = source.indexOf("getByTestId('publish-button').click");
    expect(guardCall).toBeGreaterThan(0);
    expect(formFill).toBeGreaterThan(guardCall);
    expect(publishClick).toBeGreaterThan(guardCall);
    expect(source).toContain('Nothing was published and no repository write was attempted.');
    expect(source).toContain("if (process.env.REAL_GITHUB_E2E !== '1')");
  });
});
