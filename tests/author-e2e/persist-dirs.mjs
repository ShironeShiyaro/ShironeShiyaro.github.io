/**
 * One shared implementation of the P2-4 rule for every author-app E2E runner.
 *
 * Each runner starts one or two `wrangler dev` processes with a fixed
 * `--persist-to` directory. That directory holds the Durable Object store — mock
 * session, publish/dedupe rows, the injected fixed clock — so a second run used
 * to start from whatever the previous run left behind. On identical code that
 * produced 79/1 once and 80/0 afterwards (E11 began from an already-expired
 * session), which makes "this suite is stable" impossible to test by re-running.
 *
 * The directories are therefore removed before the Workers start. Call this only
 * after the runner has claimed its ports: clearing a store that a *running* suite
 * is using would pull the ground out from under it.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} authorDir absolute path to apps/author
 * @param {string[]} directories `--persist-to` values to clear (relative to authorDir)
 * @returns {string[]} the directories that were cleared
 */
export function cleanPersistDirs(authorDir, directories) {
  const cleared = [];
  for (const directory of directories) {
    const absolute = join(authorDir, directory);
    rmSync(absolute, { recursive: true, force: true });
    if (existsSync(absolute)) {
      throw new Error(`Could not remove the previous Durable Object store at ${absolute}.`);
    }
    cleared.push(directory);
  }
  return cleared;
}
