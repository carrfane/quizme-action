/**
 * Exercised against real temporary git repositories. The range-resolution
 * fallbacks exist for force-pushes and rebases, which are exactly the cases a
 * stubbed git would let me get wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { collectDiff, DEFAULT_MAX_CHARS } from '../scripts/lib/diff.mjs';

const exec = promisify(execFile);

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizme-git-'));
  const git = (...args) => exec('git', args, { cwd: dir });

  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');

  await writeFile(path.join(dir, 'app.mjs'), 'export const LIMIT = 1;\n', 'utf8');
  await git('add', '.');
  await git('commit', '-q', '-m', 'Initial commit');
  const baseSha = (await git('rev-parse', 'HEAD')).stdout.trim();

  await writeFile(path.join(dir, 'app.mjs'), 'export const LIMIT = 5;\nexport const RETRIES = 3;\n', 'utf8');
  await git('add', '.');
  await git('commit', '-q', '-m', 'Raise the limit and add retries');
  const headSha = (await git('rev-parse', 'HEAD')).stdout.trim();

  return { dir, baseSha, headSha, git };
}

test('collectDiff returns the patch, stat and commit list for a real range', async () => {
  const { dir, baseSha, headSha } = await makeRepo();
  const diff = await collectDiff({ cwd: dir, baseSha, headSha, baseRef: 'main' });

  assert.equal(diff.range, `${baseSha}...${headSha}`);
  assert.match(diff.patch, /-export const LIMIT = 1;/);
  assert.match(diff.patch, /\+export const LIMIT = 5;/);
  assert.match(diff.patch, /\+export const RETRIES = 3;/);
  assert.match(diff.stat, /app\.mjs/);
  assert.match(diff.commits, /Raise the limit and add retries/);
  assert.ok(!diff.commits.includes('Initial commit'), 'commits are limited to the range');
  assert.equal(diff.truncated, false);
});

test('collectDiff falls back to the base branch when the base commit is gone', async () => {
  const { dir, headSha } = await makeRepo();
  const missing = '0'.repeat(40);

  const diff = await collectDiff({ cwd: dir, baseSha: missing, headSha, baseRef: 'main' });

  assert.ok(!diff.range.includes(missing), 'the unreachable sha is not used');
  assert.match(diff.range, /main\.\.\./);
});

test('collectDiff falls back again when there is no base branch either', async () => {
  const { dir, headSha } = await makeRepo();
  const diff = await collectDiff({
    cwd: dir,
    baseSha: '0'.repeat(40),
    headSha,
    baseRef: 'nonexistent-branch',
  });

  assert.equal(diff.range, `${headSha}~1...${headSha}`);
  assert.match(diff.patch, /LIMIT/);
});

test('collectDiff uses HEAD when the head sha is not present locally', async () => {
  const { dir, baseSha } = await makeRepo();
  const diff = await collectDiff({ cwd: dir, baseSha, headSha: '0'.repeat(40), baseRef: 'main' });
  assert.equal(diff.range, `${baseSha}...HEAD`);
  assert.match(diff.patch, /RETRIES/);
});

test('collectDiff truncates an oversized patch and says so', async () => {
  const { dir, baseSha, git } = await makeRepo();
  await writeFile(path.join(dir, 'big.txt'), Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n'), 'utf8');
  await git('add', '.');
  await git('commit', '-q', '-m', 'Add a big file');
  const headSha = (await git('rev-parse', 'HEAD')).stdout.trim();

  const diff = await collectDiff({ cwd: dir, baseSha, headSha, baseRef: 'main', maxChars: 2000 });

  assert.equal(diff.truncated, true);
  assert.match(diff.patch, /diff truncated at 2000 characters/);
  assert.ok(diff.patch.length < 2200, 'the budget is respected');
});

test('collectDiff leaves a patch within budget untouched', async () => {
  const { dir, baseSha, headSha } = await makeRepo();
  const diff = await collectDiff({ cwd: dir, baseSha, headSha, baseRef: 'main', maxChars: 100000 });
  assert.equal(diff.truncated, false);
  assert.ok(!diff.patch.includes('truncated'));
});

test('an identical range yields an empty patch rather than throwing', async () => {
  const { dir, headSha } = await makeRepo();
  const diff = await collectDiff({ cwd: dir, baseSha: headSha, headSha, baseRef: 'main' });
  assert.equal(diff.patch, '');
});

test('the default budget is documented and sane', () => {
  assert.equal(DEFAULT_MAX_CHARS, 60000);
});

test('collectDiff surfaces a git failure rather than hanging', async () => {
  const notARepo = await mkdtemp(path.join(tmpdir(), 'quizme-norepo-'));
  const diff = await collectDiff({
    cwd: notARepo,
    baseSha: 'x',
    headSha: 'y',
    baseRef: 'main',
  });
  // Every git call fails, so we degrade to empty strings; the caller turns that
  // into a fail-open "could not read a diff".
  assert.equal(diff.patch, '');
  assert.equal(diff.stat, '');
});
