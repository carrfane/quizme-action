import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKERS,
  SUBMIT_UNCHECKED,
  SUBMIT_CHECKED,
  encodeKey,
  decodeKey,
  hasMarker,
  renderQuiz,
  parseQuizKey,
  parseSelections,
  allAnswered,
  isSubmitted,
  renderResults,
  renderNotice,
} from '../scripts/lib/comment.mjs';

const quiz = {
  questions: [
    {
      question: 'Why does `load()` now return `null` instead of throwing?',
      options: {
        A: 'Because throwing was slow',
        B: 'So callers can distinguish "absent" from "broken"',
        C: 'To satisfy the linter',
        D: 'It was a copy-paste mistake',
      },
      answer: 'B',
      explanation: 'The caller in `boot.mjs` now branches on absence.',
    },
    {
      question: 'What breaks if the retry cap is removed?',
      options: {
        A: 'Nothing',
        B: 'Tests fail to compile',
        C: 'A 500 loops until the job times out',
        D: 'The status is never set',
      },
      answer: 'C',
      explanation: 'There is no other termination condition in the loop.',
    },
  ],
};

const SHA = 'abc1234def5678';

test('key codec round-trips', () => {
  const encoded = encodeKey(quiz);
  assert.deepEqual(decodeKey(encoded), quiz);
});

test('encoded key can never terminate an HTML comment', () => {
  const encoded = encodeKey(quiz);
  assert.ok(!encoded.includes('-'), 'base64 alphabet excludes -');
  assert.ok(!encoded.includes('>'), 'base64 alphabet excludes >');
  assert.ok(!encoded.includes('<'));
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
});

test('decodeKey returns null on garbage instead of throwing', () => {
  assert.equal(decodeKey('not base64 at all !!!'), null);
  assert.equal(decodeKey(Buffer.from('{"broken":').toString('base64')), null);
  assert.equal(decodeKey(''), null);
  assert.equal(decodeKey(undefined), null);
  assert.equal(decodeKey(Buffer.from('"a string"').toString('base64')), null);
  assert.equal(decodeKey(Buffer.from('{"questions":"nope"}').toString('base64')), null);
});

test('renderQuiz produces the documented structure', () => {
  const body = renderQuiz({ sha: SHA, quiz });

  assert.ok(hasMarker(body, MARKERS.quiz), 'has quiz marker');
  assert.ok(body.includes(`sha=${SHA}`), 'records the head sha');
  assert.ok(body.includes(`<!-- ${MARKERS.key} `), 'has key marker');
  assert.ok(body.includes('**1.**'));
  assert.ok(body.includes('**2.**'));
  assert.ok(!body.includes('**3.**'));
  assert.ok(body.includes(SUBMIT_UNCHECKED));
  assert.ok(!body.includes(SUBMIT_CHECKED));

  for (const letter of ['A', 'B', 'C', 'D']) {
    assert.ok(body.includes(`- [ ] ${letter}. `), `renders option ${letter}`);
  }
});

test('renderQuiz sets expectations about the grading delay', () => {
  // Ticking Submit costs roughly twelve seconds with no visible feedback, so the
  // comment says so rather than looking broken.
  const body = renderQuiz({ sha: SHA, quiz });
  assert.match(body, /results usually appear within 30 seconds/i);
});

test('the grading note cannot trip the workflow trigger filter', () => {
  const body = renderQuiz({ sha: SHA, quiz });
  const noteLine = body.split('\n').find((line) => /results usually appear/i.test(line));
  assert.ok(noteLine, 'the note is on its own line');
  assert.ok(!noteLine.includes('[x]'), 'the note must not contain a ticked box');
  assert.ok(!noteLine.includes('Submit answers'), 'the note must not repeat the submit label');
});

test('the grading note is not mistaken for an answer option', () => {
  // It lands inside the final question block for splitQuestionBlocks, so it must
  // not look like "- [ ] A. ..." or it would corrupt parsing.
  const body = renderQuiz({ sha: SHA, quiz });
  const selections = parseSelections(body);
  assert.deepEqual(Object.keys(selections), ['1', '2']);
  assert.deepEqual(Object.values(selections), [null, null], 'nothing is ticked yet');
});

test('the grading note is absent from the results, where it would be nonsense', () => {
  const body = renderResults({
    sha: SHA,
    quiz,
    selections: { 1: 'B', 2: 'C' },
    result: {
      correct: 2,
      total: 2,
      outcomes: [
        { index: 1, selected: 'B', expected: 'B', correct: true },
        { index: 2, selected: 'C', expected: 'C', correct: true },
      ],
    },
    actor: 'carrfane',
  });
  assert.ok(!/results usually appear/i.test(body));
});

test('renderQuiz never leaks the answer letter in plain text', () => {
  const body = renderQuiz({ sha: SHA, quiz });
  const visible = body.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!visible.includes('"answer"'), 'no plaintext answer field');
  assert.ok(!visible.includes('"explanation"'), 'no plaintext explanation field');
  assert.ok(!visible.includes(quiz.questions[0].explanation), 'no plaintext explanation');
  assert.ok(!visible.includes(quiz.questions[1].explanation), 'no plaintext explanation');
});

test('parseQuizKey recovers sha and quiz from a rendered body', () => {
  const body = renderQuiz({ sha: SHA, quiz });
  const parsed = parseQuizKey(body);
  assert.equal(parsed.sha, SHA);
  assert.deepEqual(parsed.quiz, quiz);
});

test('parseQuizKey returns null quiz when the key blob is corrupt', () => {
  const body = renderQuiz({ sha: SHA, quiz }).replace(
    /<!-- quizme:key [^ ]+ -->/,
    '<!-- quizme:key CORRUPTED!!! -->',
  );
  const parsed = parseQuizKey(body);
  assert.equal(parsed.quiz, null);
  assert.equal(parsed.sha, SHA);
});

test('parseQuizKey returns null for a body that is not a quiz', () => {
  assert.equal(parseQuizKey('just a comment'), null);
});

test('parseSelections reads the boxes GitHub flipped', () => {
  const body = renderQuiz({ sha: SHA, quiz })
    .replace('- [ ] B. So callers', '- [x] B. So callers')
    .replace('- [ ] C. A 500 loops', '- [x] C. A 500 loops');

  assert.deepEqual(parseSelections(body), { 1: 'B', 2: 'C' });
  assert.equal(allAnswered(parseSelections(body), 2), true);
});

test('parseSelections tolerates uppercase X', () => {
  const body = renderQuiz({ sha: SHA, quiz }).replace('- [ ] B. So callers', '- [X] B. So callers');
  assert.equal(parseSelections(body)[1], 'B');
});

test('parseSelections reports null for unanswered and multi-answered questions', () => {
  const body = renderQuiz({ sha: SHA, quiz })
    .replace('- [ ] A. Because throwing', '- [x] A. Because throwing')
    .replace('- [ ] B. So callers', '- [x] B. So callers');

  const selections = parseSelections(body);
  assert.equal(selections[1], null, 'two boxes checked is not an answer');
  assert.equal(selections[2], null, 'no boxes checked is not an answer');
  assert.equal(allAnswered(selections, 2), false);
});

test('the submit checkbox is not mistaken for an answer', () => {
  const body = renderQuiz({ sha: SHA, quiz }).replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);
  const selections = parseSelections(body);
  assert.deepEqual(Object.keys(selections), ['1', '2']);
});

test('isSubmitted only fires on the checked submit line', () => {
  const body = renderQuiz({ sha: SHA, quiz });
  assert.equal(isSubmitted(body), false);
  assert.equal(isSubmitted(body.replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED)), true);
});

test('renderResults marks the graded state and cannot retrigger grading', () => {
  const selections = { 1: 'B', 2: 'A' };
  const body = renderResults({
    sha: SHA,
    quiz,
    selections,
    result: {
      correct: 1,
      total: 2,
      outcomes: [
        { index: 1, selected: 'B', expected: 'B', correct: true },
        { index: 2, selected: 'A', expected: 'C', correct: false },
      ],
    },
    actor: 'carrfane',
  });

  assert.ok(hasMarker(body, MARKERS.graded));
  assert.ok(!hasMarker(body, MARKERS.quiz), 'quiz marker is replaced');
  assert.ok(!body.includes(SUBMIT_CHECKED), 'loop protection: no checked submit line');
  assert.ok(!body.includes(SUBMIT_UNCHECKED), 'loop protection: no submit line at all');
  assert.ok(!body.includes('<!-- quizme:key'), 'key blob is dropped once revealed');
  assert.ok(body.includes('1 / 2'));
  assert.ok(body.includes('score=1/2'));
  assert.ok(body.includes(quiz.questions[0].explanation));
  assert.ok(body.includes(quiz.questions[1].explanation));
  assert.ok(body.includes('**C.**'), 'reveals the correct letter for a wrong answer');
  assert.ok(body.includes('Correct answer'), 'labels the correction');
});

test('renderResults shows a full score without a corrections section', () => {
  const body = renderResults({
    sha: SHA,
    quiz,
    selections: { 1: 'B', 2: 'C' },
    result: {
      correct: 2,
      total: 2,
      outcomes: [
        { index: 1, selected: 'B', expected: 'B', correct: true },
        { index: 2, selected: 'C', expected: 'C', correct: true },
      ],
    },
    actor: 'carrfane',
  });
  assert.ok(body.includes('2 / 2'));
  assert.ok(!body.includes('Correct answer'));
});

test('renderQuiz throws a clear error if the body would exceed GitHub limits', () => {
  const huge = {
    questions: Array.from({ length: 3 }, () => ({
      question: 'q'.repeat(30000),
      options: { A: 'a', B: 'b', C: 'c', D: 'd' },
      answer: 'A',
      explanation: 'e'.repeat(30000),
    })),
  };
  assert.throws(() => renderQuiz({ sha: SHA, quiz: huge }), /too large/i);
});

test('renderNotice is marked so it is never treated as a quiz', () => {
  const body = renderNotice({ title: 'Quiz skipped', detail: 'draft PR' });
  assert.ok(hasMarker(body, MARKERS.notice));
  assert.equal(parseQuizKey(body), null);
  assert.equal(isSubmitted(body), false);
});
