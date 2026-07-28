#!/usr/bin/env node
/**
 * Entry point for both action phases.
 *
 *   --phase=resolve  decide what to do, publish step outputs, stash the decision
 *   --phase=run      execute the stashed decision
 *
 * Splitting it this way lets action.yml conditionally check out the PR and
 * install opencode only when a quiz is actually going to be generated.
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { readInputs, apiKeyEnvFor, assertModelsShareProvider } from './lib/config.mjs';
import { createClient } from './lib/github.mjs';
import { routeEvent } from './lib/router.mjs';
import { runMode } from './lib/modes.mjs';

const DECISION_FILE = 'quizme-decision.json';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const phase = (argv.find((arg) => arg.startsWith('--phase=')) ?? '--phase=resolve').split('=')[1];
  const inputs = readInputs(env);
  const decisionPath = path.join(env.RUNNER_TEMP || env.TMPDIR || '.', DECISION_FILE);

  if (phase === 'resolve') {
    return resolvePhase({ env, inputs, decisionPath });
  }
  if (phase === 'run') {
    return runPhase({ env, inputs, decisionPath });
  }
  throw new Error(`Unknown phase "${phase}". Expected resolve or run.`);
}

async function resolvePhase({ env, inputs, decisionPath }) {
  // Validate the credential contract early: a typo here should fail on the
  // first event, not silently at the model call.
  apiKeyEnvFor(inputs.model, inputs.apiKeyEnv);
  assertModelsShareProvider(inputs);

  const payload = JSON.parse(await readFile(requireEnv(env, 'GITHUB_EVENT_PATH'), 'utf8'));
  const client = makeClient(env);

  const decision = await routeEvent({
    payload,
    eventName: requireEnv(env, 'GITHUB_EVENT_NAME'),
    inputs,
    lookups: {
      listChangedFiles: (number) => client.listChangedFiles(number),
      listComments: (number) => client.listComments(number),
      getPullRequest: (number) => client.getPullRequest(number),
    },
  });

  await writeFile(decisionPath, JSON.stringify(decision), 'utf8');
  await setOutputs(env, {
    mode: decision.mode,
    reason: decision.reason,
    head_sha: decision.headSha,
    pr_number: String(decision.prNumber || ''),
  });

  console.log(`quizme: mode=${decision.mode} (${decision.reason})`);
  return decision;
}

async function runPhase({ env, inputs, decisionPath }) {
  const decision = JSON.parse(await readFile(decisionPath, 'utf8'));
  if (decision.mode === 'none') {
    console.log(`quizme: nothing to do (${decision.reason})`);
    return { action: 'none' };
  }

  // Hand the client the live API key so it can scrub it from any comment body.
  // Belt to the braces in describeFailure: masking does not cover the REST API.
  const keyEnv = apiKeyEnvFor(inputs.model, inputs.apiKeyEnv);

  return runMode({
    decision,
    inputs,
    client: makeClient(env, { secrets: [env[keyEnv], env.GITHUB_TOKEN] }),
    deps: {
      workdir: env.QUIZME_WORKDIR || process.cwd(),
      tmpdir: env.RUNNER_TEMP,
    },
  });
}

function makeClient(env, { secrets = [] } = {}) {
  return createClient({
    token: requireEnv(env, 'GITHUB_TOKEN'),
    repo: requireEnv(env, 'GITHUB_REPOSITORY'),
    baseUrl: env.GITHUB_API_URL || 'https://api.github.com',
    secrets,
  });
}

async function setOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, ' ')}`)
    .join('\n');
  await appendFile(env.GITHUB_OUTPUT, `${lines}\n`, 'utf8');
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

// pathToFileURL rather than string concatenation: a workspace path containing a
// space would otherwise never match, and the action would silently do nothing.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`quizme: ${error.message}`);
    process.exit(1);
  });
}
