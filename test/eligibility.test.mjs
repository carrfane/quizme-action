import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkEligibility, matchesAnyGlob } from '../scripts/lib/eligibility.mjs';
import { readInputs } from '../scripts/lib/config.mjs';

const baseInputs = () => readInputs({ INPUT_IGNORE_PATHS: 'none' });

const pr = (over = {}) => ({
  number: 7,
  draft: false,
  user: { login: 'carrfane' },
  head: { sha: 'headsha', repo: { full_name: 'carrfane/app' } },
  base: { repo: { full_name: 'carrfane/app' }, ref: 'main', sha: 'basesha' },
  ...over,
});

const files = (over = []) =>
  over.length ? over : [{ filename: 'src/a.js', additions: 20, deletions: 5 }];

test('a normal PR from a listed human is eligible', () => {
  const result = checkEligibility({
    inputs: { ...baseInputs(), users: ['carrfane'] },
    pr: pr(),
    changedFiles: files(),
  });
  assert.deepEqual(result, { eligible: true, reason: '' });
});

test('empty users list applies to every human contributor', () => {
  const result = checkEligibility({ inputs: baseInputs(), pr: pr(), changedFiles: files() });
  assert.equal(result.eligible, true);
});

test('users matching is case insensitive', () => {
  const result = checkEligibility({
    inputs: { ...baseInputs(), users: ['carrfane'] },
    pr: pr({ user: { login: 'CarrFane' } }),
    changedFiles: files(),
  });
  assert.equal(result.eligible, true);
});

test('enabled=false skips', () => {
  const result = checkEligibility({
    inputs: { ...baseInputs(), enabled: false },
    pr: pr(),
    changedFiles: files(),
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /disabled/i);
});

test('bot authors are always skipped even when listed', () => {
  const result = checkEligibility({
    inputs: { ...baseInputs(), users: ['dependabot[bot]'] },
    pr: pr({ user: { login: 'dependabot[bot]' } }),
    changedFiles: files(),
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /bot/i);
});

test('an author outside the users list is skipped', () => {
  const result = checkEligibility({
    inputs: { ...baseInputs(), users: ['someoneelse'] },
    pr: pr(),
    changedFiles: files(),
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /not in the configured users/i);
});

test('draft PRs are skipped', () => {
  const result = checkEligibility({
    inputs: baseInputs(),
    pr: pr({ draft: true }),
    changedFiles: files(),
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /draft/i);
});

test('fork PRs are skipped', () => {
  const result = checkEligibility({
    inputs: baseInputs(),
    pr: pr({ head: { sha: 'x', repo: { full_name: 'stranger/app' } } }),
    changedFiles: files(),
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /fork/i);
});

test('a deleted head repo is treated as a fork', () => {
  const result = checkEligibility({
    inputs: baseInputs(),
    pr: pr({ head: { sha: 'x', repo: null } }),
    changedFiles: files(),
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /fork/i);
});

test('a PR touching only ignored paths is skipped', () => {
  const result = checkEligibility({
    inputs: readInputs({}),
    pr: pr(),
    changedFiles: [
      { filename: 'docs/guide.md', additions: 30, deletions: 0 },
      { filename: 'README.md', additions: 4, deletions: 1 },
    ],
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /ignored paths/i);
});

test('a PR touching one non-ignored path is not skipped', () => {
  const result = checkEligibility({
    inputs: readInputs({}),
    pr: pr(),
    changedFiles: [
      { filename: 'docs/guide.md', additions: 30, deletions: 0 },
      { filename: 'src/a.js', additions: 4, deletions: 1 },
    ],
  });
  assert.equal(result.eligible, true);
});

test('an empty PR is skipped', () => {
  const result = checkEligibility({ inputs: baseInputs(), pr: pr(), changedFiles: [] });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /no changed files/i);
});

test('a PR below min_changed_lines is skipped', () => {
  const result = checkEligibility({
    inputs: { ...baseInputs(), minChangedLines: 50 },
    pr: pr(),
    changedFiles: [{ filename: 'src/a.js', additions: 2, deletions: 1 }],
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /3 changed lines.*below.*50/i);
});

test('rule precedence: disabled wins over draft, fork and bot', () => {
  const result = checkEligibility({
    inputs: { ...baseInputs(), enabled: false },
    pr: pr({ draft: true, user: { login: 'x[bot]' }, head: { sha: 'y', repo: null } }),
    changedFiles: [],
  });
  assert.match(result.reason, /disabled/i);
});

test('rule precedence: bot wins over draft', () => {
  const result = checkEligibility({
    inputs: baseInputs(),
    pr: pr({ draft: true, user: { login: 'x[bot]' } }),
    changedFiles: files(),
  });
  assert.match(result.reason, /bot/i);
});

test('matchesAnyGlob handles the patterns we ship', () => {
  assert.equal(matchesAnyGlob('docs/a/b.txt', ['docs/**']), true);
  assert.equal(matchesAnyGlob('docs/b.txt', ['docs/**']), true);
  assert.equal(matchesAnyGlob('src/docs/b.txt', ['docs/**']), false);
  assert.equal(matchesAnyGlob('README.md', ['**/*.md']), true);
  assert.equal(matchesAnyGlob('a/b/c.md', ['**/*.md']), true);
  assert.equal(matchesAnyGlob('a/b/c.mdx', ['**/*.md']), false);
  assert.equal(matchesAnyGlob('LICENSE', ['**/LICENSE']), true);
  assert.equal(matchesAnyGlob('sub/LICENSE', ['**/LICENSE']), true);
  assert.equal(matchesAnyGlob('src/a.js', ['*.js']), false, '* must not cross /');
  assert.equal(matchesAnyGlob('a.js', ['*.js']), true);
  assert.equal(matchesAnyGlob('a.js', []), false);
  assert.equal(matchesAnyGlob('a+b.js', ['a+b.js']), true, 'regex chars are escaped');
  assert.equal(matchesAnyGlob('file.ts', ['*.{ts,tsx}']), true);
  assert.equal(matchesAnyGlob('file.tsx', ['*.{ts,tsx}']), true);
  assert.equal(matchesAnyGlob('file.js', ['*.{ts,tsx}']), false);
  assert.equal(matchesAnyGlob('a/b.js', ['a/?.js']), true);
  assert.equal(matchesAnyGlob('a/bb.js', ['a/?.js']), false);
});
