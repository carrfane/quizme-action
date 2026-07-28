/**
 * Minimal GitHub REST client over built-in fetch. No dependencies.
 *
 * `fetchImpl` and `sleep` are injectable so tests run offline and instantly.
 * `baseUrl` defaults to GITHUB_API_URL, which makes this work on GHES and lets
 * the local dev harness point at a stub server.
 */

const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export function createClient({
  token,
  repo,
  baseUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
} = {}) {
  if (!token) throw new Error('A GitHub token is required.');
  if (!repo || !repo.includes('/')) {
    throw new Error(`repo must be "owner/name", got ${JSON.stringify(repo)}.`);
  }

  const root = `${baseUrl.replace(/\/$/, '')}/repos/${repo}`;

  async function request(method, url, body) {
    const absolute = url.startsWith('http') ? url : `${root}${url}`;

    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(absolute, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'quizme-action',
          'x-github-api-version': '2022-11-28',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (response.ok) return response;

      if (attempt < MAX_ATTEMPTS && shouldRetry(response)) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }

      const detail = await safeText(response);
      throw new Error(
        `${method} ${absolute} failed with ${response.status} ${response.statusText}: ${detail}`,
      );
    }
  }

  async function json(method, url, body) {
    const response = await request(method, url, body);
    return response.json();
  }

  async function paginate(url) {
    const items = [];
    let next = `${url}${url.includes('?') ? '&' : '?'}per_page=100`;
    while (next) {
      const response = await request('GET', next);
      items.push(...(await response.json()));
      next = nextLink(response.headers?.get?.('link'));
    }
    return items;
  }

  return {
    getPullRequest: (number) => json('GET', `/pulls/${number}`),
    listChangedFiles: (number) => paginate(`/pulls/${number}/files`),
    listComments: (number) => paginate(`/issues/${number}/comments`),
    getComment: (id) => json('GET', `/issues/comments/${id}`),
    createComment: (number, body) => json('POST', `/issues/${number}/comments`, { body }),
    updateComment: (id, body) => json('PATCH', `/issues/comments/${id}`, { body }),

    /**
     * The merge gate. `issue_comment` runs are not attached to the PR's check
     * list, so a commit status on the head sha is the only thing that works
     * across every mode.
     */
    setStatus: async ({ sha, state, context, description, targetUrl }) => {
      try {
        return await json('POST', `/statuses/${sha}`, {
          state,
          context,
          description: clampDescription(description),
          target_url: targetUrl,
        });
      } catch (error) {
        // By far the most common setup mistake, and the raw 403 explains nothing.
        if (/ with 403 /.test(error.message)) {
          throw new Error(
            `${error.message}\n\nquizme could not write a commit status. The job that calls ` +
              'quizme must grant `statuses: write` (a called workflow cannot escalate ' +
              "its caller's permissions). See the README setup section.",
          );
        }
        throw error;
      }
    },
  };
}

function shouldRetry(response) {
  if (RETRY_STATUSES.has(response.status)) return true;
  // Secondary rate limits surface as 403 with the remaining budget exhausted.
  const remaining = response.headers?.get?.('x-ratelimit-remaining');
  return response.status === 403 && remaining === '0';
}

function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/** GitHub silently truncates status descriptions past 140 characters. */
function clampDescription(description) {
  const text = description ?? '';
  return text.length <= 140 ? text : `${text.slice(0, 137)}...`;
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
