import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  buildConfig,
  renderPrompt,
  extractQuiz,
  extractError,
  validateQuiz,
  runOpencode,
} from '../scripts/lib/opencode.mjs';

/**
 * Captured verbatim from a real `opencode run --format json` failure. opencode
 * puts errors on stdout and leaves stderr empty, which is why the first live
 * run reported only "stderr: <empty>".
 */
const REAL_ERROR_STDOUT =
  '{"type":"error","timestamp":1785260715823,"sessionID":"ses_0562b53e4ffeyU2qePTMa3ocbh",' +
  '"error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.",' +
  '"ref":"err_469c8f37"}}}';

const question = (over = {}) => ({
  question: 'Why does `load()` return null now?',
  options: { A: 'a', B: 'b', C: 'c', D: 'd' },
  answer: 'B',
  explanation: 'because `boot()` branches on it',
  ...over,
});

test('buildConfig denies mutation and allows only read-only bash', () => {
  const config = buildConfig({ model: 'openai/gpt-5.5' });
  assert.equal(config.model, 'openai/gpt-5.5');
  assert.equal(config.permission.edit, 'deny');
  assert.equal(config.permission.webfetch, 'deny');
  assert.equal(config.permission.bash['*'], 'deny');
  assert.equal(config.permission.bash['git diff *'], 'allow');
  assert.equal(config.permission.bash['rg *'], 'allow');

  const allowed = Object.entries(config.permission.bash)
    .filter(([, v]) => v === 'allow')
    .map(([k]) => k);
  for (const dangerous of ['rm', 'curl', 'npm', 'git push', 'git commit', 'sh', 'eval']) {
    assert.ok(
      !allowed.some((pattern) => pattern.startsWith(dangerous)),
      `${dangerous} must not be allowlisted`,
    );
  }
});

test('buildConfig pins small_model to the primary model by default', () => {
  // Only one provider key is ever exported, so a cross-provider small model
  // chosen by opencode would have no credentials.
  const config = buildConfig({ model: 'openai/gpt-5.5' });
  assert.equal(config.small_model, 'openai/gpt-5.5');
});

test('buildConfig honours an explicit small_model', () => {
  const config = buildConfig({ model: 'openai/gpt-5.5', smallModel: 'openai/gpt-5.4-mini' });
  assert.equal(config.model, 'openai/gpt-5.5');
  assert.equal(config.small_model, 'openai/gpt-5.4-mini');
});

test('buildConfig treats a blank small_model as unset', () => {
  assert.equal(buildConfig({ model: 'openai/gpt-5.5', smallModel: '' }).small_model, 'openai/gpt-5.5');
});

test('extractError reads the real failure payload opencode emits on stdout', () => {
  const message = extractError(REAL_ERROR_STDOUT);
  assert.match(message, /UnknownError/);
  assert.match(message, /Unexpected server error/);
  assert.match(message, /err_469c8f37/);
});

test('extractError ignores non-error events and malformed lines', () => {
  const stdout = [
    JSON.stringify({ type: 'session.start' }),
    'not json at all',
    '{"broken":',
    JSON.stringify({ type: 'text', text: 'hello' }),
  ].join('\n');
  assert.equal(extractError(stdout), null);
});

test('extractError handles a top-level error message and a missing name', () => {
  assert.match(extractError(JSON.stringify({ type: 'error', error: { message: 'bad key' } })), /bad key/);
  assert.match(extractError(JSON.stringify({ type: 'error', error: {} })), /Error/);
});

test('extractError joins multiple error events', () => {
  const stdout = [
    JSON.stringify({ type: 'error', error: { name: 'A', data: { message: 'first' } } }),
    JSON.stringify({ type: 'error', error: { name: 'B', data: { message: 'second' } } }),
  ].join('\n');
  assert.match(extractError(stdout), /first; B: second/);
});

test('extractError tolerates empty and nullish input', () => {
  assert.equal(extractError(''), null);
  assert.equal(extractError(undefined), null);
  assert.equal(extractError(null), null);
});

test('renderPrompt substitutes placeholders and leaves unknown ones alone', () => {
  const out = renderPrompt('{{A}} then {{B}} and {{MISSING}}', { A: 'one', B: 2 });
  assert.equal(out, 'one then 2 and {{MISSING}}');
});

test('extractQuiz reads a quiz from a --format json event stream', () => {
  const stdout = [
    JSON.stringify({ type: 'session.start', properties: {} }),
    JSON.stringify({ type: 'tool', properties: { name: 'bash', text: 'git diff' } }),
    JSON.stringify({
      type: 'message.part.updated',
      properties: { part: { type: 'text', text: JSON.stringify({ questions: [question()] }) } },
    }),
  ].join('\n');

  const quiz = extractQuiz(stdout);
  assert.equal(quiz.questions.length, 1);
  assert.equal(quiz.questions[0].answer, 'B');
});

test('extractQuiz takes the last quiz-shaped message, not the first', () => {
  const stdout = [
    JSON.stringify({ type: 'text', text: JSON.stringify({ questions: [question({ answer: 'A' })] }) }),
    JSON.stringify({ type: 'text', text: JSON.stringify({ questions: [question({ answer: 'D' })] }) }),
  ].join('\n');
  assert.equal(extractQuiz(stdout).questions[0].answer, 'D');
});

test('extractQuiz strips a json code fence', () => {
  const stdout = JSON.stringify({
    type: 'text',
    text: '```json\n' + JSON.stringify({ questions: [question()] }) + '\n```',
  });
  assert.equal(extractQuiz(stdout).questions.length, 1);
});

test('extractQuiz survives leading and trailing prose', () => {
  const stdout = JSON.stringify({
    type: 'text',
    text: `Here is the quiz you asked for:\n${JSON.stringify({ questions: [question()] })}\nHope that helps!`,
  });
  assert.equal(extractQuiz(stdout).questions.length, 1);
});

test('extractQuiz handles braces inside option strings', () => {
  const tricky = question({ options: { A: 'a{b}', B: 'quote " and }', C: 'c', D: 'd' } });
  const stdout = JSON.stringify({ type: 'text', text: JSON.stringify({ questions: [tricky] }) });
  assert.equal(extractQuiz(stdout).questions[0].options.B, 'quote " and }');
});

test('extractQuiz falls back to plain non-JSON stdout', () => {
  assert.equal(extractQuiz(JSON.stringify({ questions: [question()] })).questions.length, 1);
});

test('extractQuiz returns null when there is no quiz', () => {
  assert.equal(extractQuiz(''), null);
  assert.equal(extractQuiz('I cannot help with that.'), null);
  assert.equal(extractQuiz(JSON.stringify({ type: 'text', text: '{"other":1}' })), null);
});

test('validateQuiz accepts a well-formed quiz and normalises whitespace', () => {
  const result = validateQuiz(
    { questions: [question({ question: '  padded?  ', explanation: ' why ' })] },
    1,
  );
  assert.equal(result.questions[0].question, 'padded?');
  assert.equal(result.questions[0].explanation, 'why');
  assert.deepEqual(Object.keys(result.questions[0].options), ['A', 'B', 'C', 'D']);
});

test('validateQuiz rejects each malformed shape with a distinct message', () => {
  const cases = [
    [null, 1, /not a JSON object/],
    ['string', 1, /not a JSON object/],
    [[], 1, /not a JSON object/],
    [{}, 1, /no "questions" array/],
    [{ questions: [question(), question({ question: 'other?' })] }, 1, /returned 2 questions, expected 1/],
    [{ questions: [question({ question: '' })] }, 1, /question 1 has an empty "question"/],
    [{ questions: [question({ options: undefined })] }, 1, /question 1 has no "options"/],
    [{ questions: [question({ options: { A: 'a', B: 'b', C: 'c' } })] }, 1, /missing option D/],
    [{ questions: [question({ options: { A: 'a', B: 'b', C: 'c', D: '  ' } })] }, 1, /missing option D/],
    [
      { questions: [question({ options: { A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' } })] },
      1,
      /exactly options A-D/,
    ],
    [{ questions: [question({ answer: 'E' })] }, 1, /expected one of A-D/],
    [{ questions: [question({ answer: 'b' })] }, 1, /expected one of A-D/],
    [{ questions: [question({ explanation: '' })] }, 1, /empty "explanation"/],
    [{ questions: [question(), question()] }, 2, /duplicate questions/],
  ];

  for (const [input, count, pattern] of cases) {
    assert.throws(() => validateQuiz(input, count), pattern, JSON.stringify(input).slice(0, 60));
  }
});

function fakeSpawn({ code = 0, stdout = '', stderr = '', failToStart = false } = {}) {
  const calls = [];
  const impl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (failToStart) {
        child.emit('error', new Error('spawn opencode ENOENT'));
        return;
      }
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
  return { calls, impl };
}

test('runOpencode passes the expected CLI arguments and config env', async () => {
  const { calls, impl } = fakeSpawn({ stdout: 'ok' });
  const out = await runOpencode({
    prompt: 'the prompt',
    model: 'openai/gpt-5.5',
    cwd: '/work/quizme-pr',
    configFile: '/tmp/cfg.json',
    env: { PATH: '/usr/bin' },
    spawnImpl: impl,
  });

  assert.equal(out, 'ok');
  assert.equal(calls[0].cmd, 'opencode');
  assert.deepEqual(calls[0].args, [
    'run',
    '--format',
    'json',
    '--model',
    'openai/gpt-5.5',
    '--agent',
    'plan',
    'the prompt',
  ]);
  assert.equal(calls[0].options.cwd, '/work/quizme-pr');
  assert.equal(calls[0].options.env.OPENCODE_CONFIG, '/tmp/cfg.json');
});

test('runOpencode surfaces stderr on a non-zero exit', async () => {
  const { impl } = fakeSpawn({ code: 1, stderr: 'invalid api key' });
  await assert.rejects(
    () => runOpencode({ prompt: 'p', model: 'm', cwd: '.', configFile: 'c', spawnImpl: impl }),
    /exited with code 1.*invalid api key/s,
  );
});

test('runOpencode prefers the structured stdout error over empty stderr', async () => {
  // The regression: this used to report "stderr: <empty>" and tell you nothing.
  const { impl } = fakeSpawn({ code: 1, stdout: REAL_ERROR_STDOUT, stderr: '' });
  await assert.rejects(
    () => runOpencode({ prompt: 'p', model: 'm', cwd: '.', configFile: 'c', spawnImpl: impl }),
    /Unexpected server error/,
  );

  const { impl: impl2 } = fakeSpawn({ code: 1, stdout: REAL_ERROR_STDOUT, stderr: '' });
  await assert.rejects(
    () => runOpencode({ prompt: 'p', model: 'm', cwd: '.', configFile: 'c', spawnImpl: impl2 }),
    (error) => {
      assert.ok(!/<empty>/.test(error.message), 'must not fall back to the useless empty message');
      return true;
    },
  );
});

test('runOpencode falls back to a stdout tail when there is nothing structured', async () => {
  const { impl } = fakeSpawn({ code: 1, stdout: 'something went sideways', stderr: '' });
  await assert.rejects(
    () => runOpencode({ prompt: 'p', model: 'm', cwd: '.', configFile: 'c', spawnImpl: impl }),
    /stdout: something went sideways/,
  );
});

test('runOpencode says so plainly when there is no output at all', async () => {
  const { impl } = fakeSpawn({ code: 1, stdout: '', stderr: '' });
  await assert.rejects(
    () => runOpencode({ prompt: 'p', model: 'm', cwd: '.', configFile: 'c', spawnImpl: impl }),
    /No output on stdout or stderr/,
  );
});

test('runOpencode reports a missing binary clearly', async () => {
  const { impl } = fakeSpawn({ failToStart: true });
  await assert.rejects(
    () => runOpencode({ prompt: 'p', model: 'm', cwd: '.', configFile: 'c', spawnImpl: impl }),
    /Could not start opencode.*ENOENT/s,
  );
});

test('runOpencode enforces a timeout', async () => {
  const impl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  await assert.rejects(
    () =>
      runOpencode({
        prompt: 'p',
        model: 'm',
        cwd: '.',
        configFile: 'c',
        timeoutMs: 10,
        spawnImpl: impl,
      }),
    /timed out/,
  );
});
