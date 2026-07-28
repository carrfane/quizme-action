/**
 * Fork pull requests are the one case where we cannot write a commit status:
 * the `pull_request` token is read-only for them. A 403 there must not paint a
 * red X on a contributor's PR, but every other 403 is a real misconfiguration
 * and must still fail loudly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMode } from '../scripts/lib/modes.mjs';
import { routeEvent } from '../scripts/lib/router.mjs';
import { readInputs } from '../scripts/lib/config.mjs';

const inputs = () => readInputs({ INPUT_IGNORE_PATHS: 'none' });

const forkPr = {
  number: 3,
  draft: false,
  user: { login: 'outsider', type: 'User' },
  head: { sha: 'forksha1', repo: { full_name: 'outsider/app' } },
  base: { sha: 'basesha1', ref: 'main', repo: { full_name: 'carrfane/app' } },
  html_url: 'https://github.test/pr/3',
};

const forbidden = () => {
  const error = new Error('POST https://api.github.com/repos/x/y/statuses/z failed with 403 Forbidden: nope');
  return error;
};

test('a fork PR routes to skip and is flagged as a fork', async () => {
  const decision = await routeEvent({
    payload: { action: 'opened', pull_request: forkPr },
    eventName: 'pull_request',
    inputs: inputs(),
    lookups: {
      listChangedFiles: async () => [{ filename: 'src/a.js', additions: 9, deletions: 1 }],
      listComments: async () => [],
      getPullRequest: async () => forkPr,
    },
  });

  assert.equal(decision.mode, 'skip');
  assert.equal(decision.forkSkip, true);
  assert.match(decision.reason, /fork/);
});

test('a 403 on a fork skip is tolerated instead of failing the job', async () => {
  const logs = [];
  const client = {
    listComments: async () => [],
    setStatus: async () => {
      throw forbidden();
    },
  };

  const result = await runMode({
    decision: { mode: 'skip', reason: 'pull request comes from a fork', forkSkip: true, headSha: 'forksha1' },
    inputs: inputs(),
    client,
    deps: {},
    log: (line) => logs.push(line),
  });

  assert.equal(result.action, 'skip-fork-unreported');
  assert.ok(logs.join('\n').includes('/quizme skip'), 'the log must name the escape hatch');
});

test('a 403 on a non-fork skip still fails loudly', async () => {
  const client = {
    listComments: async () => [],
    setStatus: async () => {
      throw forbidden();
    },
  };

  await assert.rejects(
    () =>
      runMode({
        decision: { mode: 'skip', reason: 'pull request is a draft', forkSkip: false, headSha: 'sha' },
        inputs: inputs(),
        client,
        deps: {},
        log: () => {},
      }),
    /403/,
    'a missing statuses:write permission must not be silently swallowed',
  );
});

test('a non-403 failure on a fork skip still fails loudly', async () => {
  const client = {
    listComments: async () => [],
    setStatus: async () => {
      throw new Error('POST /statuses/x failed with 500 Server Error: boom');
    },
  };

  await assert.rejects(
    () =>
      runMode({
        decision: { mode: 'skip', reason: 'fork', forkSkip: true, headSha: 'sha' },
        inputs: inputs(),
        client,
        deps: {},
        log: () => {},
      }),
    /500/,
  );
});

test('a maintainer can still bypass a fork PR from a comment, where the token can write', async () => {
  // issue_comment runs in the base repository context with a writable token, so
  // this is the documented escape hatch for a required check on a fork PR.
  const decision = await routeEvent({
    payload: {
      action: 'created',
      issue: { number: 3, pull_request: { url: 'x' } },
      comment: { id: 1, body: '/quizme skip', user: { login: 'carrfane', type: 'User' } },
      sender: { login: 'carrfane', type: 'User' },
    },
    eventName: 'issue_comment',
    inputs: inputs(),
    lookups: {
      listChangedFiles: async () => [],
      listComments: async () => [],
      getPullRequest: async () => forkPr,
    },
  });

  assert.equal(decision.mode, 'bypass');
  assert.equal(decision.headSha, 'forksha1');
});
