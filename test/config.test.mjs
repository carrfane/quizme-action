import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apiKeyEnvFor, readInputs, DEFAULTS } from '../scripts/lib/config.mjs';

test('apiKeyEnvFor maps every known provider prefix', () => {
  const cases = {
    'openai/gpt-5.5': 'OPENAI_API_KEY',
    'anthropic/claude-sonnet-4-5': 'ANTHROPIC_API_KEY',
    'openrouter/anthropic/claude-sonnet-4': 'OPENROUTER_API_KEY',
    'google/gemini-2.5-pro': 'GOOGLE_GENERATIVE_AI_API_KEY',
    'groq/llama-3.3-70b': 'GROQ_API_KEY',
    'xai/grok-4': 'XAI_API_KEY',
    'deepseek/deepseek-chat': 'DEEPSEEK_API_KEY',
    'mistral/mistral-large': 'MISTRAL_API_KEY',
    'azure/gpt-4o': 'AZURE_API_KEY',
  };
  for (const [model, expected] of Object.entries(cases)) {
    assert.equal(apiKeyEnvFor(model), expected, model);
  }
});

test('apiKeyEnvFor is case insensitive on the provider', () => {
  assert.equal(apiKeyEnvFor('OpenAI/gpt-5.5'), 'OPENAI_API_KEY');
});

test('apiKeyEnvFor throws for an unknown provider and names the escape hatch', () => {
  assert.throws(() => apiKeyEnvFor('weirdprovider/model'), /api_key_env/);
});

test('apiKeyEnvFor throws when the model has no provider prefix', () => {
  assert.throws(() => apiKeyEnvFor('gpt-5.5'), /provider\/model/);
});

test('apiKeyEnvFor honours an explicit override for any provider', () => {
  assert.equal(apiKeyEnvFor('weirdprovider/model', 'CUSTOM_KEY'), 'CUSTOM_KEY');
  assert.equal(apiKeyEnvFor('openai/gpt-5.5', 'CUSTOM_KEY'), 'CUSTOM_KEY');
});

test('readInputs applies documented defaults', () => {
  const inputs = readInputs({});
  assert.equal(inputs.model, DEFAULTS.model);
  assert.equal(inputs.questionCount, 3);
  assert.equal(inputs.enabled, true);
  assert.equal(inputs.minChangedLines, 0);
  assert.equal(inputs.statusContext, 'quizme');
  assert.deepEqual(inputs.users, []);
  assert.ok(inputs.ignorePaths.length > 0, 'ignore_paths should have a default');
});

test('readInputs coerces and normalises', () => {
  const inputs = readInputs({
    INPUT_MODEL: 'openai/gpt-5.5',
    INPUT_USERS: 'Alice, bob\nCAROL',
    INPUT_QUESTION_COUNT: '5',
    INPUT_ENABLED: 'false',
    INPUT_MIN_CHANGED_LINES: '25',
    INPUT_IGNORE_PATHS: 'docs/**\n*.md',
    INPUT_STATUS_CONTEXT: 'understand-it',
  });
  assert.equal(inputs.model, 'openai/gpt-5.5');
  assert.deepEqual(inputs.users, ['alice', 'bob', 'carol']);
  assert.equal(inputs.questionCount, 5);
  assert.equal(inputs.enabled, false);
  assert.equal(inputs.minChangedLines, 25);
  assert.deepEqual(inputs.ignorePaths, ['docs/**', '*.md']);
  assert.equal(inputs.statusContext, 'understand-it');
});

test('readInputs treats blank strings as unset', () => {
  const inputs = readInputs({ INPUT_MODEL: '   ', INPUT_USERS: '  ', INPUT_QUESTION_COUNT: '' });
  assert.equal(inputs.model, DEFAULTS.model);
  assert.deepEqual(inputs.users, []);
  assert.equal(inputs.questionCount, 3);
});

test('readInputs clamps question_count into a sane range', () => {
  assert.equal(readInputs({ INPUT_QUESTION_COUNT: '0' }).questionCount, 1);
  assert.equal(readInputs({ INPUT_QUESTION_COUNT: '99' }).questionCount, 10);
  assert.equal(readInputs({ INPUT_QUESTION_COUNT: 'abc' }).questionCount, 3);
});

test('readInputs ignore_paths accepts an explicit "none" to disable filtering', () => {
  assert.deepEqual(readInputs({ INPUT_IGNORE_PATHS: 'none' }).ignorePaths, []);
});
