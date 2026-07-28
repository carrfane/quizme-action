# quizme-action — Design

Date: 2026-07-28
Status: Approved

## Problem

Agent-generated pull requests are easy to merge without reading. There is no
mechanical prompt that forces the author to confront what the code actually
does before merging.

## Goal

A reusable GitHub Action that, on a pull request, generates a short
multiple-choice quiz about the branch's changes, posts it as a clickable PR
comment, and blocks merge via a commit status until the author submits answers.
On submission the correct answers and explanations are revealed and the status
turns green.

The gate enforces **engagement, not correctness**. Its value is the moment the
author reads "the correct answer was C" and thinks *is that really what I
wanted?*

## Non-goals

- Anti-cheat. The tool is self-imposed discipline. Pasting the quiz into an LLM
  defeats it, and that is acceptable.
- Reviewer quizzing. The target is the PR author.
- Fork support. Clicking a checkbox in a bot's comment requires write access.
- Correctness enforcement, retries, or attempt caps.

## Key constraints discovered

1. GitHub Actions runs are non-interactive and time-boxed. "Interactive" must be
   asynchronous: post, exit, react to a later event.
2. GitHub has no buttons. Markdown task lists are clickable in **any** comment
   and editing a comment fires `issue_comment.edited`. That is the button.
3. Clicking a checkbox edits the comment, so the actor needs permission to edit
   it — i.e. repo write access. Forks are therefore out.
4. `issue_comment`-triggered workflows run in the **default branch** context and
   are not associated with the PR's check list. The gate must be a **commit
   status** (`POST /repos/{o}/{r}/statuses/{sha}`) on the PR head SHA.
5. Our own comment edit would re-fire `issue_comment.edited`. Loop protection is
   mandatory.
6. A called reusable workflow cannot escalate permissions. The **caller** must
   grant `statuses: write`, `issues: write`, `pull-requests: write`.

## Architecture

Two consumer-facing artifacts in one repo:

- **Reusable workflow** `.github/workflows/quizme.yml` (`workflow_call`).
  Owns trigger filtering, permissions, concurrency. Consumers write ~15 lines.
  Reusable workflows see the original `github.event`, so all cheap YAML-level
  filtering lives in the job `if:`. Ineligible events skip without a runner.
- **Composite action** `action.yml`. All logic. Usable standalone for custom
  triggers.

The reusable workflow reaches its own composite action by checking itself out at
`github.job_workflow_sha` (the SHA of the reusable workflow file being run) into
`path: .quizme`, then `uses: ./.quizme`. This pins action code to the exact
version the consumer referenced without hardcoding a tag.

**Zero runtime dependencies, no build step.** Scripts are plain ESM `.mjs` run by
the runner's preinstalled Node, using built-in `fetch` for the GitHub REST API.
No `@actions/*`, no vendored `dist/`, no `npm install`.

### Layout

```
action.yml                          composite action
.github/workflows/quizme.yml        reusable workflow (workflow_call)
.github/workflows/ci.yml            this repo's own tests
scripts/main.mjs                    entry; --phase=resolve | run
scripts/lib/config.mjs              inputs, provider -> env var mapping
scripts/lib/eligibility.mjs         users / bots / drafts / forks / paths / threshold
scripts/lib/router.mjs              event payload -> mode
scripts/lib/comment.mjs             marker render/parse, base64 key codec
scripts/lib/grade.mjs               selections + key -> score + results body
scripts/lib/opencode.mjs            spawn `opencode run --format json`, extract JSON
scripts/lib/github.mjs              REST helpers (status, comments, PR, files)
scripts/lib/generate.mjs            prompt -> opencode -> validate -> post
prompts/generate.md                 quiz generation prompt template
test/*.test.mjs                     node:test unit tests
test/fixtures/                      event payloads, opencode responses
examples/caller.yml
README.md
```

### Composite action steps

1. `resolve` — `node main.mjs --phase=resolve`. Reads the event payload, calls
   the API if needed (an `issue_comment` payload has no head SHA), applies
   eligibility, writes outputs `mode`, `head_sha`, `pr_number`, `reason`.
2. `actions/checkout` — only when `mode == 'generate'`. `ref: head_sha`,
   `fetch-depth: 0`, `path: quizme-pr`.
3. Install opencode — only when `mode == 'generate'`. Pinned version.
4. `run` — `node main.mjs --phase=run`.

`grade`, `bypass`, `carry` and `skip` need no checkout and no LLM call, so those
paths are fast and free.

## Modes

| Mode | Trigger | Action |
| --- | --- | --- |
| `generate` | `pull_request` opened / reopened / ready_for_review, or `/quizme` comment | Build quiz, post comment, status `pending` |
| `carry` | `pull_request` synchronize with an existing graded comment | Status `success`, "already answered at `<sha>`" |
| `grade` | `issue_comment.edited` on a quiz comment with Submit checked | Score, rewrite comment as results, status `success` |
| `bypass` | `/quizme skip` comment | Status `success`, "bypassed by @user" |
| `skip` | Ineligible | Status `success`, "not applicable" |

`synchronize` with no graded comment falls through to `generate`.

### Sticky pass

Each push produces a new head SHA with no commit status, which would re-block
the PR. `carry` implements stickiness: if any `<!-- quizme:graded -->` comment
exists on the PR, immediately mark the new SHA green. Accepted tradeoff: a pass
never expires, so an author can pass early and then push anything. `/quizme`
forces a fresh quiz when wanted.

## Comment format

Quiz comment:

```md
<!-- quizme:quiz v=1 sha=abc1234 -->
## Do you understand this PR?

Pick one answer per question, then check **Submit answers**.

**1.** Why does `foo()` now return `Result<T>` instead of throwing?

- [ ] A. …
- [ ] B. …
- [ ] C. …
- [ ] D. …

**2.** …

---

- [ ] **Submit answers**

<!-- quizme:key eyJxdWVzdGlvbnMiOlt7… -->
```

The `quizme:key` payload is `base64(JSON)` of `{answer, explanation}` per
question. Base64's alphabet excludes `-` and `>`, so it can never terminate the
HTML comment early. This is deliberate obfuscation, not security — decoding it
is the same effort class as asking an LLM, which is already unpreventable.
Benefit: grading is deterministic, free, needs no second LLM call and no extra
secret, and explanations are available offline.

Results comment (replaces the quiz body in place):

```md
<!-- quizme:graded v=1 sha=abc1234 score=2/3 -->
## Quiz results — 2 / 3

**1.** ✅ Why does `foo()` now return `Result<T>` …
> Your answer: **B** — correct.
> <explanation>

**2.** ❌ …
> Your answer: **A**. Correct answer: **C**.
> <explanation>
```

**Loop protection** — two independent guards:
1. The results body contains no `[x] **Submit answers**` line and swaps the
   marker to `quizme:graded`, so the workflow's `if:` no longer matches.
2. `github.event.sender.type == 'Bot'` is rejected in `router.mjs`.

## Eligibility

Evaluated in order; the first match wins.

| Condition | Result |
| --- | --- |
| `enabled: false` | skip |
| Author login ends with `[bot]` | skip |
| `users` non-empty and author not listed | skip |
| PR is draft | skip |
| Head repo != base repo (fork) | skip |
| All changed files match `ignore_paths` | skip |
| Changed lines < `min_changed_lines` | skip |

`users` is comma- or newline-separated logins, case-insensitive. Empty means
every human contributor. Bots are always skipped regardless — otherwise a
Dependabot PR would block forever on a quiz nobody answers.

For `grade` and `bypass`, the actor must be the PR author (or listed in `users`);
other actors' clicks are ignored.

## opencode invocation

`$RUNNER_TEMP/opencode.json` is written per run:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "<input>",
  "permission": {
    "edit": "deny",
    "bash": { "*": "deny", "git diff *": "allow", "rg *": "allow", … }
  }
}
```

> **Superseded during implementation.** The original design had the agent explore
> the repository with a read-only bash allowlist. That does not work: on the
> first live run the model emitted a tool call, opencode ended the session
> without executing it and exited 0 having produced no quiz — no tool event, no
> permission event, no error event. opencode's non-interactive permission
> semantics could not be reproduced locally, so rather than guess at
> configuration, the dependency on tool use was removed.
>
> **Actual design:** `scripts/lib/diff.mjs` collects the diff with `git`
> (`--stat`, the full patch truncated to 60,000 characters, and the commit list)
> and embeds it in the prompt. Every opencode tool is disabled via
> `tools: { "*": false, ... }`, with the permission denials kept as a redundant
> second layer. The range falls back from `baseSha...headSha` to
> `origin/<baseRef>...HEAD` to `HEAD~1...HEAD` so a force-push or rebase cannot
> break it.
>
> Consequences: generation is cheaper, faster, deterministic and has no sandbox
> to escape. The model sees the diff rather than the whole repository, so
> "blast radius" questions are weaker than originally intended.

Agent is `plan`. Command: `opencode run --format json --model <model> --agent
plan <prompt>` with cwd `quizme-pr`.

Required output is strict JSON, last assistant message only:

```json
{"questions":[{"question":"…","options":{"A":"…","B":"…","C":"…","D":"…"},
               "answer":"C","explanation":"…"}]}
```

Parsing: read `--format json` events, take the final assistant text, strip code
fences, `JSON.parse`, then validate — exact `question_count` items, four options
`A`–`D`, non-empty strings, `answer` in `A`–`D`, non-empty `explanation`.

## Error handling

**Fail open.** This is a discipline aid, not a security control; LLM or network
flakiness must not wedge a PR.

| Failure | Behaviour |
| --- | --- |
| Invalid/unparseable model output | Retry once; then status `success` "quiz generation failed", comment with the error |
| opencode install or auth failure | Status `success` with the reason, comment with the error |
| Submit checked but not exactly one option per question | Append a nudge to the comment, leave status `pending`, exit 0 |
| Key blob missing or corrupt | Status `success` "quiz state lost", comment explaining |
| GitHub API 4xx/5xx | Retry 3× with backoff on 5xx/403-rate-limit; otherwise fail the step loudly (a broken token should be visible) |

Every mode is idempotent: `generate` updates the existing quiz comment (found by
marker) instead of posting a duplicate; status writes are last-write-wins.

## Configuration surface

Reusable workflow inputs / composite action inputs:

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | string | `anthropic/claude-sonnet-4-5` | `provider/model` |
| `users` | string | `''` | Logins the gate applies to; empty = all humans |
| `question_count` | number | `3` | Questions per quiz |
| `enabled` | boolean | `true` | Master switch |
| `ignore_paths` | string | docs/markdown globs | Newline-separated globs; skip if *all* changed files match |
| `min_changed_lines` | number | `0` | Skip below this additions+deletions total |
| `opencode_version` | string | `1.18.4` | Pinned CLI version |
| `api_key_env` | string | `''` | Override the derived env var name |
| `status_context` | string | `quizme` | Commit status context |

Secret: `api_key` (required). The env var is derived from the `model` prefix:
`openai/` → `OPENAI_API_KEY`, `anthropic/` → `ANTHROPIC_API_KEY`,
`openrouter/` → `OPENROUTER_API_KEY`, `google/` → `GOOGLE_GENERATIVE_AI_API_KEY`,
`groq/` → `GROQ_API_KEY`, `xai/` → `XAI_API_KEY`, `deepseek/` → `DEEPSEEK_API_KEY`,
`mistral/` → `MISTRAL_API_KEY`, `azure/` → `AZURE_API_KEY`. Unknown prefixes
require `api_key_env`.

## Consumer usage

```yaml
name: quizme
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created, edited]

jobs:
  quizme:
    permissions:
      contents: read
      pull-requests: write
      issues: write
      statuses: write
    uses: carrfane/quizme-action/.github/workflows/quizme.yml@v1
    with:
      model: openai/gpt-5.5
      users: carrfane
    secrets:
      api_key: ${{ secrets.OPENAI_API_KEY }}
```

To make it blocking, add `quizme` as a required status check in branch
protection.

## Testing

Pure functions carry the logic, so unit tests cover the risk:

- `comment.mjs` — render a quiz, parse it back, round-trip the key codec;
  parse a body with real GitHub checkbox mutations; reject corrupt keys.
- `router.mjs` — table-driven over fixture payloads: every mode, bot sender
  rejection, graded-marker loop protection, `/quizme` vs `/quizme skip`.
- `eligibility.mjs` — each skip rule and its precedence.
- `grade.mjs` — full/partial/zero scores, missing and multi selections.
- `config.mjs` — provider→env mapping, unknown provider error, input coercion.
- `opencode.mjs` — extract JSON from fixture event streams, code-fenced output,
  trailing prose, invalid shapes.

`github.mjs` is exercised through injected `fetch` stubs. End-to-end validation
is a real PR against this repo using the workflow on itself with a cheap model.
