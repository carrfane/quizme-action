/**
 * The workflow YAML filters on literal strings that our renderer produces. If
 * either side drifts, the gate silently stops firing: nothing throws, no test
 * fails, and pull requests just quietly never get graded.
 *
 * These tests pin the two sides together. This is the bug class a tool like
 * `act` would surface at runtime; asserting it statically is faster and certain.
 *
 * `yaml` is a devDependency only. Nothing under scripts/ imports it, so the
 * action itself still needs no install step on the runner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';

import {
  MARKERS,
  SUBMIT_CHECKED,
  SUBMIT_UNCHECKED,
  renderQuiz,
  renderResults,
  renderNotice,
  withNudge,
} from '../scripts/lib/comment.mjs';
import { DEFAULTS } from '../scripts/lib/config.mjs';

const root = new URL('../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');

const reusableText = read('.github/workflows/quizme.yml');
const actionText = read('action.yml');
const reusable = parse(reusableText);
const action = parse(actionText);

const quiz = {
  questions: [
    { question: 'Q1?', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'B', explanation: 'e' },
  ],
};

const submittedBody = () =>
  renderQuiz({ sha: 'abc1234', quiz }).replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);

const gradedBody = () =>
  renderResults({
    sha: 'abc1234',
    quiz,
    selections: { 1: 'B' },
    result: { correct: 1, total: 1, outcomes: [{ index: 1, selected: 'B', expected: 'B', correct: true }] },
    actor: 'carrfane',
  });

/** The job-level `if:` expression, as a single string. */
const filterExpression = () => {
  const expression = reusable.jobs.quizme.if;
  assert.equal(typeof expression, 'string', 'the quizme job must have an if: filter');
  return expression;
};

// -------------------------------------------------------- filter <-> renderer

test('the workflow filter uses the exact submit string the renderer produces', () => {
  assert.ok(
    filterExpression().includes(`contains(github.event.comment.body, '${SUBMIT_CHECKED}')`),
    `the filter must test for the literal ${JSON.stringify(SUBMIT_CHECKED)}`,
  );
  assert.ok(submittedBody().includes(SUBMIT_CHECKED), 'a submitted body contains that literal');
});

test('the workflow filter uses the exact quiz marker the renderer produces', () => {
  assert.ok(filterExpression().includes(`contains(github.event.comment.body, '<!-- ${MARKERS.quiz}')`));
  assert.ok(renderQuiz({ sha: 'abc1234', quiz }).includes(`<!-- ${MARKERS.quiz}`));
});

test('loop protection: none of the bodies we write can re-match the filter', () => {
  const filter = filterExpression();
  const literals = [...filter.matchAll(/contains\(github\.event\.comment\.body, '([^']+)'\)/g)].map(
    (match) => match[1],
  );
  assert.equal(literals.length, 2, 'expected the quiz marker and the submit literal');

  const bodiesWeWrite = {
    graded: gradedBody(),
    nudged: withNudge(submittedBody(), 'tick question 1'),
    notice: renderNotice({ title: 'x', detail: 'y' }),
  };

  for (const [name, body] of Object.entries(bodiesWeWrite)) {
    const matchesAll = literals.every((literal) => body.includes(literal));
    assert.equal(matchesAll, false, `a ${name} body must not satisfy the whole filter`);
  }
});

test('a submitted body does satisfy the whole filter, so grading actually fires', () => {
  const filter = filterExpression();
  const literals = [...filter.matchAll(/contains\(github\.event\.comment\.body, '([^']+)'\)/g)].map(
    (match) => match[1],
  );
  const body = submittedBody();
  for (const literal of literals) {
    assert.ok(body.includes(literal), `a submitted body must contain ${JSON.stringify(literal)}`);
  }
});

test('the slash command prefix in the filter matches what the router accepts', () => {
  assert.ok(filterExpression().includes("startsWith(github.event.comment.body, '/quizme')"));
});

/**
 * The README's composite example duplicates this filter, so it is a second copy
 * that can drift silently -- and it is the copy people paste. Pin both sides to
 * the same literals rather than trusting whoever edits the renderer next.
 */
test('the composite example in the README pins the same comment filter', () => {
  const readme = read('README.md');
  const literals = [
    `contains(github.event.comment.body, '${SUBMIT_CHECKED}')`,
    `contains(github.event.comment.body, '<!-- ${MARKERS.quiz}')`,
    "startsWith(github.event.comment.body, '/quizme')",
  ];

  for (const literal of literals) {
    assert.ok(
      filterExpression().includes(literal),
      `the reusable workflow must test for ${JSON.stringify(literal)}`,
    );
    assert.ok(
      readme.includes(literal),
      `the README composite example must test for ${JSON.stringify(literal)}`,
    );
  }
});

// ------------------------------------------------------------ input contract

test('the reusable workflow forwards every action input', () => {
  const forwarded = reusable.jobs.quizme.steps.at(-1).with;
  for (const name of Object.keys(action.inputs)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(forwarded, name),
      `the reusable workflow must forward "${name}" to the action`,
    );
  }
});

test('every reusable workflow input reaches the action', () => {
  const forwarded = reusable.jobs.quizme.steps.at(-1).with;
  for (const name of Object.keys(reusable.on.workflow_call.inputs)) {
    if (name === 'runs_on') continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(action.inputs, name),
      `action.yml must declare an input named "${name}"`,
    );
    assert.equal(
      forwarded[name],
      `\${{ inputs.${name} }}`,
      `"${name}" must be passed straight through`,
    );
  }
});

test('the api key travels as a secret, never as an input', () => {
  assert.ok(reusable.on.workflow_call.secrets.api_key.required, 'api_key must be a required secret');
  assert.ok(!('api_key' in reusable.on.workflow_call.inputs), 'api_key must not be a plain input');
  assert.equal(reusable.jobs.quizme.steps.at(-1).with.api_key, '${{ secrets.api_key }}');
});

test('defaults agree across config.mjs, action.yml and the reusable workflow', () => {
  const workflowInputs = reusable.on.workflow_call.inputs;
  const pairs = [
    ['model', DEFAULTS.model],
    ['opencode_version', DEFAULTS.opencodeVersion],
    ['question_count', DEFAULTS.questionCount],
    ['status_context', DEFAULTS.statusContext],
    ['min_changed_lines', DEFAULTS.minChangedLines],
  ];

  for (const [name, expected] of pairs) {
    assert.equal(String(workflowInputs[name].default), String(expected), `workflow ${name}`);
    assert.equal(String(action.inputs[name].default), String(expected), `action ${name}`);
  }

  assert.equal(String(workflowInputs.enabled.default), String(DEFAULTS.enabled));
  assert.equal(String(action.inputs.enabled.default), String(DEFAULTS.enabled));
});

test('the shipped ignore_paths default matches config.mjs', () => {
  const fromWorkflow = reusable.on.workflow_call.inputs.ignore_paths.default
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const fromAction = action.inputs.ignore_paths.default
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  assert.deepEqual(fromWorkflow, fromAction, 'workflow and action defaults must agree');
  for (const pattern of fromWorkflow) {
    assert.ok(DEFAULTS.ignorePaths.includes(pattern), `config.mjs is missing "${pattern}"`);
  }
});

// -------------------------------------------------------------- action shape

test('the workflow only reacts to pull_request actions the router handles', () => {
  const declared = filterExpression().match(/fromJSON\('(\[[^)]+\])'\)/);
  assert.ok(declared, 'the action allowlist must be a fromJSON array literal');
  assert.deepEqual(JSON.parse(declared[1]).sort(), [
    'opened',
    'ready_for_review',
    'reopened',
    'synchronize',
  ]);
});

test('grading is never cancelled by a concurrent run', () => {
  assert.equal(reusable.jobs.quizme.concurrency['cancel-in-progress'], false);
});

test('the action pins opencode rather than tracking latest', () => {
  assert.ok(actionText.includes('opencode-ai@${OPENCODE_VERSION}'));
  assert.ok(!actionText.includes('opencode-ai@latest'));
});

test('the expensive steps run only when generating', () => {
  const steps = action.runs.steps;
  const gated = steps.filter((step) => step.if === "steps.resolve.outputs.mode == 'generate'");
  const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout'));

  assert.equal(checkouts.length, 1, 'exactly one checkout');
  assert.ok(gated.includes(checkouts[0]), 'the checkout must be gated on generate');
  assert.equal(gated.length, 2, 'only the checkout and the opencode install are gated');
  assert.ok(
    gated.some((step) => String(step.run ?? '').includes('opencode-ai@')),
    'the opencode install must be gated too',
  );
});

test('the resolve step runs unconditionally and the run step skips only for none', () => {
  const steps = action.runs.steps;
  assert.equal(steps[0].id, 'resolve');
  assert.equal(steps[0].if, undefined, 'resolve must always run');
  assert.equal(steps.at(-1).if, "steps.resolve.outputs.mode != 'none'");
});

test('the PR checkout does not leave git credentials behind', () => {
  const checkout = action.runs.steps.find((step) => step.uses?.startsWith('actions/checkout'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['fetch-depth'], 0, 'the diff needs history');
  assert.equal(checkout.with.path, 'quizme-pr');
});

test('the reusable workflow pins the action to its own commit', () => {
  const selfCheckout = reusable.jobs.quizme.steps[0];
  assert.equal(selfCheckout.with.repository, 'carrfane/quizme-action');
  assert.equal(selfCheckout.with.ref, '${{ github.job_workflow_sha }}');
  assert.equal(reusable.jobs.quizme.steps.at(-1).uses, './.quizme');
});

test('every workflow in this repo is valid YAML with a trigger and no tabs', () => {
  const dir = new URL('.github/workflows/', root);
  const files = readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));
  assert.ok(files.length >= 3, `expected the reusable workflow, CI and self-quiz, got ${files.join(', ')}`);

  for (const file of files) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    assert.ok(!text.includes('\t'), `${file} must not contain tabs`);
    const parsed = parse(text);
    assert.ok(parsed.on ?? parsed.true, `${file} needs a trigger block`);
    assert.ok(parsed.jobs && Object.keys(parsed.jobs).length > 0, `${file} needs jobs`);
  }
});

test('action.yml is valid YAML declaring a composite action', () => {
  assert.equal(action.runs.using, 'composite');
  assert.ok(action.name && action.description);
  for (const step of action.runs.steps) {
    assert.ok(step.uses || step.shell === 'bash', 'every run step must declare shell: bash');
  }
});
