import { test } from 'node:test';
import assert from 'node:assert/strict';

import { routeEvent } from '../scripts/lib/router.mjs';
import { readInputs } from '../scripts/lib/config.mjs';
import { renderQuiz, renderResults, SUBMIT_UNCHECKED, SUBMIT_CHECKED } from '../scripts/lib/comment.mjs';

const inputs = (over = {}) => ({ ...readInputs({ INPUT_IGNORE_PATHS: 'none' }), ...over });

const PR = {
  number: 12,
  draft: false,
  user: { login: 'carrfane', type: 'User' },
  head: { sha: 'aaaa1111', repo: { full_name: 'carrfane/app' } },
  base: { repo: { full_name: 'carrfane/app' }, ref: 'main', sha: 'bbbb2222' },
};

const CHANGED = [{ filename: 'src/a.js', additions: 30, deletions: 4 }];

const lookups = (over = {}) => ({
  listChangedFiles: async () => CHANGED,
  listComments: async () => [],
  getPullRequest: async () => PR,
  ...over,
});

const quiz = {
  questions: [
    {
      question: 'Q1?',
      options: { A: 'a', B: 'b', C: 'c', D: 'd' },
      answer: 'B',
      explanation: 'because',
    },
  ],
};

const prEvent = (action, over = {}) => ({
  action,
  pull_request: { ...PR, ...over },
});

const commentEvent = ({ body, login = 'carrfane', type = 'User', isPr = true, id = 99 }) => ({
  action: 'created',
  issue: { number: 12, pull_request: isPr ? { url: 'x' } : undefined },
  comment: { id, body, user: { login, type } },
  sender: { login, type },
});

const route = (payload, eventName, opts = {}) =>
  routeEvent({
    payload,
    eventName,
    inputs: opts.inputs ?? inputs(),
    lookups: lookups(opts.lookups),
  });

test('pull_request opened generates', async () => {
  const result = await route(prEvent('opened'), 'pull_request');
  assert.equal(result.mode, 'generate');
  assert.equal(result.prNumber, 12);
  assert.equal(result.headSha, 'aaaa1111');
});

test('reopened and ready_for_review also generate', async () => {
  for (const action of ['reopened', 'ready_for_review']) {
    assert.equal((await route(prEvent(action), 'pull_request')).mode, 'generate');
  }
});

test('an unhandled pull_request action is ignored entirely', async () => {
  for (const action of ['closed', 'labeled', 'edited', 'assigned']) {
    const result = await route(prEvent(action), 'pull_request');
    assert.equal(result.mode, 'none', action);
  }
});

test('synchronize carries a previous pass forward', async () => {
  const graded = renderResults({
    sha: 'old99sha',
    quiz,
    selections: { 1: 'B' },
    result: { correct: 1, total: 1, outcomes: [{ index: 1, selected: 'B', expected: 'B', correct: true }] },
    actor: 'carrfane',
  });
  const result = await route(prEvent('synchronize'), 'pull_request', {
    lookups: { listComments: async () => [{ id: 5, body: graded }] },
  });
  assert.equal(result.mode, 'carry');
  assert.equal(result.priorSha, 'old99sha');
  assert.equal(result.headSha, 'aaaa1111', 'status goes on the new head');
});

test('synchronize with no graded comment generates a fresh quiz', async () => {
  const pending = renderQuiz({ sha: 'aaaa1111', quiz });
  const result = await route(prEvent('synchronize'), 'pull_request', {
    lookups: { listComments: async () => [{ id: 5, body: pending }] },
  });
  assert.equal(result.mode, 'generate');
});

test('a draft PR skips without spending an API call', async () => {
  let called = false;
  const result = await route(prEvent('opened', { draft: true }), 'pull_request', {
    lookups: {
      listChangedFiles: async () => {
        called = true;
        return CHANGED;
      },
    },
  });
  assert.equal(result.mode, 'skip');
  assert.match(result.reason, /draft/);
  assert.equal(called, false, 'preflight short-circuits before listing files');
});

test('a fork PR skips', async () => {
  const result = await route(
    prEvent('opened', { head: { sha: 'x', repo: { full_name: 'stranger/app' } } }),
    'pull_request',
  );
  assert.equal(result.mode, 'skip');
  assert.match(result.reason, /fork/);
});

test('a bot-authored PR skips', async () => {
  const result = await route(
    prEvent('opened', { user: { login: 'dependabot[bot]', type: 'Bot' } }),
    'pull_request',
  );
  assert.equal(result.mode, 'skip');
  assert.match(result.reason, /bot/);
});

test('a docs-only PR skips, and that needs the file list', async () => {
  const result = await route(prEvent('opened'), 'pull_request', {
    inputs: inputs({ ignorePaths: ['**/*.md'] }),
    lookups: { listChangedFiles: async () => [{ filename: 'README.md', additions: 3, deletions: 1 }] },
  });
  assert.equal(result.mode, 'skip');
  assert.match(result.reason, /ignored paths/);
});

test('submitting a quiz grades it', async () => {
  const body = renderQuiz({ sha: 'aaaa1111', quiz })
    .replace('- [ ] B. b', '- [x] B. b')
    .replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);
  const result = await route(commentEvent({ body }), 'issue_comment');
  assert.equal(result.mode, 'grade');
  assert.equal(result.commentId, 99);
  assert.equal(result.commentBody, body);
  assert.equal(result.headSha, 'aaaa1111');
});

test('an unsubmitted quiz comment edit does nothing', async () => {
  const body = renderQuiz({ sha: 'aaaa1111', quiz }).replace('- [ ] B. b', '- [x] B. b');
  const result = await route(commentEvent({ body }), 'issue_comment');
  assert.equal(result.mode, 'none');
});

test('loop protection: a bot sender is ignored', async () => {
  const body = renderQuiz({ sha: 'aaaa1111', quiz }).replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);
  const result = await route(
    commentEvent({ body, login: 'github-actions[bot]', type: 'Bot' }),
    'issue_comment',
  );
  assert.equal(result.mode, 'none');
  assert.match(result.reason, /bot/);
});

test('loop protection: an already-graded body is ignored', async () => {
  const graded = renderResults({
    sha: 'aaaa1111',
    quiz,
    selections: { 1: 'B' },
    result: { correct: 1, total: 1, outcomes: [{ index: 1, selected: 'B', expected: 'B', correct: true }] },
    actor: 'carrfane',
  });
  const result = await route(commentEvent({ body: `${graded}\n${SUBMIT_CHECKED}` }), 'issue_comment');
  assert.equal(result.mode, 'none');
  assert.match(result.reason, /already graded/);
});

test('/quizme skip bypasses', async () => {
  const result = await route(commentEvent({ body: '/quizme skip' }), 'issue_comment');
  assert.equal(result.mode, 'bypass');
  assert.match(result.reason, /@carrfane/);
});

test('/quizme skip is allowed from anyone with write access', async () => {
  const result = await route(commentEvent({ body: '/quizme skip', login: 'teammate' }), 'issue_comment');
  assert.equal(result.mode, 'bypass');
});

test('/quizme forces a fresh quiz', async () => {
  const result = await route(commentEvent({ body: '/quizme' }), 'issue_comment');
  assert.equal(result.mode, 'generate');
});

test('/quizme from an untargeted user is ignored', async () => {
  const result = await route(commentEvent({ body: '/quizme', login: 'stranger' }), 'issue_comment');
  assert.equal(result.mode, 'none');
  assert.match(result.reason, /neither the PR author nor/);
});

test('a listed user may answer on behalf of the configured target', async () => {
  const body = renderQuiz({ sha: 'aaaa1111', quiz })
    .replace('- [ ] B. b', '- [x] B. b')
    .replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);
  const result = await route(commentEvent({ body, login: 'Teammate' }), 'issue_comment', {
    inputs: inputs({ users: ['teammate'] }),
  });
  assert.equal(result.mode, 'grade');
});

test('an unrelated comment does nothing', async () => {
  for (const body of ['lgtm', 'quizme', '/quiz me', '/quizmeplease', '/quizme skipx']) {
    const result = await route(commentEvent({ body }), 'issue_comment');
    assert.equal(result.mode, 'none', body);
  }
});

test('a comment on a plain issue does nothing', async () => {
  const result = await route(commentEvent({ body: '/quizme', isPr: false }), 'issue_comment');
  assert.equal(result.mode, 'none');
  assert.match(result.reason, /not a pull request/);
});

test('an unsupported event does nothing', async () => {
  const result = await route({}, 'push');
  assert.equal(result.mode, 'none');
});
