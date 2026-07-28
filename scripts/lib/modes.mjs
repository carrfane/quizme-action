/**
 * The five mode handlers.
 *
 * Every handler is fail-open by design: this is a discipline aid, not a security
 * control, so a model hiccup or a bad key must never wedge a pull request. The
 * only path that deliberately leaves the status red is an incomplete submission,
 * because the author simply has not finished yet.
 */

import { readFile } from 'node:fs/promises';

import {
  MARKERS,
  hasMarker,
  renderQuiz,
  renderResults,
  renderNotice,
  parseQuizKey,
  parseSelections,
  allAnswered,
  withNudge,
} from './comment.mjs';
import { gradeQuiz } from './grade.mjs';
import { renderPrompt, extractQuiz, validateQuiz, writeConfig, runOpencode } from './opencode.mjs';

const GENERATE_ATTEMPTS = 2;

export async function runMode({ decision, inputs, client, deps = {}, log = console.log }) {
  const handlers = { generate, carry, grade, bypass, skip };
  const handler = handlers[decision.mode];
  if (!handler) {
    log(`quizme: nothing to do (${decision.reason})`);
    return { action: 'none' };
  }
  return handler({ decision, inputs, client, deps, log });
}

async function generate({ decision, inputs, client, deps, log }) {
  const existing = await findQuizComment(client, decision.prNumber);

  let built;
  let lastError;
  for (let attempt = 1; attempt <= GENERATE_ATTEMPTS; attempt += 1) {
    try {
      const quiz = await generateQuiz({ decision, inputs, deps, log, attempt });
      // Rendering must live inside the retry so an oversized quiz also fails
      // open instead of throwing past the handler.
      built = { quiz, body: renderQuiz({ sha: decision.headSha, quiz }) };
      break;
    } catch (error) {
      lastError = error;
      log(`quizme: generation attempt ${attempt} failed: ${error.message}`);
    }
  }

  if (!built) {
    // Fail open: say why, unblock, get out of the way.
    const body = renderNotice({
      title: 'Quiz could not be generated',
      detail:
        `Merging is **not** blocked. quizme failed to build a quiz for \`${short(decision.headSha)}\`:\n\n` +
        '```\n' +
        `${lastError?.message ?? 'unknown error'}\n` +
        '```\n\n' +
        'Comment `/quizme` to try again.',
    });
    await upsert(client, decision.prNumber, existing, body);
    await client.setStatus({
      sha: decision.headSha,
      state: 'success',
      context: inputs.statusContext,
      description: 'Quiz generation failed — merging unblocked',
      targetUrl: decision.prUrl,
    });
    return { action: 'generate-failed', error: lastError?.message };
  }

  const count = built.quiz.questions.length;
  const comment = await upsert(client, decision.prNumber, existing, built.body);

  await client.setStatus({
    sha: decision.headSha,
    state: 'pending',
    context: inputs.statusContext,
    description: `Answer the ${count}-question quiz in the PR comment`,
    targetUrl: comment?.html_url || decision.prUrl,
  });

  log(`quizme: posted a ${count}-question quiz on #${decision.prNumber}`);
  return { action: 'generate', questionCount: count };
}

async function generateQuiz({ decision, inputs, deps, log, attempt }) {
  const workdir = deps.workdir ?? process.cwd();
  const tmpdir = deps.tmpdir ?? process.env.RUNNER_TEMP ?? workdir;

  const template = await (deps.readPrompt ?? readPromptFile)();
  const prompt = renderPrompt(template, {
    QUESTION_COUNT: inputs.questionCount,
    BASE_SHA: decision.baseSha,
    HEAD_SHA: decision.headSha,
    BASE_REF: decision.baseRef,
  });

  const configFile = await (deps.writeConfig ?? writeConfig)({ dir: tmpdir, model: inputs.model });

  log(`quizme: asking ${inputs.model} for ${inputs.questionCount} questions (attempt ${attempt})`);
  const stdout = await (deps.runOpencode ?? runOpencode)({
    prompt,
    model: inputs.model,
    cwd: workdir,
    configFile,
  });

  const raw = extractQuiz(stdout);
  if (!raw) {
    throw new Error(
      `Could not find a JSON quiz in the model output. Last 400 characters: ${String(stdout).slice(-400)}`,
    );
  }
  return validateQuiz(raw, inputs.questionCount);
}

async function grade({ decision, inputs, client, log }) {
  const parsed = parseQuizKey(decision.commentBody);

  if (!parsed?.quiz) {
    await client.updateComment(
      decision.commentId,
      renderNotice({
        title: 'Quiz state lost',
        detail:
          'The answer key stored in this comment is missing or unreadable, so it cannot be ' +
          'graded. Merging is **not** blocked. Comment `/quizme` for a fresh quiz.',
      }),
    );
    await client.setStatus({
      sha: decision.headSha,
      state: 'success',
      context: inputs.statusContext,
      description: 'Quiz state lost — merging unblocked',
      targetUrl: decision.prUrl,
    });
    return { action: 'grade-key-lost' };
  }

  const quiz = parsed.quiz;
  const selections = parseSelections(decision.commentBody);

  if (!allAnswered(selections, quiz.questions.length)) {
    const missing = quiz.questions
      .map((_, i) => i + 1)
      .filter((index) => typeof selections[index] !== 'string');

    await client.updateComment(
      decision.commentId,
      withNudge(
        decision.commentBody,
        `Not submitted yet: tick exactly one option for ${listNumbers(missing)}, ` +
          'then tick **Submit answers** again.',
      ),
    );
    log(`quizme: incomplete submission, missing ${missing.join(', ')}`);
    return { action: 'grade-incomplete', missing };
  }

  const result = gradeQuiz({ quiz, selections });
  await client.updateComment(
    decision.commentId,
    renderResults({ sha: parsed.sha || decision.headSha, quiz, selections, result, actor: decision.actor }),
  );
  await client.setStatus({
    sha: decision.headSha,
    state: 'success',
    context: inputs.statusContext,
    description: `Answered ${result.correct}/${result.total} — read the feedback`,
    targetUrl: decision.prUrl,
  });

  log(`quizme: graded ${result.correct}/${result.total} for @${decision.actor}`);
  return { action: 'grade', ...result };
}

async function carry({ decision, inputs, client, log }) {
  await client.setStatus({
    sha: decision.headSha,
    state: 'success',
    context: inputs.statusContext,
    description: `Already answered at ${short(decision.priorSha) || 'an earlier commit'}`,
    targetUrl: decision.prUrl,
  });
  log(`quizme: carried a previous pass forward to ${short(decision.headSha)}`);
  return { action: 'carry' };
}

async function bypass({ decision, inputs, client, log }) {
  const existing = await findQuizComment(client, decision.prNumber);
  if (existing) {
    // Retire the live quiz so its checkboxes stop inviting clicks.
    await client.updateComment(
      existing.id,
      renderNotice({
        title: 'Quiz bypassed',
        detail: `@${decision.actor} bypassed the quiz with \`/quizme skip\`. Merging is unblocked.`,
      }),
    );
  }

  await client.setStatus({
    sha: decision.headSha,
    state: 'success',
    context: inputs.statusContext,
    description: `Bypassed by @${decision.actor}`,
    targetUrl: decision.prUrl,
  });
  log(`quizme: bypassed by @${decision.actor}`);
  return { action: 'bypass' };
}

async function skip({ decision, inputs, client, log }) {
  const status = {
    sha: decision.headSha,
    state: 'success',
    context: inputs.statusContext,
    description: `Not applicable: ${decision.reason}`,
    targetUrl: decision.prUrl,
  };

  try {
    await client.setStatus(status);
  } catch (error) {
    // A fork's `pull_request` token is read-only, so this 403 is expected and
    // must not paint a red X on a contributor's PR. Every other 403 is a real
    // misconfiguration and still fails loudly.
    if (decision.forkSkip && / with 403 /.test(error.message)) {
      log(
        'quizme: cannot write a commit status on a fork pull request (read-only token). ' +
          'If quizme is a required check, a maintainer can comment "/quizme skip" to unblock it.',
      );
      return { action: 'skip-fork-unreported', reason: decision.reason };
    }
    throw error;
  }

  log(`quizme: skipped (${decision.reason})`);
  return { action: 'skip', reason: decision.reason };
}

/** Idempotency: reuse our own comment instead of stacking new ones. */
async function findQuizComment(client, prNumber) {
  const comments = await client.listComments(prNumber);
  const ours = comments.filter(
    (comment) => hasMarker(comment.body, MARKERS.quiz) || hasMarker(comment.body, MARKERS.notice),
  );
  return ours.length > 0 ? ours[ours.length - 1] : null;
}

async function upsert(client, prNumber, existing, body) {
  return existing ? client.updateComment(existing.id, body) : client.createComment(prNumber, body);
}

function readPromptFile() {
  return readFile(new URL('../../prompts/generate.md', import.meta.url), 'utf8');
}

function listNumbers(numbers) {
  if (numbers.length === 1) return `question ${numbers[0]}`;
  return `questions ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

function short(sha) {
  return (sha ?? '').slice(0, 7);
}
