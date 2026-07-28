/**
 * Regression tests for a bug observed on real GitHub.
 *
 * GitHub delivers `issue_comment` events at least once. A submission produced
 * several `edited` deliveries: the first run graded 2/3 correctly, and a later
 * run re-graded from a different body and overwrote the comment with a wrong
 * 1/3. Grading must be idempotent and must trust the live comment, not the
 * webhook payload.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMode } from '../scripts/lib/modes.mjs';
import { readInputs } from '../scripts/lib/config.mjs';
import {
  renderQuiz,
  renderResults,
  hasMarker,
  MARKERS,
  SUBMIT_UNCHECKED,
  SUBMIT_CHECKED,
  withNudge,
} from '../scripts/lib/comment.mjs';

const inputs = () => readInputs({ INPUT_IGNORE_PATHS: 'none' });

const quiz = {
  questions: [
    { question: 'Q1?', options: { A: 'a1', B: 'b1', C: 'c1', D: 'd1' }, answer: 'B', explanation: 'e1' },
    { question: 'Q2?', options: { A: 'a2', B: 'b2', C: 'c2', D: 'd2' }, answer: 'B', explanation: 'e2' },
  ],
};

const decision = (over = {}) => ({
  mode: 'grade',
  commentId: 501,
  prNumber: 1,
  headSha: 'headsha1',
  actor: 'carrfane',
  prUrl: 'https://github.test/pr/1',
  ...over,
});

function client({ liveBody, failGet = false } = {}) {
  const calls = { statuses: [], updated: [], gets: 0 };
  return {
    calls,
    listComments: async () => [],
    getComment: async () => {
      calls.gets += 1;
      if (failGet) throw new Error('GET /issues/comments/501 failed with 500 Server Error: boom');
      return { id: 501, body: liveBody };
    },
    updateComment: async (id, body) => {
      calls.updated.push({ id, body });
      return { id, body };
    },
    setStatus: async (status) => {
      calls.statuses.push(status);
      return status;
    },
  };
}

const answered = (...letters) => {
  let body = renderQuiz({ sha: 'headsha1', quiz });
  letters.forEach((letter, i) => {
    if (letter) body = body.replace(`- [ ] ${letter}. ${letter.toLowerCase()}${i + 1}`, `- [x] ${letter}. ${letter.toLowerCase()}${i + 1}`);
  });
  return body.replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);
};

const graded = () =>
  renderResults({
    sha: 'headsha1',
    quiz,
    selections: { 1: 'B', 2: 'A' },
    result: {
      correct: 1,
      total: 2,
      outcomes: [
        { index: 1, selected: 'B', expected: 'B', correct: true },
        { index: 2, selected: 'A', expected: 'B', correct: false },
      ],
    },
    actor: 'carrfane',
  });

test('grading reads the live comment, not the webhook payload', async () => {
  // The payload is stale: it claims nothing was ticked. The live comment has
  // both answers. The live comment must win.
  const c = client({ liveBody: answered('B', 'B') });
  const result = await runMode({
    decision: decision({ commentBody: renderQuiz({ sha: 'headsha1', quiz }) }),
    inputs: inputs(),
    client: c,
    deps: {},
    log: () => {},
  });

  assert.equal(c.calls.gets, 1, 'the live comment must be fetched');
  assert.equal(result.action, 'grade');
  assert.equal(result.correct, 2);
});

test('a duplicate event on an already-graded comment is a no-op', async () => {
  const c = client({ liveBody: graded() });
  const result = await runMode({
    decision: decision({ commentBody: answered('B', 'B') }),
    inputs: inputs(),
    client: c,
    deps: {},
    log: () => {},
  });

  assert.equal(result.action, 'grade-already-done');
  assert.equal(c.calls.updated.length, 0, 'a good result must never be overwritten');
  assert.equal(c.calls.statuses.length, 0, 'and the status must not be rewritten');
});

test('the exact observed regression: a good 2/3 survives a duplicate delivery', async () => {
  // Delivery 1: grade it.
  const first = client({ liveBody: answered('B', 'B') });
  const a = await runMode({
    decision: decision({ commentBody: answered('B', 'B') }),
    inputs: inputs(),
    client: first,
    deps: {},
    log: () => {},
  });
  assert.equal(a.correct, 2);
  const gradedBody = first.calls.updated[0].body;
  assert.ok(hasMarker(gradedBody, MARKERS.graded));

  // Delivery 2 arrives with a different, garbled payload body. Previously this
  // re-graded and clobbered the result.
  const second = client({ liveBody: gradedBody });
  const b = await runMode({
    decision: decision({ commentBody: answered('C', 'A') }),
    inputs: inputs(),
    client: second,
    deps: {},
    log: () => {},
  });

  assert.equal(b.action, 'grade-already-done');
  assert.equal(second.calls.updated.length, 0);
  assert.match(gradedBody, /score=2\/2|2 \/ 2/, 'the original score is untouched');
});

test('an event whose live comment is no longer submitted does nothing', async () => {
  // This is what a nudge leaves behind. Grading it again would be wrong.
  const nudged = withNudge(answered('B'), 'tick question 2');
  const c = client({ liveBody: nudged });

  const result = await runMode({
    decision: decision({ commentBody: answered('B', 'B') }),
    inputs: inputs(),
    client: c,
    deps: {},
    log: () => {},
  });

  assert.equal(result.action, 'grade-not-submitted');
  assert.equal(c.calls.updated.length, 0);
  assert.equal(c.calls.statuses.length, 0);
});

test('a failed re-read falls back to the payload rather than doing nothing', async () => {
  const c = client({ failGet: true });
  const logs = [];
  const result = await runMode({
    decision: decision({ commentBody: answered('B', 'B') }),
    inputs: inputs(),
    client: c,
    deps: {},
    log: (line) => logs.push(line),
  });

  assert.equal(result.action, 'grade', 'a transient API blip must not silently skip grading');
  assert.equal(result.correct, 2);
  assert.match(logs.join('\n'), /could not re-read comment/);
});

test('an empty live body falls back to the payload', async () => {
  const c = client({ liveBody: '' });
  const result = await runMode({
    decision: decision({ commentBody: answered('B', 'B') }),
    inputs: inputs(),
    client: c,
    deps: {},
    log: () => {},
  });
  assert.equal(result.action, 'grade');
  assert.equal(result.correct, 2);
});
