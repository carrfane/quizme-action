import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gradeQuiz } from '../scripts/lib/grade.mjs';

const quiz = {
  questions: [{ answer: 'B' }, { answer: 'C' }, { answer: 'A' }],
};

test('a perfect score', () => {
  const result = gradeQuiz({ quiz, selections: { 1: 'B', 2: 'C', 3: 'A' } });
  assert.equal(result.correct, 3);
  assert.equal(result.total, 3);
  assert.ok(result.outcomes.every((o) => o.correct));
});

test('a partial score reports per-question detail', () => {
  const result = gradeQuiz({ quiz, selections: { 1: 'B', 2: 'A', 3: 'A' } });
  assert.equal(result.correct, 2);
  assert.deepEqual(result.outcomes[1], {
    index: 2,
    selected: 'A',
    expected: 'C',
    correct: false,
  });
});

test('zero correct still grades — passing is the caller policy, not ours', () => {
  const result = gradeQuiz({ quiz, selections: { 1: 'A', 2: 'A', 3: 'B' } });
  assert.equal(result.correct, 0);
  assert.equal(result.total, 3);
});

test('a missing selection counts as wrong, not as a crash', () => {
  const result = gradeQuiz({ quiz, selections: { 1: 'B', 2: null } });
  assert.equal(result.correct, 1);
  assert.equal(result.outcomes[1].selected, null);
  assert.equal(result.outcomes[2].selected, null);
  assert.equal(result.outcomes[2].expected, 'A');
});

test('selections being entirely absent is survivable', () => {
  const result = gradeQuiz({ quiz, selections: undefined });
  assert.equal(result.correct, 0);
  assert.equal(result.outcomes.length, 3);
});

test('grading refuses an empty or malformed quiz', () => {
  assert.throws(() => gradeQuiz({ quiz: null, selections: {} }), /no questions/);
  assert.throws(() => gradeQuiz({ quiz: { questions: [] }, selections: {} }), /no questions/);
  assert.throws(() => gradeQuiz({ quiz: { questions: 'nope' }, selections: {} }), /no questions/);
});

test('grading is case sensitive on the letter, matching what we render', () => {
  const result = gradeQuiz({ quiz: { questions: [{ answer: 'B' }] }, selections: { 1: 'B' } });
  assert.equal(result.correct, 1);
});
