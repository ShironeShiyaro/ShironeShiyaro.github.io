import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ContentValidationError } from './errors.ts';
import { loadSiteContent } from './load.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRoot = join(repoRoot, 'tests', 'fixtures');

function invalidRoot(name: string): string {
  return join(fixtureRoot, 'invalid', name, 'content');
}

function loadInvalid(name: string): ContentValidationError {
  try {
    loadSiteContent({ contentRoot: invalidRoot(name) });
  } catch (error) {
    if (error instanceof ContentValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected ${name} to fail validation.`);
}

describe('invalid blog fixtures', () => {
  const error = loadInvalid('bad-blog');

  it('reports every invalid blog file with its content path', () => {
    const files = error.issues.map((issue) => issue.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'content/blog/2025/missing-h1-2025-01-01-00-00-00.md',
        'content/blog/2025/multiple-h1-2025-01-02-00-00-00.md',
        'content/blog/2025/invalid-date-2025-02-30-00-00-00.md',
        'content/blog/2025/date-mismatch-2025-01-03-00-00-00.md',
        'content/blog/2025/title-mismatch-2025-01-05-00-00-00.md',
      ]),
    );
    expect(error.issues).toHaveLength(5);
  });

  it('explains each failure instead of silently accepting the content', () => {
    const message = error.message;
    expect(message).toContain('missing H1 heading');
    expect(message).toContain('expected exactly one H1 heading');
    expect(message).toContain('not a real calendar date');
    expect(message).toContain('does not match visible date');
    expect(message).toContain('does not match H1');
    expect(message).not.toContain('/to-be-public');
  });
});

describe('NFC/NFD route conflict fixture', () => {
  it('rejects files whose paths normalise to the same route', () => {
    const error = loadInvalid('nfd-route-conflict');
    const conflict = error.issues.find((issue) => issue.message.includes('conflicts with'));
    expect(conflict).toBeDefined();
    expect(conflict?.file).toMatch(/Route-2025-06-01-12-00-00\.md$/);
    expect(conflict?.message).toContain('after Unicode NFC normalisation');
    const combined = `${conflict?.file}: ${conflict?.message}`;
    expect(combined.match(/content\/blog/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('reserved route character fixture', () => {
  const error = loadInvalid('reserved-route-characters');

  it('rejects every blog file whose path contains a reserved character, with its path', () => {
    expect(error.issues).toHaveLength(8);
    const files = error.issues.map((issue) => issue.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'content/blog/2025/C# Notes-2025-06-01-00-00-00.md',
        'content/blog/2025/Price $5-2025-06-02-00-00-00.md',
        'content/blog/2025/Q&A-2025-06-03-00-00-00.md',
        'content/blog/2025/C++ Tips-2025-06-04-00-00-00.md',
        'content/blog/2025/A,B-2025-06-05-00-00-00.md',
        'content/blog/2025/A;B-2025-06-06-00-00-00.md',
        'content/blog/2025/A=B-2025-06-07-00-00-00.md',
        'content/blog/2025/user@example-2025-06-08-00-00-00.md',
      ]),
    );
  });

  it('explains the single-source route reason for each character', () => {
    const messages = error.issues.map((issue) => `${issue.file}: ${issue.message}`);
    for (const [file, character] of [
      ['C# Notes', '#'],
      ['Price $5', '$'],
      ['Q&A', '&'],
      ['C++ Tips', '+'],
      ['A,B', ','],
      ['A;B', ';'],
      ['A=B', '='],
      ['user@example', '@'],
    ] as const) {
      const combined = messages.find((message) => message.includes(file));
      expect(combined).toBeDefined();
      expect(combined).toContain(`reserved character "${character}"`);
      expect(combined).toContain('Astro would build a different URL');
      expect(combined).toContain('content/blog/');
    }
  });
});
