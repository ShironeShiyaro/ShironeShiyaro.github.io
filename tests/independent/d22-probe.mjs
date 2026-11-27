#!/usr/bin/env node
/**
 * D22 conformance probe (independent test evidence, task 06).
 *
 * Total-control ruling D22 (2026-11-25): a New! title containing any of
 * `# $ & + , : ; = ? @` must be rejected before publishing with an English
 * error; it must NOT be silently replaced in the file name. Only `< > " | *`
 * are replaced with `-`, while the H1 keeps the original characters.
 *
 * This probe asserts D22 against the shipped serializer. It is a focused
 * regression check: all 15 cases must PASS after the fix round; any FAIL means
 * a route-reserved character regressed to silent replacement or a publishable
 * character stopped being replaced in the file name. It is not part of
 * `npm test`, so a future regression is visible here with its own exit code.
 */
import { serializePost } from '../../packages/markdown/src/index.ts';

const DATE = '2026-11-23';
const RESERVED = ['#', '$', '&', '+', ',', ':', ';', '?', '=', '@'];
const REPLACED = ['<', '>', '"', '|', '*'];

const rows = [];
let failed = false;

function check(title, mustBeRejected) {
  const result = serializePost({ title, body: 'Probe body.', date: DATE });
  if (mustBeRejected && result.ok) {
    return { rejected: false, errors: [], safeTitle: result.post.safeTitle, h1: `# ${title}` };
  }
  if (mustBeRejected) {
    return {
      rejected: true,
      errors: result.errors.map((error) => error.code),
      safeTitle: null,
      h1: null,
    };
  }
  return {
    rejected: false,
    errors: [],
    safeTitle: result.ok ? result.post.safeTitle : null,
    h1: result.ok ? result.post.visibleMarkdown.split('\n')[0] : null,
  };
}

for (const character of RESERVED) {
  const title = `A${character}B`;
  const observed = check(title, true);
  const conformant = observed.rejected;
  if (!conformant) {
    failed = true;
  }
  rows.push({
    character,
    ruling: 'reject',
    observed: conformant ? 'rejected' : 'ACCEPTED (silently published)',
    safeTitle: observed.safeTitle,
    errors: observed.errors.join(','),
    conformant,
  });
}

for (const character of REPLACED) {
  const title = `A${character}B`;
  const observed = check(title, false);
  const safe = observed.safeTitle ?? '';
  const conformant = safe === 'A-B' && observed.h1 === `# A${character}B`;
  if (!conformant) {
    failed = true;
  }
  rows.push({
    character,
    ruling: 'replace in file name, keep in H1',
    observed: `safeTitle=${JSON.stringify(safe)} h1=${JSON.stringify(observed.h1)}`,
    safeTitle: safe,
    errors: '',
    conformant,
  });
}

for (const row of rows) {
  console.log(
    `${row.conformant ? 'PASS' : 'FAIL'} char=${JSON.stringify(row.character)} ` +
      `ruling=${row.ruling} observed=${row.observed}${row.errors ? ` errors=${row.errors}` : ''}`,
  );
}

console.log(
  `\nD22 CONFORMANCE: ${failed ? 'FAIL' : 'PASS'} ` +
    `(${rows.filter((row) => !row.conformant).length}/${rows.length} cases violate the ruling)`,
);
console.log(
  'Interpretation: all ten route-reserved characters must raise title_reserved_character; ' +
    'only < > " | * may be replaced in the file-name form while the H1 keeps them.',
);

process.exit(failed ? 1 : 0);
