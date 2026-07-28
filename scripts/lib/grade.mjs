/**
 * Scoring is deterministic and offline: the answer key travelled with the
 * comment, so grading needs no model call and no checkout.
 */

/**
 * @param {{quiz: {questions: Array<{answer: string}>}, selections: Record<number, string|null>}} args
 * @returns {{correct: number, total: number, outcomes: Array<{index: number, selected: string|null, expected: string, correct: boolean}>}}
 */
export function gradeQuiz({ quiz, selections }) {
  if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    throw new Error('Cannot grade: quiz has no questions.');
  }

  const outcomes = quiz.questions.map((question, i) => {
    const index = i + 1;
    const selected = selections?.[index] ?? null;
    const expected = question.answer;
    return { index, selected, expected, correct: selected === expected };
  });

  return {
    correct: outcomes.filter((outcome) => outcome.correct).length,
    total: outcomes.length,
    outcomes,
  };
}
