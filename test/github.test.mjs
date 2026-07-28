import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '../scripts/lib/github.mjs';

function res(body, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
    return handler(url, options, calls.length);
  };
  return { calls, fetchImpl };
}

const client = (fetchImpl) =>
  createClient({
    token: 'tok',
    repo: 'carrfane/app',
    baseUrl: 'https://api.github.com',
    fetchImpl,
    sleep: async () => {},
  });

test('constructor validates its arguments', () => {
  assert.throws(() => createClient({ repo: 'a/b' }), /token is required/);
  assert.throws(() => createClient({ token: 't', repo: 'nope' }), /owner\/name/);
});

/**
 * GitHub masks secrets in *logs*. It does not mask anything written through the
 * REST API, so a comment body is not covered by that safety net. Redacting at
 * the write boundary is the one place it cannot be forgotten.
 */
test('createComment redacts known secrets from the body', async () => {
  const { calls, fetchImpl } = recorder(() => res({ id: 1 }));
  const withSecret = createClient({
    token: 'tok',
    repo: 'carrfane/app',
    fetchImpl,
    sleep: async () => {},
    secrets: ['sk-live-abcdef1234567890'],
  });

  await withSecret.createComment(7, 'boom: sk-live-abcdef1234567890 was rejected');

  assert.equal(calls[0].body.body, 'boom: *** was rejected');
  assert.ok(!JSON.stringify(calls[0].body).includes('sk-live'), 'no fragment may survive');
});

test('updateComment redacts known secrets from the body', async () => {
  const { calls, fetchImpl } = recorder(() => res({ id: 1 }));
  const withSecret = createClient({
    token: 'tok',
    repo: 'carrfane/app',
    fetchImpl,
    sleep: async () => {},
    secrets: ['sk-live-abcdef1234567890'],
  });

  await withSecret.updateComment(9, 'key sk-live-abcdef1234567890 here');

  assert.equal(calls[0].body.body, 'key *** here');
});

test('setStatus descriptions are redacted too', async () => {
  // setStatus is the other public write. The scrubber is only "the single
  // boundary every write passes through" if it covers this one as well.
  const { calls, fetchImpl } = recorder(() => res({}));
  const withSecret = createClient({
    token: 'tok',
    repo: 'carrfane/app',
    fetchImpl,
    sleep: async () => {},
    secrets: ['sk-live-abcdef1234567890'],
  });

  await withSecret.setStatus({
    sha: 'deadbeef',
    state: 'success',
    context: 'quizme',
    description: 'failed: sk-live-abcdef1234567890',
  });

  assert.equal(calls[0].body.description, 'failed: ***');
});

test('redaction ignores blank and implausibly short secrets', async () => {
  // An unset env var must not turn every comment into a wall of asterisks.
  const { calls, fetchImpl } = recorder(() => res({ id: 1 }));
  const withSecret = createClient({
    token: 'tok',
    repo: 'carrfane/app',
    fetchImpl,
    sleep: async () => {},
    secrets: ['', undefined, 'a'],
  });

  await withSecret.createComment(7, 'a normal comment about a variable');
  assert.equal(calls[0].body.body, 'a normal comment about a variable');
});

test('setStatus posts to the head sha with auth and the right body', async () => {
  const { calls, fetchImpl } = recorder(() => res({}));
  await client(fetchImpl).setStatus({
    sha: 'deadbeef',
    state: 'pending',
    context: 'quizme',
    description: 'Answer the quiz',
    targetUrl: 'https://example.test/pr',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/carrfane/app/statuses/deadbeef');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(calls[0].body, {
    state: 'pending',
    context: 'quizme',
    description: 'Answer the quiz',
    target_url: 'https://example.test/pr',
  });
});

test('setStatus clamps descriptions to GitHub\'s 140 character limit', async () => {
  const { calls, fetchImpl } = recorder(() => res({}));
  await client(fetchImpl).setStatus({ sha: 'x', state: 'success', context: 'quizme', description: 'y'.repeat(300) });
  assert.equal(calls[0].body.description.length, 140);
  assert.ok(calls[0].body.description.endsWith('...'));
});

test('listChangedFiles follows Link rel=next pagination', async () => {
  const { calls, fetchImpl } = recorder((url) => {
    if (url.includes('page=2')) return res([{ filename: 'b' }]);
    return res([{ filename: 'a' }], {
      headers: { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"' },
    });
  });

  const files = await client(fetchImpl).listChangedFiles(3);
  assert.deepEqual(files, [{ filename: 'a' }, { filename: 'b' }]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('per_page=100'));
});

test('pagination stops when there is no next link', async () => {
  const { calls, fetchImpl } = recorder(() => res([{ filename: 'a' }]));
  await client(fetchImpl).listComments(3);
  assert.equal(calls.length, 1);
});

test('a 500 is retried up to three attempts then throws', async () => {
  const { calls, fetchImpl } = recorder(() => res('boom', { status: 500 }));
  await assert.rejects(() => client(fetchImpl).getPullRequest(1), /failed with 500/);
  assert.equal(calls.length, 3);
});

test('a transient 500 succeeds on retry', async () => {
  const { calls, fetchImpl } = recorder((_url, _opts, n) =>
    n === 1 ? res('boom', { status: 502 }) : res({ number: 1 }),
  );
  assert.deepEqual(await client(fetchImpl).getPullRequest(1), { number: 1 });
  assert.equal(calls.length, 2);
});

test('a rate-limited 403 is retried', async () => {
  const { calls, fetchImpl } = recorder((_url, _opts, n) =>
    n === 1 ? res('limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) : res({ number: 1 }),
  );
  await client(fetchImpl).getPullRequest(1);
  assert.equal(calls.length, 2);
});

test('a permissions 403 is not retried', async () => {
  const { calls, fetchImpl } = recorder(() =>
    res('Resource not accessible by integration', { status: 403, headers: { 'x-ratelimit-remaining': '4999' } }),
  );
  await assert.rejects(
    () => client(fetchImpl).setStatus({ sha: 'x', state: 'success', context: 'quizme' }),
    /not accessible by integration/,
  );
  assert.equal(calls.length, 1, 'a missing statuses:write scope must fail fast and loudly');
});

test('a 404 is not retried and surfaces status plus body', async () => {
  const { calls, fetchImpl } = recorder(() => res('Not Found', { status: 404 }));
  await assert.rejects(() => client(fetchImpl).getPullRequest(1), /failed with 404.*Not Found/s);
  assert.equal(calls.length, 1);
});

test('comment helpers hit the documented endpoints', async () => {
  const { calls, fetchImpl } = recorder(() => res({ id: 1 }));
  const c = client(fetchImpl);
  await c.createComment(12, 'hello');
  await c.updateComment(77, 'edited');

  assert.equal(calls[0].url, 'https://api.github.com/repos/carrfane/app/issues/12/comments');
  assert.deepEqual(calls[0].body, { body: 'hello' });
  assert.equal(calls[1].url, 'https://api.github.com/repos/carrfane/app/issues/comments/77');
  assert.equal(calls[1].method, 'PATCH');
});

test('baseUrl is honoured so GHES and local stubs work', async () => {
  const { calls, fetchImpl } = recorder(() => res({}));
  const ghes = createClient({
    token: 't',
    repo: 'o/r',
    baseUrl: 'https://ghe.internal/api/v3/',
    fetchImpl,
    sleep: async () => {},
  });
  await ghes.setStatus({ sha: 'x', state: 'success', context: 'quizme' });
  assert.equal(calls[0].url, 'https://ghe.internal/api/v3/repos/o/r/statuses/x');
});
