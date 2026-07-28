/**
 * The agent reads your source code with a model. These tests pin the sandbox so
 * a careless allowlist edit cannot quietly widen it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

import { buildConfig } from '../scripts/lib/opencode.mjs';

const root = new URL('../', import.meta.url);
const action = parse(readFileSync(new URL('action.yml', root), 'utf8'));

const allowed = () =>
  Object.entries(buildConfig({ model: 'openai/gpt-5.5' }).permission.bash)
    .filter(([, value]) => value === 'allow')
    .map(([pattern]) => pattern);

test('bash is deny by default', () => {
  assert.equal(buildConfig({ model: 'm' }).permission.bash['*'], 'deny');
});

test('editing, and reaching the network, are denied', () => {
  const permission = buildConfig({ model: 'm' }).permission;
  assert.equal(permission.edit, 'deny');
  assert.equal(permission.webfetch, 'deny');
});

test('no allowlisted command can mutate the repository or escape the sandbox', () => {
  const forbidden = [
    'rm',
    'mv',
    'cp',
    'chmod',
    'curl',
    'wget',
    'nc',
    'ssh',
    'npm',
    'npx',
    'pip',
    'node',
    'python',
    'sh',
    'bash',
    'eval',
    'env',
    'printenv',
    'export',
    'git push',
    'git commit',
    'git checkout',
    'git config',
    'git remote',
    'git apply',
    'git clean',
    'git reset',
  ];

  for (const command of forbidden) {
    for (const pattern of allowed()) {
      assert.ok(
        pattern !== command && !pattern.startsWith(`${command} `),
        `"${pattern}" must not be allowlisted (matches ${command})`,
      );
    }
  }
});

test('cat is not allowlisted, so a stray git credential stays unreadable', () => {
  // Defence in depth alongside persist-credentials: false. `cat .git/config`
  // would print an auth extraheader if one were ever persisted.
  for (const pattern of allowed()) {
    assert.ok(!pattern.startsWith('cat'), '`cat` must stay off the allowlist');
  }
});

test('every allowlisted git subcommand is read-only', () => {
  const readOnly = new Set(['diff', 'log', 'show', 'status', 'ls-files', 'rev-parse', 'grep', 'blame']);
  for (const pattern of allowed()) {
    if (!pattern.startsWith('git ')) continue;
    const subcommand = pattern.split(' ')[1];
    assert.ok(readOnly.has(subcommand), `git ${subcommand} is not a known read-only subcommand`);
  }
});

test('the checkout never persists git credentials into the agent workspace', () => {
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
