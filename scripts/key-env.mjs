#!/usr/bin/env node
/**
 * Prints the environment variable name the configured provider expects its API
 * key in. Kept as its own tiny script so action.yml does not have to embed
 * JavaScript inside a shell string.
 */

import { apiKeyEnvFor } from './lib/config.mjs';

try {
  process.stdout.write(apiKeyEnvFor(process.env.INPUT_MODEL, process.env.INPUT_API_KEY_ENV));
} catch (error) {
  process.stderr.write(`quizme: ${error.message}\n`);
  process.exit(1);
}
