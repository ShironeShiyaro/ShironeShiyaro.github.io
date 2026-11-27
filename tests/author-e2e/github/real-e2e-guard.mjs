/**
 * Safety guard for the real Tier 2 script (A20 / P1-4).
 *
 * The Worker decides which repository it writes to from `.dev.vars`/secrets.
 * The script itself must never assume that configuration is the dedicated test
 * repository: before any Publish click it reads `/api/session` and verifies the
 * numeric repository id and full name. A mismatch aborts the run without
 * writing anything.
 */

export const DEDICATED_TEST_REPOSITORY = Object.freeze({
  id: 1471620960,
  fullName: 'ShironeShiyaro/selfpage-publish-test',
});

/**
 * @param {unknown} session parsed `/api/session` JSON body
 * @returns {{ ok: true, repo: { id: number, fullName: string } } | { ok: false, reason: string }}
 */
export function assertDedicatedTestRepository(session) {
  if (typeof session !== 'object' || session === null) {
    return {
      ok: false,
      reason: 'The author server did not return a session object.',
    };
  }
  const record = /** @type {{ status?: unknown, repo?: unknown }} */ (session);
  if (record.status !== 'authorized') {
    return {
      ok: false,
      reason: `The author session is not authorized (status: ${String(record.status)}).`,
    };
  }
  if (typeof record.repo !== 'object' || record.repo === null) {
    return {
      ok: false,
      reason: 'The authorized session did not report a repository.',
    };
  }
  const repo = /** @type {{ id?: unknown, fullName?: unknown }} */ (record.repo);
  if (repo.id !== DEDICATED_TEST_REPOSITORY.id) {
    return {
      ok: false,
      reason:
        `The session repository id is ${String(repo.id)}, not the dedicated test repository id ` +
        `${DEDICATED_TEST_REPOSITORY.id}.`,
    };
  }
  if (repo.fullName !== DEDICATED_TEST_REPOSITORY.fullName) {
    return {
      ok: false,
      reason:
        `The session repository is ${String(repo.fullName)}, not ` +
        `${DEDICATED_TEST_REPOSITORY.fullName}.`,
    };
  }
  return {
    ok: true,
    repo: { id: DEDICATED_TEST_REPOSITORY.id, fullName: DEDICATED_TEST_REPOSITORY.fullName },
  };
}
