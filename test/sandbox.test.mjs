/**
 * The model is handed your source code as text. These tests pin the sandbox so
 * a careless edit cannot quietly widen it.
 *
 * The posture is deliberately absolute: the prompt is self-contained, so every
 * tool is disabled. That is both the tightest sandbox and the fix for the bug
 * that broke the first live run, where a tool call silently ended the session.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

import { buildConfig } from '../scripts/lib/opencode.mjs';
import { runMode } from '../scripts/lib/modes.mjs';
import { readInputs } from '../scripts/lib/config.mjs';

const root = new URL('../', import.meta.url);
const action = parse(readFileSync(new URL('action.yml', root), 'utf8'));
const config = () => buildConfig({ model: 'openai/gpt-5.5' });

test('every tool is disabled, including a wildcard catch-all', () => {
  const { tools } = config();
  assert.equal(tools['*'], false, 'unknown future tools must default to off');
  for (const tool of ['bash', 'edit', 'write', 'read', 'grep', 'glob', 'list', 'webfetch', 'task']) {
    assert.equal(tools[tool], false, `${tool} must be disabled`);
  }
});

test('no tool is ever enabled', () => {
  const enabled = Object.entries(config().tools).filter(([, on]) => on !== false);
  assert.deepEqual(enabled, [], 'nothing may be switched on');
});

test('permissions still deny mutation and network as a second layer', () => {
  const { permission } = config();
  assert.equal(permission.edit, 'deny');
  assert.equal(permission.webfetch, 'deny');
  assert.equal(permission.bash['*'], 'deny');
});

test('no bash command is allowlisted any more', () => {
  // The old read-only allowlist is gone: with tools disabled it was dead weight,
  // and an allowlist invites additions that would reopen the hole.
  const allowed = Object.entries(config().permission.bash).filter(([, v]) => v === 'allow');
  assert.deepEqual(allowed, [], 'nothing may be allowlisted');
});

test('the sandbox survives an explicit small_model', () => {
  const withSmall = buildConfig({ model: 'openai/gpt-5.5', smallModel: 'openai/gpt-5.4-mini' });
  assert.equal(withSmall.tools['*'], false);
  assert.equal(withSmall.permission.bash['*'], 'deny');
});

test('the checkout never persists git credentials into the workspace', () => {
  const checkout = action.runs.steps.find((step) => step.uses?.startsWith('actions/checkout'));
  assert.equal(checkout.with['persist-credentials'], false);
});

test('the api key is never echoed by the action shell', () => {
  const runStep = action.runs.steps.at(-1);
  assert.ok(runStep.run.includes('unset QUIZME_API_KEY'), 'the key is unset after export');
  assert.ok(!/echo[^\n]*QUIZME_API_KEY/.test(runStep.run), 'the key must never be echoed');
  assert.ok(!runStep.run.includes('set -x'), 'shell tracing would leak the key');
});

test('the api key is only exported when a quiz is actually generated', () => {
  // grade, carry, bypass and skip never call a model, so they have no business
  // holding the credential. Smaller window, fewer ways to lose it.
  const runStep = action.runs.steps.at(-1);
  assert.match(
    runStep.env.QUIZME_API_KEY,
    /mode == 'generate'/,
    'the key must be conditional on the generate mode',
  );
});

test('key-env.mjs resolves the provider variable without printing the key', () => {
  const script = new URL('scripts/key-env.mjs', root).pathname;
  const out = execFileSync(process.execPath, [script], {
    env: { ...process.env, INPUT_MODEL: 'openai/gpt-5.5', INPUT_API_KEY_ENV: '' },
    encoding: 'utf8',
  });
  assert.equal(out, 'OPENAI_API_KEY');
});

test('key-env.mjs honours an override', () => {
  const script = new URL('scripts/key-env.mjs', root).pathname;
  const out = execFileSync(process.execPath, [script], {
    env: { ...process.env, INPUT_MODEL: 'acme/model', INPUT_API_KEY_ENV: 'ACME_TOKEN' },
    encoding: 'utf8',
  });
  assert.equal(out, 'ACME_TOKEN');
});

test('key-env.mjs exits non-zero on an unknown provider', () => {
  const script = new URL('scripts/key-env.mjs', root).pathname;
  assert.throws(
    () =>
      execFileSync(process.execPath, [script], {
        env: { ...process.env, INPUT_MODEL: 'acme/model', INPUT_API_KEY_ENV: '' },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    /api_key_env/,
  );
});

/**
 * The sandbox in buildConfig is only as good as the directory opencode runs in.
 *
 * opencode merges config by precedence: OPENCODE_CONFIG (3) is *overridden* by a
 * project `opencode.json` (4) and by `.opencode/` directories (5), and
 * `.opencode/plugins/` is executed. All three are discovered from the cwd. So a
 * pull request could re-enable bash, or simply ship a plugin, and read the
 * provider API key straight out of the environment.
 *
 * The prompt already carries the whole diff, so opencode has no reason to sit in
 * the checkout at all. Running it in an empty directory removes the entire class.
 */
test('opencode never runs inside the checked-out pull request', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'quizme-sandbox-test-'));
  try {
    const workdir = path.join(tmp, 'quizme-pr');
    const runnerTemp = path.join(tmp, 'runner-temp');
    await mkdir(path.join(workdir, '.opencode', 'plugins'), { recursive: true });
    await mkdir(runnerTemp, { recursive: true });

    // Exactly what a hostile pull request would commit.
    await writeFile(
      path.join(workdir, 'opencode.json'),
      JSON.stringify({ tools: { bash: true }, permission: { bash: { '*': 'allow' } } }),
      'utf8',
    );
    await writeFile(
      path.join(workdir, '.opencode', 'plugins', 'exfiltrate.js'),
      'export default async () => {};\n',
      'utf8',
    );

    let seenCwd;
    const result = await runMode({
      decision: {
        mode: 'generate',
        reason: 'opened on #1',
        prNumber: 1,
        headSha: 'aaaa1111',
        baseSha: 'bbbb2222',
        baseRef: 'main',
        prUrl: 'https://github.test/pr/1',
        actor: 'outsider',
      },
      inputs: readInputs({ INPUT_IGNORE_PATHS: 'none' }),
      client: {
        listComments: async () => [],
        createComment: async (_n, body) => ({ id: 1, body, html_url: 'https://github.test/c/1' }),
        updateComment: async (id, body) => ({ id, body, html_url: 'https://github.test/c/1' }),
        setStatus: async (status) => status,
      },
      deps: {
        workdir,
        tmpdir: runnerTemp,
        readPrompt: async () => 'diff={{DIFF}}',
        collectDiff: async () => ({
          range: 'bbbb2222...aaaa1111',
          stat: '',
          patch: 'diff --git a/a b/a',
          commits: '',
          truncated: false,
        }),
        runOpencode: async (args) => {
          seenCwd = args.cwd;
          return JSON.stringify({ type: 'text', text: JSON.stringify(SANDBOX_QUIZ) });
        },
      },
      log: () => {},
    });

    assert.equal(result.action, 'generate', 'the run must actually reach opencode');
    assert.ok(seenCwd, 'runOpencode must be called');

    const cwd = path.resolve(seenCwd);
    const checkout = path.resolve(workdir);
    assert.notEqual(cwd, checkout, 'opencode must not run in the checkout');
    assert.ok(
      !cwd.startsWith(`${checkout}${path.sep}`),
      `opencode cwd ${cwd} must be outside the checkout`,
    );
    assert.deepEqual(
      await readdir(cwd),
      [],
      'the cwd must be empty, so no opencode.json, .opencode/ or AGENTS.md is discoverable',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('the sandbox stays outside the checkout even with no RUNNER_TEMP', async () => {
  // The fallback used to be `?? workdir`, which put the sandbox *inside* the
  // checkout and quietly restored everything the empty cwd exists to prevent.
  // opencode traverses up to the nearest git directory, so a nested sandbox
  // still finds the repository's opencode.json and .opencode/plugins.
  const tmp = await mkdtemp(path.join(tmpdir(), 'quizme-noruntemp-'));
  const saved = process.env.RUNNER_TEMP;
  delete process.env.RUNNER_TEMP;

  try {
    const workdir = path.join(tmp, 'quizme-pr');
    await mkdir(workdir, { recursive: true });

    let seenCwd;
    await runMode({
      decision: {
        mode: 'generate',
        reason: 'opened on #1',
        prNumber: 1,
        headSha: 'aaaa1111',
        baseSha: 'bbbb2222',
        baseRef: 'main',
        prUrl: 'https://github.test/pr/1',
        actor: 'carrfane',
      },
      inputs: readInputs({ INPUT_IGNORE_PATHS: 'none' }),
      client: {
        listComments: async () => [],
        createComment: async (_n, body) => ({ id: 1, body, html_url: 'https://github.test/c/1' }),
        updateComment: async (id, body) => ({ id, body, html_url: 'https://github.test/c/1' }),
        setStatus: async (status) => status,
      },
      deps: {
        workdir,
        // tmpdir deliberately absent
        readPrompt: async () => 'diff={{DIFF}}',
        collectDiff: async () => ({
          range: 'a...b',
          stat: '',
          patch: 'diff --git a/a b/a',
          commits: '',
          truncated: false,
        }),
        runOpencode: async (args) => {
          seenCwd = args.cwd;
          return JSON.stringify({ type: 'text', text: JSON.stringify(SANDBOX_QUIZ) });
        },
      },
      log: () => {},
    });

    const checkout = path.resolve(workdir);
    assert.ok(seenCwd, 'runOpencode must be called');
    assert.ok(
      !path.resolve(seenCwd).startsWith(`${checkout}${path.sep}`),
      `sandbox ${seenCwd} must not be inside the checkout`,
    );
  } finally {
    if (saved === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = saved;
    await rm(tmp, { recursive: true, force: true });
  }
});

test('an empty RUNNER_TEMP does not produce a relative sandbox path', async () => {
  // `??` only guards null and undefined. A set-but-empty RUNNER_TEMP would make
  // path.join('', 'quizme-sandbox') relative, which spawn resolves against the
  // process cwd — the workspace — putting the sandbox back inside a git tree.
  const tmp = await mkdtemp(path.join(tmpdir(), 'quizme-blanktmp-'));
  const saved = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = '';

  try {
    const workdir = path.join(tmp, 'quizme-pr');
    await mkdir(workdir, { recursive: true });

    let seenCwd;
    await runMode({
      decision: {
        mode: 'generate',
        reason: 'opened on #1',
        prNumber: 1,
        headSha: 'aaaa1111',
        baseSha: 'bbbb2222',
        baseRef: 'main',
        prUrl: 'https://github.test/pr/1',
        actor: 'carrfane',
      },
      inputs: readInputs({ INPUT_IGNORE_PATHS: 'none' }),
      client: {
        listComments: async () => [],
        createComment: async (_n, body) => ({ id: 1, body, html_url: 'https://github.test/c/1' }),
        updateComment: async (id, body) => ({ id, body, html_url: 'https://github.test/c/1' }),
        setStatus: async (status) => status,
      },
      deps: {
        workdir,
        tmpdir: '',
        readPrompt: async () => 'diff={{DIFF}}',
        collectDiff: async () => ({
          range: 'a...b',
          stat: '',
          patch: 'diff --git a/a b/a',
          commits: '',
          truncated: false,
        }),
        runOpencode: async (args) => {
          seenCwd = args.cwd;
          return JSON.stringify({ type: 'text', text: JSON.stringify(SANDBOX_QUIZ) });
        },
      },
      log: () => {},
    });

    assert.ok(seenCwd, 'runOpencode must be called');
    assert.ok(path.isAbsolute(seenCwd), `sandbox ${seenCwd} must be an absolute path`);
    assert.ok(
      !path.resolve(seenCwd).startsWith(`${path.resolve(workdir)}${path.sep}`),
      'and outside the checkout',
    );
  } finally {
    if (saved === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = saved;
    await rm(tmp, { recursive: true, force: true });
  }
});

const SANDBOX_QUIZ = {
  questions: Array.from({ length: 3 }, (_, i) => ({
    question: `Q${i + 1}?`,
    options: { A: 'a', B: 'b', C: 'c', D: 'd' },
    answer: 'A',
    explanation: 'e',
  })),
};

test('the prompt tells the model it has no tools', () => {
  // If this instruction is ever lost, the model will try to explore, the session
  // will end on a tool call, and generation will fail with no quiz.
  const prompt = readFileSync(new URL('prompts/generate.md', root), 'utf8');
  assert.match(prompt, /no \*\*tools\*\*|\*\*no tools\*\*/i);
  assert.match(prompt, /\{\{DIFF\}\}/, 'the diff must be embedded in the prompt');
});
