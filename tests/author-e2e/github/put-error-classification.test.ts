/**
 * Behaviour tests for Contents API 422 classification (task 07 P1).
 *
 * A 422 is not a conflict by itself: GitHub reuses it for protected branches,
 * repository rules while nothing exists at the path, and "sha wasn't supplied"
 * when the file does exist. Only an explicit branch-protection message may
 * produce the dedicated terminal; everything else must be verified by the
 * caller with a contents GET before a conflict can be reported.
 */
import { describe, expect, it } from 'vitest';
import { classifyUnprocessablePut } from '../../../apps/author/worker/github.ts';

describe('classifyUnprocessablePut', () => {
  it('classifies explicit protected-branch messages as branch protection', () => {
    const bodies: unknown[] = [
      { message: 'protected branch hook declined' },
      { message: 'Protected branch update failed for refs/heads/main.' },
      { message: 'Cannot update protected ref' },
      { message: 'PROTECTED BRANCH HOOK DECLINED' },
      {
        message: 'Validation Failed',
        errors: [{ message: 'Branch protection is enabled on this branch' }],
      },
    ];
    for (const body of bodies) {
      expect(classifyUnprocessablePut(body), JSON.stringify(body)).toBe('branch_protected');
    }
  });

  it('does not claim branch protection for other 422 bodies', () => {
    const bodies: unknown[] = [
      { message: 'sha wasn\u2019t supplied' },
      { message: 'sha wasn\u2019t supplied', documentation_url: 'https://docs.github.com/rest' },
      { message: 'Repository rule violations found' },
      { message: 'invalid contents body' },
      { message: 'rate limited' },
      {},
      null,
      'plain text',
      [{ message: 'protected branch hook declined' }],
    ];
    for (const body of bodies) {
      expect(classifyUnprocessablePut(body), JSON.stringify(body)).toBe('write_rejected');
    }
  });
});
