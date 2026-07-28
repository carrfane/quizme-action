/**
 * One place decides what a webhook delivery means.
 *
 * Every GitHub lookup is injected, so the whole decision table is testable
 * without a network. Returns one of:
 *
 *   generate  build a quiz and block the PR
 *   carry     a previous quiz was already answered; unblock this new sha
 *   grade     score submitted answers and unblock
 *   bypass    explicit `/quizme skip`
 *   skip      ineligible; unblock so the PR is never wedged
 *   none      not our business; touch nothing
 */

import { checkEligibility, isBot } from './eligibility.mjs';
import { MARKERS, hasMarker, isSubmitted } from './comment.mjs';

const PR_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'synchronize']);
const SLASH_SKIP = /^\/quizme\s+skip\s*$/i;
const SLASH_PLAIN = /^\/quizme\s*$/i;

export async function routeEvent({ payload, eventName, inputs, lookups }) {
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    return routePullRequest({ payload, inputs, lookups });
  }
  if (eventName === 'issue_comment') {
    return routeIssueComment({ payload, inputs, lookups });
  }
  return none(`unsupported event ${eventName}`);
}

async function routePullRequest({ payload, inputs, lookups }) {
  const action = payload.action;
  if (!PR_ACTIONS.has(action)) {
    return none(`pull_request action "${action}" is not handled`);
  }

  const pr = payload.pull_request;
  const base = { ...prContext(pr), actor: pr.user?.login ?? '' };

  // A fork's head sha is not fetchable with the default token and its author
  // cannot edit our comment, so bail before spending any API calls.
  const preflight = checkEligibility({ inputs, pr, changedFiles: [{ filename: '', additions: 1, deletions: 0 }] });
  if (!preflight.eligible && preflight.reason !== 'no changed files') {
    return { mode: 'skip', reason: preflight.reason, ...base };
  }

  const changedFiles = await lookups.listChangedFiles(pr.number);
  const eligibility = checkEligibility({ inputs, pr, changedFiles });
  if (!eligibility.eligible) {
    return { mode: 'skip', reason: eligibility.reason, ...base };
  }

  if (action === 'synchronize') {
    const graded = findGraded(await lookups.listComments(pr.number));
    if (graded) {
      return {
        mode: 'carry',
        reason: `already answered at ${graded.sha || 'an earlier commit'}`,
        priorSha: graded.sha,
        commentId: graded.id,
        ...base,
      };
    }
  }

  return { mode: 'generate', reason: `${action} on #${pr.number}`, ...base };
}

async function routeIssueComment({ payload, inputs, lookups }) {
  if (!payload.issue?.pull_request) {
    return none('comment is on an issue, not a pull request');
  }

  const sender = payload.sender ?? {};
  if (isBot(sender.login, sender.type)) {
    return none(`comment sender ${sender.login} is a bot`);
  }

  const body = payload.comment?.body ?? '';
  const actor = sender.login ?? payload.comment?.user?.login ?? '';

  // Our own grading edit rewrites the body with this marker. Guard #1 against
  // an edit loop; the workflow `if:` filter is guard #2.
  if (hasMarker(body, MARKERS.graded)) {
    return none('comment is already graded');
  }

  const trimmed = body.trim();
  const isQuizSubmission = hasMarker(body, MARKERS.quiz) && isSubmitted(body);
  const isSkip = SLASH_SKIP.test(trimmed);
  const isForce = SLASH_PLAIN.test(trimmed);

  if (!isQuizSubmission && !isSkip && !isForce) {
    return none('comment is not a quiz submission or a /quizme command');
  }

  const pr = await lookups.getPullRequest(payload.issue.number);
  const author = pr.user?.login ?? '';
  const base = { ...prContext(pr), actor };

  if (isSkip) {
    return { mode: 'bypass', reason: `bypassed by @${actor}`, ...base };
  }

  if (!isTargeted({ actor, author, inputs })) {
    return none(`@${actor} is neither the PR author nor in the configured users list`);
  }

  if (isForce) {
    return { mode: 'generate', reason: `/quizme requested by @${actor}`, ...base };
  }

  return {
    mode: 'grade',
    reason: `answers submitted by @${actor}`,
    commentId: payload.comment.id,
    commentBody: body,
    ...base,
  };
}

/** Everything downstream modes need about the PR, in one shape. */
function prContext(pr) {
  return {
    prNumber: pr.number,
    headSha: pr.head?.sha ?? '',
    baseSha: pr.base?.sha ?? '',
    baseRef: pr.base?.ref ?? '',
    prUrl: pr.html_url ?? '',
    title: pr.title ?? '',
  };
}

function isTargeted({ actor, author, inputs }) {
  const lower = (actor ?? '').toLowerCase();
  if (lower && lower === (author ?? '').toLowerCase()) return true;
  return inputs.users.length > 0 && inputs.users.includes(lower);
}

function findGraded(comments) {
  for (const comment of comments ?? []) {
    if (!hasMarker(comment.body, MARKERS.graded)) continue;
    const match = comment.body.match(/<!--\s*quizme:graded\s+v=1\s+sha=(\w*)/i);
    return { id: comment.id, sha: match ? match[1] : '' };
  }
  return null;
}

function none(reason) {
  return { mode: 'none', reason, prNumber: 0, headSha: '', actor: '', baseSha: '', baseRef: '' };
}
