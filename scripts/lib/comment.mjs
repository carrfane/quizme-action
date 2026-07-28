/**
 * The PR comment is the whole state store.
 *
 * A quiz comment carries:
 *   - a `quizme:quiz` marker with the head sha it was generated for
 *   - clickable task-list options (GitHub's only "button")
 *   - a `quizme:key` marker holding base64(JSON) of the answers and explanations
 *
 * Once graded the body is rewritten with a `quizme:graded` marker and, crucially,
 * without any submit line. That is loop protection: our own edit must not match
 * the workflow trigger filter again.
 */

export const MARKERS = {
  quiz: 'quizme:quiz',
  graded: 'quizme:graded',
  key: 'quizme:key',
  notice: 'quizme:notice',
};

export const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

/** Kept in sync with the `contains()` filter in .github/workflows/quizme.yml. */
export const SUBMIT_LABEL = '**Submit answers**';
export const SUBMIT_UNCHECKED = `- [ ] ${SUBMIT_LABEL}`;
export const SUBMIT_CHECKED = `- [x] ${SUBMIT_LABEL}`;

/** GitHub rejects issue comment bodies over 65536 characters. */
const MAX_BODY = 65536;
const BODY_BUDGET = 60000;

const FOOTER = '<sub>Posted by [quizme](https://github.com/carrfane/quizme-action).</sub>';

export function encodeKey(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * @returns {{questions: Array}|null} null on anything unexpected — callers treat
 * a null key as "quiz state lost" and fail open.
 */
export function decodeKey(encoded) {
  if (typeof encoded !== 'string' || encoded === '') return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasMarker(body, marker) {
  return typeof body === 'string' && body.includes(`<!-- ${marker}`);
}

export function renderQuiz({ sha, quiz, prompt }) {
  const lines = [
    `<!-- ${MARKERS.quiz} v=1 sha=${sha} -->`,
    '## Do you understand this PR?',
    '',
    prompt ??
      'Merging is blocked until you answer. Tick **one** option per question, then tick ' +
        '**Submit answers**. Your score does not matter — being shown the right answer does.',
    '',
  ];

  quiz.questions.forEach((question, i) => {
    lines.push(`**${i + 1}.** ${question.question}`, '');
    for (const letter of OPTION_LETTERS) {
      lines.push(`- [ ] ${letter}. ${question.options[letter]}`);
    }
    lines.push('');
  });

  lines.push(
    '---',
    '',
    SUBMIT_UNCHECKED,
    '',
    FOOTER,
    '',
    `<!-- ${MARKERS.key} ${encodeKey(quiz)} -->`,
  );

  const body = lines.join('\n');
  if (body.length > BODY_BUDGET) {
    throw new Error(
      `Rendered quiz is too large for a GitHub comment (${body.length} of ${MAX_BODY} characters). ` +
        'Reduce question_count or ask the model for shorter options.',
    );
  }
  return body;
}

/**
 * @returns {{sha: string, quiz: object|null}|null}
 */
export function parseQuizKey(body) {
  if (!hasMarker(body, MARKERS.quiz)) return null;
  const shaMatch = body.match(/<!--\s*quizme:quiz\s+v=1\s+sha=(\w+)\s*-->/i);
  const keyMatch = body.match(/<!--\s*quizme:key\s+(\S+)\s*-->/);
  return {
    sha: shaMatch ? shaMatch[1] : '',
    quiz: keyMatch ? decodeKey(keyMatch[1]) : null,
  };
}

/**
 * Map question number -> selected letter, or null when the user checked zero or
 * more than one box for that question.
 * @returns {Record<number, string|null>}
 */
export function parseSelections(body) {
  const selections = {};
  const blocks = splitQuestionBlocks(body);

  for (const { index, text } of blocks) {
    const checked = [];
    const optionLine = /^\s*-\s*\[( |x|X)\]\s*([A-D])\.\s/gm;
    let match;
    while ((match = optionLine.exec(text)) !== null) {
      if (match[1] !== ' ') checked.push(match[2].toUpperCase());
    }
    selections[index] = checked.length === 1 ? checked[0] : null;
  }

  return selections;
}

export function allAnswered(selections, expectedCount) {
  const keys = Object.keys(selections);
  if (keys.length !== expectedCount) return false;
  return keys.every((key) => typeof selections[key] === 'string');
}

export function isSubmitted(body) {
  if (typeof body !== 'string') return false;
  return new RegExp(`^\\s*-\\s*\\[[xX]\\]\\s*\\*\\*Submit answers\\*\\*`, 'm').test(body);
}

export function renderResults({ sha, quiz, selections, result, actor }) {
  const lines = [
    `<!-- ${MARKERS.graded} v=1 sha=${sha} score=${result.correct}/${result.total} -->`,
    `## Quiz results — ${result.correct} / ${result.total}`,
    '',
    `Answered by @${actor}. Merge is unblocked. Now the useful part: read the ` +
      'answers below and decide whether that is really what you wanted.',
    '',
  ];

  quiz.questions.forEach((question, i) => {
    const outcome = result.outcomes[i];
    const icon = outcome.correct ? '✅' : '❌';
    lines.push(`**${i + 1}.** ${icon} ${question.question}`, '');

    const selectedText = outcome.selected
      ? `**${outcome.selected}.** ${question.options[outcome.selected]}`
      : '_no answer recorded_';
    lines.push(`> Your answer: ${selectedText}`);

    if (!outcome.correct) {
      lines.push(
        `> Correct answer: **${outcome.expected}.** ${question.options[outcome.expected]}`,
      );
    }
    lines.push('>', `> ${question.explanation}`, '');
  });

  lines.push('---', '', 'Comment `/quizme` for a fresh quiz on the current head commit.', '', FOOTER);

  return truncate(lines.join('\n'));
}

export function renderNotice({ title, detail }) {
  return truncate(
    [`<!-- ${MARKERS.notice} v=1 -->`, `## ${title}`, '', detail, '', FOOTER].join('\n'),
  );
}

/**
 * Append a line to an existing body without disturbing its markers.
 * Used for the "you did not answer every question" nudge.
 */
export function appendNotice(body, notice) {
  const keyMatch = body.match(/\n?<!--\s*quizme:key\s+\S+\s*-->/);
  if (!keyMatch) return truncate(`${body}\n\n${notice}`);
  const keyBlock = keyMatch[0];
  const withoutKey = body.replace(keyBlock, '');
  return truncate(`${withoutKey}\n\n${notice}${keyBlock}`);
}

function splitQuestionBlocks(body) {
  if (typeof body !== 'string') return [];
  const header = /^\*\*(\d+)\.\*\*/gm;
  const starts = [];
  let match;
  while ((match = header.exec(body)) !== null) {
    starts.push({ index: Number.parseInt(match[1], 10), at: match.index });
  }
  return starts.map((start, i) => ({
    index: start.index,
    text: body.slice(start.at, i + 1 < starts.length ? starts[i + 1].at : body.length),
  }));
}

function truncate(body) {
  if (body.length <= MAX_BODY) return body;
  return `${body.slice(0, MAX_BODY - 200)}\n\n_…truncated to fit GitHub's comment size limit._`;
}
