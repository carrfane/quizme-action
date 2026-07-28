/**
 * Drives the opencode CLI and turns its output into a validated quiz.
 *
 * The pure parts (config building, extraction, validation) are exported
 * separately from the process spawn so they can be tested without a CLI.
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Every tool opencode ships, all switched off.
 *
 * The prompt carries the whole diff, so the model needs no tools at all. This
 * is not just belt-and-braces: a tool call is what broke the first live run.
 * The model emitted one, opencode ended the session without executing it and
 * exited 0 having produced nothing. Disabling the tools means they are never
 * offered in the first place.
 *
 * The wildcard is a defensive catch-all in case this version of opencode gains
 * a tool name not listed here; unknown keys are simply ignored otherwise.
 */
const DISABLED_TOOLS = [
  '*',
  'bash',
  'edit',
  'write',
  'patch',
  'multiedit',
  'read',
  'grep',
  'glob',
  'list',
  'webfetch',
  'task',
  'todowrite',
  'todoread',
  'skill',
];

export function buildConfig({ model, smallModel }) {
  const tools = {};
  for (const tool of DISABLED_TOOLS) tools[tool] = false;

  return {
    $schema: 'https://opencode.ai/config.json',
    model,
    // Pinned to the primary model unless overridden. Only one provider's key is
    // ever exported, so letting opencode pick a cross-provider default would
    // fail with no credentials.
    small_model: smallModel || model,
    tools,
    // Redundant given `tools`, but cheap: if a tool were somehow still offered,
    // it is denied rather than executed.
    permission: {
      edit: 'deny',
      webfetch: 'deny',
      bash: { '*': 'deny' },
    },
  };
}

export async function writeConfig({ dir, model, smallModel }) {
  const file = path.join(dir, 'quizme-opencode.json');
  await writeFile(file, `${JSON.stringify(buildConfig({ model, smallModel }), null, 2)}\n`, 'utf8');
  return file;
}

export function renderPrompt(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

/**
 * `--format json` emits one JSON event per line. The quiz is in the last
 * assistant text we can find; everything else is tool noise.
 */
export function extractAssistantText(stdout) {
  const texts = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      // A non-JSON line means we are looking at `--format default` output.
      texts.push(trimmed);
      continue;
    }

    try {
      collectText(JSON.parse(trimmed), texts);
    } catch {
      texts.push(trimmed);
    }
  }

  return texts;
}

function collectText(node, out, depth = 0) {
  if (depth > 8 || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out, depth + 1);
    return;
  }

  if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
  else if (typeof node.text === 'string') out.push(node.text);

  for (const key of ['part', 'parts', 'message', 'properties', 'info', 'content', 'data']) {
    if (node[key] !== undefined) collectText(node[key], out, depth + 1);
  }
}

/**
 * opencode reports failures as `{"type":"error"}` events on **stdout**, leaving
 * stderr empty. Without this, a bad API key produced the useless message
 * "opencode exited with code 1. stderr: <empty>".
 */
export function extractError(stdout) {
  const messages = [];

  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type !== 'error') continue;

    const error = event.error ?? {};
    const detail = error.data?.message ?? error.message ?? '';
    const name = error.name ?? 'Error';
    const ref = error.data?.ref ? ` (ref ${error.data.ref})` : '';
    messages.push(detail ? `${name}: ${detail}${ref}` : `${name}${ref}`);
  }

  return messages.length > 0 ? messages.join('; ') : null;
}

/**
 * Pull the quiz object out of whatever the model produced: raw JSON, a fenced
 * block, or JSON buried in prose.
 */
export function extractQuiz(stdout) {
  const candidates = extractAssistantText(stdout);

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const parsed = firstJsonObject(candidates[i]);
    if (parsed && Array.isArray(parsed.questions)) return parsed;
  }

  const whole = firstJsonObject(stdout);
  if (whole && Array.isArray(whole.questions)) return whole;

  return null;
}

function firstJsonObject(text) {
  if (typeof text !== 'string') return null;

  const unfenced = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1');

  for (const source of [unfenced, text]) {
    const start = source.indexOf('{');
    if (start === -1) continue;

    // Walk outward from the first brace to the matching close brace.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}

const LETTERS = ['A', 'B', 'C', 'D'];

export function validateQuiz(quiz, expectedCount) {
  if (!quiz || typeof quiz !== 'object' || Array.isArray(quiz)) {
    throw new Error('Model output is not a JSON object.');
  }
  if (!Array.isArray(quiz.questions)) {
    throw new Error('Model output has no "questions" array.');
  }
  if (quiz.questions.length !== expectedCount) {
    throw new Error(
      `Model returned ${quiz.questions.length} questions, expected ${expectedCount}.`,
    );
  }

  quiz.questions.forEach((question, i) => {
    const at = `question ${i + 1}`;
    if (!nonEmpty(question?.question)) throw new Error(`${at} has an empty "question".`);
    if (!question.options || typeof question.options !== 'object') {
      throw new Error(`${at} has no "options" object.`);
    }
    for (const letter of LETTERS) {
      if (!nonEmpty(question.options[letter])) {
        throw new Error(`${at} is missing option ${letter}.`);
      }
    }
    if (Object.keys(question.options).length !== LETTERS.length) {
      throw new Error(`${at} must have exactly options A-D.`);
    }
    if (!LETTERS.includes(question.answer)) {
      throw new Error(`${at} has answer ${JSON.stringify(question.answer)}, expected one of A-D.`);
    }
    if (!nonEmpty(question.explanation)) throw new Error(`${at} has an empty "explanation".`);
  });

  const unique = new Set(quiz.questions.map((q) => q.question.trim().toLowerCase()));
  if (unique.size !== quiz.questions.length) {
    throw new Error('Model returned duplicate questions.');
  }

  return {
    questions: quiz.questions.map((question) => ({
      question: String(question.question).trim(),
      options: Object.fromEntries(
        LETTERS.map((letter) => [letter, String(question.options[letter]).trim()]),
      ),
      answer: question.answer,
      explanation: String(question.explanation).trim(),
    })),
  };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Best available explanation for a failed run, in order of usefulness:
 * a structured error event, then stderr, then a tail of raw stdout.
 */
function describeFailure(stdout, stderr) {
  const structured = extractError(stdout);
  if (structured) return structured;

  const trimmedStderr = String(stderr ?? '').trim();
  if (trimmedStderr) return `stderr: ${trimmedStderr.slice(-1500)}`;

  const trimmedStdout = String(stdout ?? '').trim();
  if (trimmedStdout) return `stdout: ${trimmedStdout.slice(-1500)}`;

  return 'No output on stdout or stderr.';
}

/**
 * Spawn the CLI. Rejects with stderr included so the failure comment is useful.
 */
export function runOpencode({
  prompt,
  model,
  cwd,
  configFile,
  env = process.env,
  // The prompt is self-contained, so there is no exploration loop to wait for.
  timeoutMs = 5 * 60 * 1000,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      'opencode',
      ['run', '--format', 'json', '--model', model, '--agent', 'plan', prompt],
      {
        cwd,
        env: { ...env, OPENCODE_CONFIG: configFile, CI: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`opencode timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) reject(new Error(`Could not start opencode: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`opencode exited with code ${code}. ${describeFailure(stdout, stderr)}`));
    });
  });
}
