import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderQuiz,
  withNudge,
  stripNudge,
  parseQuizKey,
  isSubmitted,
  SUBMIT_UNCHECKED,
  SUBMIT_CHECKED,
} from '../scripts/lib/comment.mjs';

const quiz = {
  questions: [
    { question: 'Q1?', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'B', explanation: 'e1' },
    { question: 'Q2?', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'C', explanation: 'e2' },
  ],
};

const submitted = () =>
  renderQuiz({ sha: 'abc1234', quiz })
    .replace('- [ ] B. b', '- [x] B. b')
    .replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);

test('withNudge unticks submit so our own edit cannot retrigger grading', () => {
  const nudged = withNudge(submitted(), 'tick question 2');
  assert.equal(isSubmitted(nudged), false);
  assert.ok(!nudged.includes(SUBMIT_CHECKED));
  assert.ok(nudged.includes(SUBMIT_UNCHECKED));
});

test('withNudge preserves the answer key and the answers already ticked', () => {
  const nudged = withNudge(submitted(), 'tick question 2');
  assert.deepEqual(parseQuizKey(nudged).quiz, quiz);
  assert.equal(parseQuizKey(nudged).sha, 'abc1234');
  assert.ok(nudged.includes('- [x] B. b'), 'keeps the choices the author already made');
});

test('withNudge keeps the key marker last so it stays out of the way', () => {
  const nudged = withNudge(submitted(), 'tick question 2');
  assert.match(nudged.trimEnd(), /<!-- quizme:key \S+ -->$/);
});

test('the nudge is replaced, not stacked, on repeated incomplete submissions', () => {
  let body = withNudge(submitted(), 'first nudge');
  body = withNudge(body.replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED), 'second nudge');
  body = withNudge(body.replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED), 'third nudge');

  assert.equal(body.match(/quizme:nudge -->/g).length, 2, 'exactly one open and one close marker');
  assert.ok(body.includes('third nudge'));
  assert.ok(!body.includes('first nudge'));
  assert.ok(!body.includes('second nudge'));
});

test('the nudge text cannot itself match the workflow submit filter', () => {
  const nudged = withNudge(submitted(), 'tick **Submit answers** again when ready');
  assert.ok(!nudged.includes('[x] **Submit answers**'));
});

test('stripNudge restores the original body', () => {
  const original = submitted();
  assert.equal(stripNudge(withNudge(original, 'x')).includes('quizme:nudge'), false);
});

test('withNudge works on a body that somehow lost its key marker', () => {
  const noKey = submitted().replace(/<!-- quizme:key \S+ -->/, '');
  const nudged = withNudge(noKey, 'tick question 2');
  assert.ok(nudged.includes('tick question 2'));
  assert.equal(isSubmitted(nudged), false);
});
