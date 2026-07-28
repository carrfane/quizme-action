/**
 * Input parsing and provider credential mapping.
 *
 * GitHub composite actions expose inputs as `INPUT_<UPPERCASED_NAME>` env vars.
 * Everything here is pure: pass an env-like object in, get a normalised config out.
 */

export const DEFAULTS = {
  model: 'anthropic/claude-sonnet-4-5',
  questionCount: 3,
  enabled: true,
  minChangedLines: 0,
  opencodeVersion: '1.18.4',
  statusContext: 'quizme',
  ignorePaths: [
    'docs/**',
    '**/*.md',
    '**/*.mdx',
    '**/README',
    '**/LICENSE',
    '**/CHANGELOG',
    '.github/**/*.md',
  ],
};

const PROVIDER_ENV = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  azure: 'AZURE_API_KEY',
};

const QUESTION_COUNT_MIN = 1;
const QUESTION_COUNT_MAX = 10;

/**
 * Resolve the environment variable opencode expects the API key in.
 * @param {string} model `provider/model` identifier.
 * @param {string} [override] Explicit env var name; wins over the mapping.
 */
export function apiKeyEnvFor(model, override) {
  const explicit = blankToUndefined(override);
  if (explicit) return explicit;

  const raw = blankToUndefined(model);
  if (!raw || !raw.includes('/')) {
    throw new Error(
      `model must be in "provider/model" form, got ${JSON.stringify(model)}.`,
    );
  }

  const provider = raw.split('/', 1)[0].toLowerCase();
  const env = PROVIDER_ENV[provider];
  if (!env) {
    throw new Error(
      `Unknown provider "${provider}". Set the api_key_env input to the ` +
        `environment variable name this provider expects. Known providers: ` +
        `${Object.keys(PROVIDER_ENV).join(', ')}.`,
    );
  }
  return env;
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function readInputs(env = process.env) {
  return {
    model: str(env.INPUT_MODEL, DEFAULTS.model),
    users: list(env.INPUT_USERS).map((u) => u.replace(/^@/, '').toLowerCase()),
    questionCount: clampedInt(env.INPUT_QUESTION_COUNT, DEFAULTS.questionCount),
    enabled: bool(env.INPUT_ENABLED, DEFAULTS.enabled),
    ignorePaths: ignorePaths(env.INPUT_IGNORE_PATHS),
    minChangedLines: int(env.INPUT_MIN_CHANGED_LINES, DEFAULTS.minChangedLines),
    opencodeVersion: str(env.INPUT_OPENCODE_VERSION, DEFAULTS.opencodeVersion),
    apiKeyEnv: blankToUndefined(env.INPUT_API_KEY_ENV) ?? '',
    statusContext: str(env.INPUT_STATUS_CONTEXT, DEFAULTS.statusContext),
  };
}

function blankToUndefined(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function str(value, fallback) {
  return blankToUndefined(value) ?? fallback;
}

function list(value) {
  const raw = blankToUndefined(value);
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function ignorePaths(value) {
  const raw = blankToUndefined(value);
  if (raw === undefined) return [...DEFAULTS.ignorePaths];
  if (raw.toLowerCase() === 'none') return [];
  return list(raw);
}

function bool(value, fallback) {
  const raw = blankToUndefined(value);
  if (raw === undefined) return fallback;
  return !/^(false|0|no|off)$/i.test(raw);
}

function int(value, fallback) {
  const parsed = Number.parseInt(blankToUndefined(value) ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clampedInt(value, fallback) {
  const parsed = int(value, fallback);
  return Math.min(QUESTION_COUNT_MAX, Math.max(QUESTION_COUNT_MIN, parsed));
}
