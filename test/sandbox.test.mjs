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
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

import { buildConfig } from '../scripts/lib/opencode.mjs';

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

test('the prompt tells the model it has no tools', () => {
  // If this instruction is ever lost, the model will try to explore, the session
  // will end on a tool call, and generation will fail with no quiz.
  const prompt = readFileSync(new URL('prompts/generate.md', root), 'utf8');
  assert.match(prompt, /no \*\*tools\*\*|\*\*no tools\*\*/i);
  assert.match(prompt, /\{\{DIFF\}\}/, 'the diff must be embedded in the prompt');
});
