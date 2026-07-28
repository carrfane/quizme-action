import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMode } from '../scripts/lib/modes.mjs';
import { readInputs } from '../scripts/lib/config.mjs';
import { publicError } from '../scripts/lib/errors.mjs';
import {
  renderQuiz,
  renderResults,
  parseQuizKey,
  isSubmitted,
  hasMarker,
  MARKERS,
  SUBMIT_UNCHECKED,
  SUBMIT_CHECKED,
} from '../scripts/lib/comment.mjs';

const inputs = (over = {}) => ({ ...readInputs({ INPUT_IGNORE_PATHS: 'none' }), ...over });

const quiz = {
  questions: [
    { question: 'Q1?', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'B', explanation: 'e1' },
    { question: 'Q2?', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'C', explanation: 'e2' },
    { question: 'Q3?', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'A', explanation: 'e3' },
  ],
};

const decision = (over = {}) => ({
  mode: 'generate',
  reason: 'opened on #12',
  prNumber: 12,
  headSha: 'aaaa1111bbbb',
  baseSha: 'cccc2222',
  baseRef: 'main',
  prUrl: 'https://github.test/carrfane/app/pull/12',
  actor: 'carrfane',
  ...over,
});

function fakeClient(comments = []) {
  const calls = { statuses: [], created: [], updated: [] };
  let nextId = 500;
  return {
    calls,
    listComments: async () => comments,
    createComment: async (prNumber, body) => {
      const comment = { id: (nextId += 1), body, html_url: `https://github.test/c/${nextId}` };
      calls.created.push({ prNumber, body });
      comments.push(comment);
      return comment;
    },
    updateComment: async (id, body) => {
      calls.updated.push({ id, body });
      const existing = comments.find((c) => c.id === id);
      if (existing) existing.body = body;
      return { id, body, html_url: `https://github.test/c/${id}` };
    },
    setStatus: async (status) => {
      calls.statuses.push(status);
      return status;
    },
  };
}

const okDeps = (over = {}) => ({
  readPrompt: async () => 'count={{QUESTION_COUNT}} range={{RANGE}} ref={{BASE_REF}} diff={{DIFF}}',
  prepareSandbox: async () => ({
    cwd: '/tmp/quizme-sandbox',
    configFile: '/tmp/cfg.json',
    configContent: '{}\n',
  }),
  collectDiff: async () => ({
    range: 'cccc2222...aaaa1111bbbb',
    stat: ' src/a.js | 2 +-',
    patch: '--- a/src/a.js\n+++ b/src/a.js\n-old\n+new',
    commits: 'abc1234 Do the thing',
    truncated: false,
  }),
  runOpencode: async () => JSON.stringify({ type: 'text', text: JSON.stringify(quiz) }),
  ...over,
});

const silent = () => {};

// ---------------------------------------------------------------- generate

test('generate posts a quiz and blocks the PR with a pending status', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision(),
    inputs: inputs(),
    client,
    deps: okDeps(),
    log: silent,
  });

  assert.equal(result.action, 'generate');
  assert.equal(client.calls.created.length, 1);
  assert.equal(client.calls.updated.length, 0);

  const body = client.calls.created[0].body;
  assert.ok(hasMarker(body, MARKERS.quiz));
  assert.deepEqual(parseQuizKey(body).quiz, quiz);
  assert.equal(parseQuizKey(body).sha, 'aaaa1111bbbb');

  assert.deepEqual(client.calls.statuses, [
    {
      sha: 'aaaa1111bbbb',
      state: 'pending',
      context: 'quizme',
      description: 'Answer the 3-question quiz in the PR comment',
      targetUrl: 'https://github.test/c/501',
    },
  ]);
});

test('generate embeds the diff in the prompt instead of relying on tools', async () => {
  const seen = {};
  await runMode({
    decision: decision(),
    inputs: inputs({ questionCount: 3 }),
    client: fakeClient(),
    deps: okDeps({
      runOpencode: async (args) => {
        Object.assign(seen, args);
        return JSON.stringify({ type: 'text', text: JSON.stringify(quiz) });
      },
    }),
    log: silent,
  });

  assert.equal(
    seen.prompt,
    'count=3 range=cccc2222...aaaa1111bbbb ref=main diff=--- a/src/a.js\n+++ b/src/a.js\n-old\n+new',
  );
  assert.equal(seen.model, 'anthropic/claude-sonnet-4-5');
});

test('generate passes the PR range to the diff collector', async () => {
  const seen = {};
  await runMode({
    decision: decision(),
    inputs: inputs(),
    client: fakeClient(),
    deps: okDeps({
      collectDiff: async (args) => {
        Object.assign(seen, args);
        return { range: 'r', stat: 's', patch: 'p', commits: 'c', truncated: false };
      },
    }),
    log: silent,
  });

  assert.equal(seen.baseSha, 'cccc2222');
  assert.equal(seen.headSha, 'aaaa1111bbbb');
  assert.equal(seen.baseRef, 'main');
});

test('generate fails open when there is no readable diff', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision(),
    inputs: inputs(),
    client,
    deps: okDeps({
      collectDiff: async () => ({ range: 'x...y', stat: '', patch: '', commits: '', truncated: false }),
    }),
    log: silent,
  });

  assert.equal(result.action, 'generate-failed');
  assert.equal(client.calls.statuses[0].state, 'success');
  assert.match(client.calls.created[0].body, /Could not read a diff/);
});

test('a run that ends on a tool call explains itself', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision(),
    inputs: inputs(),
    client,
    deps: okDeps({
      runOpencode: async () => JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } }),
    }),
    log: silent,
  });

  assert.equal(result.action, 'generate-failed');
  assert.match(client.calls.created[0].body, /ended on a tool call/);
});

test('/quizme after answering reuses the graded comment rather than adding another', async () => {
  // Observed on a real PR: regenerating left the graded comment and posted a
  // second bot comment, so the thread grew one per /quizme.
  const graded = renderResults({
    sha: 'oldsha',
    quiz,
    selections: { 1: 'B', 2: 'C', 3: 'A' },
    result: {
      correct: 3,
      total: 3,
      outcomes: quiz.questions.map((q, i) => ({
        index: i + 1,
        selected: q.answer,
        expected: q.answer,
        correct: true,
      })),
    },
    actor: 'carrfane',
  });
  const client = fakeClient([{ id: 42, body: graded }]);

  await runMode({
    decision: decision({ reason: '/quizme requested by @carrfane' }),
    inputs: inputs(),
    client,
    deps: okDeps(),
    log: silent,
  });

  assert.equal(client.calls.created.length, 0, 'no second comment');
  assert.equal(client.calls.updated.length, 1);
  assert.equal(client.calls.updated[0].id, 42);
  assert.ok(hasMarker(client.calls.updated[0].body, MARKERS.quiz), 'it becomes a fresh quiz');
  assert.ok(!hasMarker(client.calls.updated[0].body, MARKERS.graded), 'the old result is replaced');
});

test('bypass also retires a graded comment rather than leaving it clickable', async () => {
  const graded = renderResults({
    sha: 'oldsha',
    quiz,
    selections: { 1: 'B', 2: 'C', 3: 'A' },
    result: { correct: 3, total: 3, outcomes: quiz.questions.map((q, i) => ({ index: i + 1, selected: q.answer, expected: q.answer, correct: true })) },
    actor: 'carrfane',
  });
  const client = fakeClient([{ id: 42, body: graded }]);

  await runMode({
    decision: decision({ mode: 'bypass' }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(client.calls.updated[0].id, 42);
  assert.ok(hasMarker(client.calls.updated[0].body, MARKERS.notice));
});

test('generate updates the existing quiz comment instead of stacking a second', async () => {
  const existing = { id: 42, body: renderQuiz({ sha: 'old', quiz }), html_url: 'https://github.test/c/42' };
  const client = fakeClient([existing]);

  await runMode({ decision: decision(), inputs: inputs(), client, deps: okDeps(), log: silent });

  assert.equal(client.calls.created.length, 0);
  assert.equal(client.calls.updated.length, 1);
  assert.equal(client.calls.updated[0].id, 42);
});

test('generate retries once before giving up', async () => {
  let attempts = 0;
  const client = fakeClient();
  const result = await runMode({
    decision: decision(),
    inputs: inputs(),
    client,
    deps: okDeps({
      runOpencode: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('rate limited');
        return JSON.stringify({ type: 'text', text: JSON.stringify(quiz) });
      },
    }),
    log: silent,
  });

  assert.equal(attempts, 2);
  assert.equal(result.action, 'generate');
  assert.equal(client.calls.statuses[0].state, 'pending');
});

test('generate fails open when the model never cooperates', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision(),
    inputs: inputs(),
    client,
    // What the real runOpencode rejects with: a full message for the log, and an
    // explicitly publishable one for the comment.
    deps: okDeps({
      runOpencode: async () => {
        throw publicError('stderr: dump of everything', 'AuthError: invalid api key');
      },
    }),
    log: silent,
  });

  assert.equal(result.action, 'generate-failed');
  assert.equal(client.calls.statuses[0].state, 'success', 'a broken model must not wedge the PR');
  assert.match(client.calls.statuses[0].description, /generation failed/i);

  const body = client.calls.created[0].body;
  assert.ok(hasMarker(body, MARKERS.notice));
  assert.ok(!hasMarker(body, MARKERS.quiz), 'a failure notice must never be gradeable');
  assert.ok(body.includes('invalid api key'), 'surfaces the real cause');
  assert.ok(!body.includes('dump of everything'), 'but not the raw stream');
  assert.ok(body.includes('/quizme'), 'tells the author how to retry');
});

/**
 * The invariant is fail-closed: an error that does not explicitly mark itself
 * publishable has nothing of its message published. The previous
 * `publicMessage ?? message` fallback failed open, so every new throw site was
 * one oversight away from leaking.
 */
test('an error with no publicMessage publishes nothing from its message', async () => {
  const client = fakeClient();
  await runMode({
    decision: decision(),
    inputs: inputs(),
    client,
    deps: okDeps({
      runOpencode: async () => {
        throw new Error('/home/runner/work/app/app exploded: sk-live-abcdef1234567890');
      },
    }),
    log: silent,
  });

  const body = client.calls.created[0].body;
  assert.ok(!body.includes('sk-live-abcdef1234567890'), 'no secret-adjacent text');
  assert.ok(!body.includes('/home/runner'), 'no runner filesystem paths');
  assert.match(body, /workflow log/i, 'but the reader is told where to look');
  assert.ok(body.includes('/quizme'), 'and how to retry');
});

test('a rejected model answer is not echoed into the comment', async () => {
  // validateQuiz interpolates model output. A same-repo author can steer that
  // output with their diff, and the notice is a public comment.
  const client = fakeClient();
  const malformed = {
    questions: [
      { ...quiz.questions[0], answer: 'INJECTED-PAYLOAD-9f2a' },
      quiz.questions[1],
      quiz.questions[2],
    ],
  };

  await runMode({
    decision: decision(),
    inputs: inputs(),
    client,
    deps: okDeps({
      runOpencode: async () =>
        JSON.stringify({ type: 'text', text: JSON.stringify(malformed) }),
    }),
    log: silent,
  });

  const body = client.calls.created[0].body;
  assert.ok(!body.includes('INJECTED-PAYLOAD-9f2a'), 'model output must not be published');
});

test('a generate failure publishes the safe message, never the raw stream', async () => {
  const client = fakeClient();
  const error = new Error('opencode exited with code 1. stdout: sk-live-abcdef1234567890 dump');
  error.publicMessage = 'opencode exited with code 1. AI_APICallError: model overloaded';

  await runMode({
    decision: decision(),
    inputs: inputs(),
    client,
    deps: okDeps({ runOpencode: async () => { throw error; } }),
    log: silent,
  });

  const body = client.calls.created[0].body;
  assert.ok(body.includes('AI_APICallError: model overloaded'), 'the real cause still surfaces');
  assert.ok(!body.includes('sk-live-abcdef1234567890'), 'the raw stream must not be published');
});

test('a missing quiz does not publish raw model output', async () => {
  // The model output is attacker-influenced on any pull request, so it belongs in
  // the log, not in a comment.
  const client = fakeClient();
  await runMode({
    decision: decision(),
    inputs: inputs(),
    client,
    deps: okDeps({
      runOpencode: async () =>
        JSON.stringify({ type: 'text', text: 'no json here, and a secret sk-live-abcdef1234567890' }),
    }),
    log: silent,
  });

  const body = client.calls.created[0].body;
  assert.ok(!body.includes('sk-live-abcdef1234567890'), 'raw model output must not be published');
  assert.ok(body.includes('/quizme'), 'the author is still told how to retry');
});

test('generate fails open when the model returns a malformed quiz', async () => {
  const client = fakeClient();
  const malformed = { questions: [{ question: 'x?', options: { A: 'a', B: 'b', C: 'c' }, answer: 'A', explanation: 'e' }] };
  const result = await runMode({
    decision: decision(),
    inputs: inputs({ questionCount: 1 }),
    client,
    deps: okDeps({
      runOpencode: async () => JSON.stringify({ type: 'text', text: JSON.stringify(malformed) }),
    }),
    log: silent,
  });

  assert.equal(result.action, 'generate-failed');
  assert.equal(client.calls.statuses[0].state, 'success');
  assert.match(client.calls.created[0].body, /missing option D/i);
});

test('generate fails open when the model returns the wrong number of questions', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision(),
    inputs: inputs({ questionCount: 3 }),
    client,
    deps: okDeps({
      runOpencode: async () =>
        JSON.stringify({ type: 'text', text: JSON.stringify({ questions: [quiz.questions[0]] }) }),
    }),
    log: silent,
  });

  assert.equal(result.action, 'generate-failed');
  assert.match(client.calls.created[0].body, /returned 1 questions, expected 3/);
});

test('generate fails open when the quiz is too big to post', async () => {
  const huge = {
    questions: [
      {
        question: 'q'.repeat(40000),
        options: { A: 'a'.repeat(20000), B: 'b', C: 'c', D: 'd' },
        answer: 'A',
        explanation: 'e'.repeat(20000),
      },
    ],
  };
  const client = fakeClient();
  const result = await runMode({
    decision: decision(),
    inputs: inputs({ questionCount: 1 }),
    client,
    deps: okDeps({ runOpencode: async () => JSON.stringify({ type: 'text', text: JSON.stringify(huge) }) }),
    log: silent,
  });

  assert.equal(result.action, 'generate-failed');
  assert.equal(client.calls.statuses[0].state, 'success');
});

// ------------------------------------------------------------------- grade

/**
 * Tick one option inside a specific question block, the way GitHub does when a
 * user clicks a checkbox. Operating per block matters because every question
 * shares the same option text in these fixtures.
 */
const tick = (body, questionNumber, letter) => {
  const header = `**${questionNumber}.**`;
  const start = body.indexOf(header);
  if (start === -1) throw new Error(`no question ${questionNumber} in body`);
  const nextHeader = body.indexOf(`**${questionNumber + 1}.**`, start);
  const end = nextHeader === -1 ? body.indexOf('\n---', start) : nextHeader;

  const block = body.slice(start, end);
  const target = `- [ ] ${letter}.`;
  if (!block.includes(target)) throw new Error(`option ${letter} already ticked in Q${questionNumber}`);
  return body.slice(0, start) + block.replace(target, `- [x] ${letter}.`) + body.slice(end);
};

const submit = (body) => body.replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);

const submittedBody = (letters) => {
  let body = renderQuiz({ sha: 'aaaa1111bbbb', quiz });
  letters.forEach((letter, i) => {
    if (letter) body = tick(body, i + 1, letter);
  });
  return submit(body);
};

test('the tick helper really does tick exactly one box per question', () => {
  const body = submittedBody(['B', 'C', 'A']);
  assert.equal((body.match(/- \[x\]/g) ?? []).length, 4, 'three answers plus submit');
});

test('grade scores a partial answer, reveals the key and unblocks', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision({ mode: 'grade', commentId: 77, commentBody: submittedBody(['B', 'A', 'A']) }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(result.action, 'grade');
  assert.equal(result.correct, 2);
  assert.equal(result.total, 3);

  const body = client.calls.updated[0].body;
  assert.ok(hasMarker(body, MARKERS.graded));
  assert.ok(!hasMarker(body, MARKERS.quiz));
  assert.ok(!body.includes('quizme:key'), 'the key is dropped once revealed');
  assert.ok(body.includes('e2'), 'shows the explanation for the missed question');
  assert.equal(isSubmitted(body), false, 'loop protection');

  assert.deepEqual(client.calls.statuses, [
    {
      sha: 'aaaa1111bbbb',
      state: 'success',
      context: 'quizme',
      description: 'Answered 2/3 — read the feedback',
      targetUrl: 'https://github.test/carrfane/app/pull/12',
    },
  ]);
});

test('grade passes even with a score of zero', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision({ mode: 'grade', commentId: 77, commentBody: submittedBody(['A', 'A', 'B']) }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(result.correct, 0);
  assert.equal(client.calls.statuses[0].state, 'success', 'engagement is the gate, not correctness');
});

test('an incomplete submission nudges and stays blocked', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision({ mode: 'grade', commentId: 77, commentBody: submittedBody(['B', null, 'A']) }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(result.action, 'grade-incomplete');
  assert.deepEqual(result.missing, [2]);
  assert.equal(client.calls.statuses.length, 0, 'status must stay pending');

  const body = client.calls.updated[0].body;
  assert.ok(body.includes('question 2'));
  assert.ok(hasMarker(body, MARKERS.quiz), 'the quiz stays answerable');
  assert.deepEqual(parseQuizKey(body).quiz, quiz, 'the key survives');
  assert.equal(isSubmitted(body), false);
});

test('a multi-question incomplete submission lists them readably', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision({ mode: 'grade', commentId: 77, commentBody: submittedBody([null, null, null]) }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.deepEqual(result.missing, [1, 2, 3]);
  assert.match(client.calls.updated[0].body, /questions 1, 2 and 3/);
});

test('grade fails open when the answer key is corrupt', async () => {
  const corrupt = submittedBody(['B', 'C', 'A']).replace(/<!-- quizme:key \S+ -->/, '<!-- quizme:key ?? -->');
  const client = fakeClient();
  const result = await runMode({
    decision: decision({ mode: 'grade', commentId: 77, commentBody: corrupt }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(result.action, 'grade-key-lost');
  assert.equal(client.calls.statuses[0].state, 'success');
  assert.ok(hasMarker(client.calls.updated[0].body, MARKERS.notice));
});

// --------------------------------------------------------- carry / bypass / skip

test('carry unblocks a new head sha without regenerating', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision({ mode: 'carry', priorSha: 'ffff9999aaaa', headSha: 'newsha1234' }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(result.action, 'carry');
  assert.equal(client.calls.statuses[0].sha, 'newsha1234');
  assert.equal(client.calls.statuses[0].state, 'success');
  assert.match(client.calls.statuses[0].description, /Already answered at ffff999/);
  assert.equal(client.calls.created.length, 0);
  assert.equal(client.calls.updated.length, 0);
});

test('bypass unblocks and retires the live quiz so its boxes stop inviting clicks', async () => {
  const client = fakeClient([{ id: 42, body: renderQuiz({ sha: 'aaaa1111bbbb', quiz }) }]);
  const result = await runMode({
    decision: decision({ mode: 'bypass', actor: 'carrfane' }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(result.action, 'bypass');
  assert.equal(client.calls.statuses[0].state, 'success');
  assert.equal(client.calls.statuses[0].description, 'Bypassed by @carrfane');
  assert.ok(hasMarker(client.calls.updated[0].body, MARKERS.notice));
  assert.ok(!hasMarker(client.calls.updated[0].body, MARKERS.quiz));
});

test('bypass works when there is no quiz comment yet', async () => {
  const client = fakeClient();
  await runMode({
    decision: decision({ mode: 'bypass' }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });
  assert.equal(client.calls.updated.length, 0);
  assert.equal(client.calls.statuses[0].state, 'success');
});

test('skip unblocks with the reason and posts nothing', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision({ mode: 'skip', reason: 'pull request is a draft' }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(result.action, 'skip');
  assert.equal(client.calls.statuses[0].state, 'success');
  assert.equal(client.calls.statuses[0].description, 'Not applicable: pull request is a draft');
  assert.equal(client.calls.created.length, 0, 'skipping must not add PR noise');
});

test('none touches nothing at all', async () => {
  const client = fakeClient();
  const result = await runMode({
    decision: decision({ mode: 'none', reason: 'unrelated comment' }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(result.action, 'none');
  assert.equal(client.calls.statuses.length, 0);
  assert.equal(client.calls.created.length, 0);
  assert.equal(client.calls.updated.length, 0);
});

test('status context is configurable', async () => {
  const client = fakeClient();
  await runMode({
    decision: decision({ mode: 'skip', reason: 'x' }),
    inputs: inputs({ statusContext: 'understand-it' }),
    client,
    deps: {},
    log: silent,
  });
  assert.equal(client.calls.statuses[0].context, 'understand-it');
});

test('the full loop is stable: generate, incomplete submit, resubmit, grade', async () => {
  const client = fakeClient();

  await runMode({ decision: decision(), inputs: inputs(), client, deps: okDeps(), log: silent });
  let body = client.calls.created[0].body;

  // Author ticks only question 1 and hits submit.
  body = submit(tick(body, 1, 'B'));
  await runMode({
    decision: decision({ mode: 'grade', commentId: 501, commentBody: body }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });
  body = client.calls.updated.at(-1).body;
  assert.equal(client.calls.statuses.length, 1, 'still only the pending status');
  assert.match(body, /questions 2 and 3/);

  // Author completes the remaining questions and resubmits.
  body = submit(tick(tick(body, 2, 'C'), 3, 'A'));

  const result = await runMode({
    decision: decision({ mode: 'grade', commentId: 501, commentBody: body }),
    inputs: inputs(),
    client,
    deps: {},
    log: silent,
  });

  assert.equal(result.action, 'grade');
  assert.equal(result.total, 3);
  assert.equal(client.calls.statuses.at(-1).state, 'success');
  assert.ok(hasMarker(client.calls.updated.at(-1).body, MARKERS.graded));
});
