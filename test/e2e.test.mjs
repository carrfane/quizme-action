/**
 * End-to-end integration, without Docker or a network.
 *
 * This is deliberately what we built instead of adopting `act`: it exercises
 * main.mjs, the real fetch client against a real HTTP server, real step-output
 * file writing, and a real `opencode` subprocess spawn. `act` could not cover
 * the API interaction at all (it ships no GitHub API) and would not populate
 * `github.job_workflow_sha`, so it would fail on the very wiring we care about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main } from '../scripts/main.mjs';
import {
  renderQuiz,
  parseQuizKey,
  hasMarker,
  MARKERS,
  SUBMIT_UNCHECKED,
  SUBMIT_CHECKED,
} from '../scripts/lib/comment.mjs';

// Option text is unique per question on purpose: identical text across questions
// makes a whole-body String.replace tick the wrong box, which is exactly the
// mistake this fixture used to hide.
const QUIZ = {
  questions: [
    {
      question: 'Why null?',
      options: { A: 'a1', B: 'b1', C: 'c1', D: 'd1' },
      answer: 'B',
      explanation: 'e1',
    },
    {
      question: 'What breaks?',
      options: { A: 'a2', B: 'b2', C: 'c2', D: 'd2' },
      answer: 'C',
      explanation: 'e2',
    },
  ],
};

const PR = {
  number: 12,
  draft: false,
  title: 'Add a thing',
  html_url: 'https://github.test/carrfane/app/pull/12',
  user: { login: 'carrfane', type: 'User' },
  head: { sha: 'aaaa1111', repo: { full_name: 'carrfane/app' } },
  base: { sha: 'bbbb2222', ref: 'main', repo: { full_name: 'carrfane/app' } },
};

/** A tiny stand-in for the GitHub REST endpoints we use. */
async function startFakeGitHub({ comments = [], files = null, pr = PR } = {}) {
  const state = {
    comments: [...comments],
    statuses: [],
    requests: [],
    nextId: 900,
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const url = new URL(req.url, 'http://localhost');
      state.requests.push({ method: req.method, path: url.pathname, body });

      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      const pathname = url.pathname;

      if (req.method === 'GET' && /\/pulls\/\d+$/.test(pathname)) return send(200, pr);
      if (req.method === 'GET' && /\/pulls\/\d+\/files$/.test(pathname)) {
        return send(200, files ?? [{ filename: 'src/a.js', additions: 40, deletions: 3 }]);
      }
      if (req.method === 'GET' && /\/issues\/\d+\/comments$/.test(pathname)) {
        return send(200, state.comments);
      }
      if (req.method === 'GET' && /\/issues\/comments\/\d+$/.test(pathname)) {
        const id = Number(pathname.split('/').pop());
        const existing = state.comments.find((c) => c.id === id);
        return existing ? send(200, existing) : send(404, { message: 'no such comment' });
      }
      if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(pathname)) {
        const comment = {
          id: (state.nextId += 1),
          body: body.body,
          html_url: `https://github.test/c/${state.nextId}`,
        };
        state.comments.push(comment);
        return send(201, comment);
      }
      if (req.method === 'PATCH' && /\/issues\/comments\/\d+$/.test(pathname)) {
        const id = Number(pathname.split('/').pop());
        const existing = state.comments.find((c) => c.id === id);
        if (existing) existing.body = body.body;
        return send(200, existing ?? { id, body: body.body });
      }
      if (req.method === 'POST' && /\/statuses\/\w+$/.test(pathname)) {
        state.statuses.push({ sha: pathname.split('/').pop(), ...body });
        return send(201, body);
      }

      return send(404, { message: `unhandled ${req.method} ${pathname}` });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    state,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Put a fake `opencode` on PATH so the real spawn path is exercised. */
async function withFakeOpencode(stdoutJson, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'quizme-bin-'));
  const script = `#!/bin/sh\ncat <<'EOF'\n${stdoutJson}\nEOF\n`;
  await writeFile(path.join(dir, 'opencode'), script, 'utf8');
  await chmod(path.join(dir, 'opencode'), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

async function scenario({ eventName, payload, comments, files, inputs = {} }) {
  const github = await startFakeGitHub({ comments, files });
  const work = await mkdtemp(path.join(tmpdir(), 'quizme-run-'));
  const eventPath = path.join(work, 'event.json');
  const outputPath = path.join(work, 'output.txt');
  const prDir = path.join(work, 'quizme-pr');

  await mkdir(prDir, { recursive: true });
  await writeFile(eventPath, JSON.stringify(payload), 'utf8');
  await writeFile(outputPath, '', 'utf8');

  const env = {
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'carrfane/app',
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_API_URL: github.baseUrl,
    RUNNER_TEMP: work,
    QUIZME_WORKDIR: prDir,
    INPUT_MODEL: 'anthropic/claude-sonnet-4-5',
    INPUT_IGNORE_PATHS: 'none',
    INPUT_QUESTION_COUNT: '2',
    ...inputs,
  };

  return {
    env,
    github,
    outputs: async () => parseOutputs(await readFile(outputPath, 'utf8')),
    cleanup: () => github.close(),
  };
}

function parseOutputs(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

const prPayload = (action, over = {}) => ({ action, pull_request: { ...PR, ...over } });

const commentPayload = (body, login = 'carrfane', id = 77) => ({
  action: 'edited',
  issue: { number: 12, pull_request: { url: 'x' } },
  comment: { id, body, user: { login, type: 'User' } },
  sender: { login, type: 'User' },
});

// ------------------------------------------------------------------------

test('e2e: a new PR gets a quiz comment and a pending status', async (t) => {
  const s = await scenario({ eventName: 'pull_request', payload: prPayload('opened') });
  t.after(s.cleanup);

  const decision = await main(['--phase=resolve'], s.env);
  assert.equal(decision.mode, 'generate');

  const outputs = await s.outputs();
  assert.equal(outputs.mode, 'generate');
  assert.equal(outputs.head_sha, 'aaaa1111');
  assert.equal(outputs.pr_number, '12');

  await withFakeOpencode(JSON.stringify({ type: 'text', text: JSON.stringify(QUIZ) }), () =>
    main(['--phase=run'], s.env),
  );

  assert.equal(s.github.state.comments.length, 1);
  const body = s.github.state.comments[0].body;
  assert.ok(hasMarker(body, MARKERS.quiz));
  assert.deepEqual(parseQuizKey(body).quiz, QUIZ);

  assert.equal(s.github.state.statuses.length, 1);
  assert.equal(s.github.state.statuses[0].state, 'pending');
  assert.equal(s.github.state.statuses[0].sha, 'aaaa1111');
  assert.equal(s.github.state.statuses[0].context, 'quizme');
});

test('e2e: the full answer cycle unblocks the PR and reveals the key', async (t) => {
  const quizBody = renderQuiz({ sha: 'aaaa1111', quiz: QUIZ });
  const answered = quizBody
    .replace('- [ ] B. b1', '- [x] B. b1')
    .replace('- [ ] C. c2', '- [x] C. c2')
    .replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);

  // Ticking a checkbox IS the edit, so the stored comment already holds the
  // answered body by the time the event is delivered.
  const s = await scenario({
    eventName: 'issue_comment',
    payload: commentPayload(answered),
    comments: [{ id: 77, body: answered }],
  });
  t.after(s.cleanup);

  const decision = await main(['--phase=resolve'], s.env);
  assert.equal(decision.mode, 'grade');

  await main(['--phase=run'], s.env);

  const graded = s.github.state.comments.find((c) => c.id === 77).body;
  assert.ok(hasMarker(graded, MARKERS.graded));
  assert.ok(graded.includes('e1') && graded.includes('e2'), 'explanations are revealed');
  assert.ok(!graded.includes('quizme:key'), 'the key is gone once revealed');

  assert.equal(s.github.state.statuses.at(-1).state, 'success');
  assert.match(s.github.state.statuses.at(-1).description, /2\/2/);
});

test('e2e: a duplicate webhook delivery cannot clobber a good score', async (t) => {
  // Reproduces a failure seen on real GitHub: several `edited` deliveries for
  // one submission, where a later run re-graded and overwrote 2/3 with 1/3.
  const quizBody = renderQuiz({ sha: 'aaaa1111', quiz: QUIZ });
  const answered = quizBody
    .replace('- [ ] B. b1', '- [x] B. b1')
    .replace('- [ ] C. c2', '- [x] C. c2')
    .replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);

  const s = await scenario({
    eventName: 'issue_comment',
    payload: commentPayload(answered),
    comments: [{ id: 77, body: answered }],
  });
  t.after(s.cleanup);

  await main(['--phase=resolve'], s.env);
  await main(['--phase=run'], s.env);

  const firstResult = s.github.state.comments.find((c) => c.id === 77).body;
  assert.ok(firstResult.includes('2 / 2'), 'graded correctly the first time');
  const statusCount = s.github.state.statuses.length;

  // A second, garbled delivery for the same comment.
  const stale = quizBody
    .replace('- [ ] A. a1', '- [x] A. a1')
    .replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);
  await writeFile(s.env.GITHUB_EVENT_PATH, JSON.stringify(commentPayload(stale)), 'utf8');

  await main(['--phase=resolve'], s.env);
  await main(['--phase=run'], s.env);

  const afterDuplicate = s.github.state.comments.find((c) => c.id === 77).body;
  assert.equal(afterDuplicate, firstResult, 'the graded comment is byte-identical');
  assert.equal(s.github.state.statuses.length, statusCount, 'no extra status write');
});

test('e2e: an incomplete submission leaves the status untouched', async (t) => {
  const quizBody = renderQuiz({ sha: 'aaaa1111', quiz: QUIZ });
  const partial = quizBody
    .replace('- [ ] B. b1', '- [x] B. b1')
    .replace(SUBMIT_UNCHECKED, SUBMIT_CHECKED);

  const s = await scenario({
    eventName: 'issue_comment',
    payload: commentPayload(partial),
    comments: [{ id: 77, body: partial }],
  });
  t.after(s.cleanup);

  await main(['--phase=resolve'], s.env);
  await main(['--phase=run'], s.env);

  assert.equal(s.github.state.statuses.length, 0, 'merge stays blocked');
  const nudged = s.github.state.comments.find((c) => c.id === 77).body;
  assert.ok(nudged.includes('question 2'));
  assert.ok(!nudged.includes(SUBMIT_CHECKED), 'submit is unticked so our edit cannot loop');
});

test('e2e: /quizme skip unblocks and retires the quiz', async (t) => {
  const s = await scenario({
    eventName: 'issue_comment',
    payload: { ...commentPayload('/quizme skip'), action: 'created' },
    comments: [{ id: 77, body: renderQuiz({ sha: 'aaaa1111', quiz: QUIZ }) }],
  });
  t.after(s.cleanup);

  const decision = await main(['--phase=resolve'], s.env);
  assert.equal(decision.mode, 'bypass');

  await main(['--phase=run'], s.env);

  assert.equal(s.github.state.statuses.at(-1).state, 'success');
  assert.match(s.github.state.statuses.at(-1).description, /Bypassed by @carrfane/);
  assert.ok(hasMarker(s.github.state.comments.find((c) => c.id === 77).body, MARKERS.notice));
});

test('e2e: a docs-only PR is skipped and unblocked without a model call', async (t) => {
  const s = await scenario({
    eventName: 'pull_request',
    payload: prPayload('opened'),
    files: [{ filename: 'README.md', additions: 5, deletions: 1 }],
    inputs: { INPUT_IGNORE_PATHS: '**/*.md' },
  });
  t.after(s.cleanup);

  const decision = await main(['--phase=resolve'], s.env);
  assert.equal(decision.mode, 'skip');

  // No fake opencode on PATH: if this tried to call a model it would throw.
  await main(['--phase=run'], s.env);

  assert.equal(s.github.state.statuses.at(-1).state, 'success');
  assert.match(s.github.state.statuses.at(-1).description, /Not applicable/);
  assert.equal(s.github.state.comments.length, 0, 'no PR noise');
});

test('e2e: a push after answering carries the pass forward', async (t) => {
  const graded = '<!-- quizme:graded v=1 sha=oldsha99 score=2/2 -->\n## Quiz results — 2 / 2';
  const s = await scenario({
    eventName: 'pull_request',
    payload: prPayload('synchronize', { head: { sha: 'newsha55', repo: { full_name: 'carrfane/app' } } }),
    comments: [{ id: 77, body: graded }],
  });
  t.after(s.cleanup);

  const decision = await main(['--phase=resolve'], s.env);
  assert.equal(decision.mode, 'carry');

  await main(['--phase=run'], s.env);

  assert.equal(s.github.state.statuses.at(-1).sha, 'newsha55');
  assert.equal(s.github.state.statuses.at(-1).state, 'success');
  assert.match(s.github.state.statuses.at(-1).description, /Already answered at oldsha9/);
});

test('e2e: an unrelated comment does nothing at all', async (t) => {
  const s = await scenario({
    eventName: 'issue_comment',
    payload: { ...commentPayload('looks good to me'), action: 'created' },
  });
  t.after(s.cleanup);

  const decision = await main(['--phase=resolve'], s.env);
  assert.equal(decision.mode, 'none');

  await main(['--phase=run'], s.env);
  assert.equal(s.github.state.statuses.length, 0);
  assert.equal(s.github.state.comments.length, 0);
});

test('e2e: a missing opencode binary fails open with an explanation', async (t) => {
  const s = await scenario({ eventName: 'pull_request', payload: prPayload('opened') });
  t.after(s.cleanup);

  await main(['--phase=resolve'], s.env);

  const originalPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    await main(['--phase=run'], s.env);
  } finally {
    process.env.PATH = originalPath;
  }

  assert.equal(s.github.state.statuses.at(-1).state, 'success', 'a broken runner must not wedge the PR');
  assert.match(s.github.state.statuses.at(-1).description, /generation failed/i);
  assert.match(s.github.state.comments[0].body, /Could not start opencode|opencode/);
});

test('e2e: a bad model identifier fails fast on the first event', async (t) => {
  const s = await scenario({
    eventName: 'pull_request',
    payload: prPayload('opened'),
    inputs: { INPUT_MODEL: 'gpt-5.5' },
  });
  t.after(s.cleanup);

  await assert.rejects(() => main(['--phase=resolve'], s.env), /provider\/model/);
});

test('e2e: a cross-provider small_model is rejected on the first event', async (t) => {
  const s = await scenario({
    eventName: 'pull_request',
    payload: prPayload('opened'),
    inputs: { INPUT_MODEL: 'openai/gpt-5.5', INPUT_SMALL_MODEL: 'anthropic/claude-haiku-4' },
  });
  t.after(s.cleanup);

  await assert.rejects(() => main(['--phase=resolve'], s.env), /same provider/);
  assert.equal(s.github.state.statuses.length, 0, 'nothing is written when the config is invalid');
});

test('e2e: a same-provider small_model reaches the opencode config', async (t) => {
  const s = await scenario({
    eventName: 'pull_request',
    payload: prPayload('opened'),
    inputs: { INPUT_MODEL: 'openai/gpt-5.5', INPUT_SMALL_MODEL: 'openai/gpt-5.4-mini' },
  });
  t.after(s.cleanup);

  await main(['--phase=resolve'], s.env);
  await withFakeOpencode(JSON.stringify({ type: 'text', text: JSON.stringify(QUIZ) }), () =>
    main(['--phase=run'], s.env),
  );

  const config = JSON.parse(
    await readFile(path.join(s.env.RUNNER_TEMP, 'quizme-opencode.json'), 'utf8'),
  );
  assert.equal(config.model, 'openai/gpt-5.5');
  assert.equal(config.small_model, 'openai/gpt-5.4-mini');
  assert.equal(config.permission.edit, 'deny', 'the sandbox survives the extra config');
  assert.equal(s.github.state.statuses[0].state, 'pending');
});

test('e2e: small_model defaults to the primary model in the written config', async (t) => {
  const s = await scenario({ eventName: 'pull_request', payload: prPayload('opened') });
  t.after(s.cleanup);

  await main(['--phase=resolve'], s.env);
  await withFakeOpencode(JSON.stringify({ type: 'text', text: JSON.stringify(QUIZ) }), () =>
    main(['--phase=run'], s.env),
  );

  const config = JSON.parse(
    await readFile(path.join(s.env.RUNNER_TEMP, 'quizme-opencode.json'), 'utf8'),
  );
  assert.equal(config.small_model, config.model);
});

test('e2e: an unknown provider tells you about api_key_env', async (t) => {
  const s = await scenario({
    eventName: 'pull_request',
    payload: prPayload('opened'),
    inputs: { INPUT_MODEL: 'acme/model-1' },
  });
  t.after(s.cleanup);

  await assert.rejects(() => main(['--phase=resolve'], s.env), /api_key_env/);
});

test('e2e: generate reuses its own comment instead of stacking duplicates', async (t) => {
  const s = await scenario({
    eventName: 'issue_comment',
    payload: { ...commentPayload('/quizme'), action: 'created' },
    comments: [{ id: 77, body: renderQuiz({ sha: 'old', quiz: QUIZ }) }],
  });
  t.after(s.cleanup);

  await main(['--phase=resolve'], s.env);
  await withFakeOpencode(JSON.stringify({ type: 'text', text: JSON.stringify(QUIZ) }), () =>
    main(['--phase=run'], s.env),
  );

  assert.equal(s.github.state.comments.length, 1, 'still one comment');
  assert.equal(parseQuizKey(s.github.state.comments[0].body).sha, 'aaaa1111', 'refreshed to the new head');
  const posts = s.github.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'));
  assert.equal(posts.length, 0, 'updated in place, never created');
});
