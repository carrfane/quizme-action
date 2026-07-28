# quizme-action Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.
> Spec: `docs/superpowers/specs/2026-07-28-quizme-action-design.md`

**Goal:** Ship a reusable GitHub Action that quizzes a PR author on their own diff
and gates merge on a commit status until they submit answers.

**Architecture:** Reusable workflow (`workflow_call`) does trigger filtering and
delegates to a composite action. The composite action resolves a mode from the
event payload, conditionally checks out the PR and installs opencode, then runs
one of five modes. All logic is pure ESM Node with zero dependencies; GitHub API
via built-in `fetch`; quiz state lives in the PR comment body (markers + base64
answer key).

**Tech Stack:** Node 20+ ESM, `node:test`, GitHub REST v3, opencode CLI 1.18.4,
composite action + reusable workflow YAML.

---

## File structure

| File | Responsibility |
| --- | --- |
| `scripts/lib/config.mjs` | Read/coerce inputs from env; map `provider/` prefix to API-key env var |
| `scripts/lib/eligibility.mjs` | Pure skip rules with fixed precedence |
| `scripts/lib/router.mjs` | Pure: event payload + inputs -> `{mode, reason}` |
| `scripts/lib/comment.mjs` | Render quiz body, parse selections, base64 key codec, render results |
| `scripts/lib/grade.mjs` | Pure: selections + key -> score + per-question outcome |
| `scripts/lib/github.mjs` | REST helpers over injectable `fetch` (status, comments, PR, files) |
| `scripts/lib/opencode.mjs` | Write opencode config, spawn CLI, extract + validate quiz JSON |
| `scripts/lib/generate.mjs` | Orchestrate generate mode |
| `scripts/main.mjs` | CLI entry: `--phase=resolve` writes step outputs, `--phase=run` executes the mode |
| `prompts/generate.md` | Quiz generation prompt template |
| `action.yml` | Composite action wiring the four steps |
| `.github/workflows/quizme.yml` | Reusable workflow with trigger filtering |
| `.github/workflows/ci.yml` | Runs `node --test` on this repo |
| `.github/workflows/self-quiz.yml` | Dogfood: this repo quizzes its own PRs |
| `test/*.test.mjs` | Unit tests per lib module |
| `test/fixtures/` | Event payloads + opencode event streams |

Test command throughout: `node --test test/`

---

## Task 1: Repo scaffolding

**Files:** Create `package.json`, `.gitignore`, `.editorconfig`

- [ ] `package.json` with `{"type":"module","private":true,"scripts":{"test":"node --test test/"}}`, no dependencies
- [ ] `.gitignore` ignoring `node_modules/`, `.quizme/`, `quizme-pr/`, `*.log`
- [ ] Commit: `chore: scaffold repo`

## Task 2: `config.mjs` — inputs and provider mapping

**Files:** Create `scripts/lib/config.mjs`, `test/config.test.mjs`

- [ ] Test: `apiKeyEnvFor('openai/gpt-5.5') === 'OPENAI_API_KEY'` for all nine providers in the spec
- [ ] Test: `apiKeyEnvFor('weird/model')` throws with a message naming `api_key_env`
- [ ] Test: `apiKeyEnvFor('weird/model', 'CUSTOM_KEY') === 'CUSTOM_KEY'`
- [ ] Test: `readInputs()` reads `INPUT_MODEL`/`INPUT_USERS`/etc, coerces `question_count` to int, `enabled` to bool, splits `users` and `ignore_paths`, lowercases users
- [ ] Test: `readInputs()` applies every default from the spec table
- [ ] Implement, run `node --test test/config.test.mjs`, commit

## Task 3: `eligibility.mjs` — skip rules

**Files:** Create `scripts/lib/eligibility.mjs`, `test/eligibility.test.mjs`

`checkEligibility({inputs, pr, changedFiles})` -> `{eligible, reason}`

- [ ] Test one case per rule: disabled, `[bot]` author, author not in `users`, draft, fork, all files ignored, below `min_changed_lines`
- [ ] Test precedence: a disabled+draft+fork PR reports the `disabled` reason
- [ ] Test eligible case returns `{eligible:true}`
- [ ] Test empty `users` allows any human; `users` match is case-insensitive
- [ ] Test glob matching: `docs/**`, `*.md`, `**/README.md`
- [ ] Implement (small glob-to-regex helper, no dependency), run tests, commit

## Task 4: `comment.mjs` — markers, rendering, parsing, key codec

**Files:** Create `scripts/lib/comment.mjs`, `test/comment.test.mjs`

- [ ] Test: `encodeKey`/`decodeKey` round-trip; encoded blob contains no `-` or `>`
- [ ] Test: `decodeKey` on garbage returns `null` (never throws)
- [ ] Test: `renderQuiz` output contains `<!-- quizme:quiz v=1 sha=… -->`, one `**N.**` per question, four `- [ ] X.` lines, a `- [ ] **Submit answers**` line, and the key marker
- [ ] Test: `parseQuiz(renderQuiz(...))` recovers sha and questions
- [ ] Test: `parseSelections` on a body where GitHub flipped `- [ ] B.` to `- [x] B.` returns `{1:'B'}`
- [ ] Test: `parseSelections` returns `null` for a question with zero or two boxes checked
- [ ] Test: `isSubmitted` true only for `- [x] **Submit answers**`
- [ ] Test: `renderResults` contains `quizme:graded`, the score, and no `[x] **Submit answers**` substring (loop protection)
- [ ] Implement, run tests, commit

## Task 5: `grade.mjs` — scoring

**Files:** Create `scripts/lib/grade.mjs`, `test/grade.test.mjs`

- [ ] Test: all correct -> `{correct:3,total:3}`, every outcome `true`
- [ ] Test: partial -> correct count and per-question `{selected, expected, correct}`
- [ ] Test: zero correct still returns a result (pass-on-submission is the caller's policy)
- [ ] Test: key/questions length mismatch throws
- [ ] Implement, run tests, commit

## Task 6: `router.mjs` — event to mode

**Files:** Create `scripts/lib/router.mjs`, `test/router.test.mjs`, `test/fixtures/events/*.json`

Fixtures: `pr_opened.json`, `pr_synchronize.json`, `pr_draft.json`, `pr_fork.json`,
`comment_submit.json`, `comment_submit_bot.json`, `comment_slash.json`,
`comment_slash_skip.json`, `comment_unrelated.json`, `comment_graded.json`

- [ ] Test: `pull_request` opened -> `generate`
- [ ] Test: `synchronize` + graded comment present -> `carry`; absent -> `generate`
- [ ] Test: `issue_comment.edited` with quiz marker + submit checked -> `grade`
- [ ] Test: same but `sender.type === 'Bot'` -> `none`
- [ ] Test: body already has `quizme:graded` -> `none` (loop protection)
- [ ] Test: `/quizme skip` -> `bypass`; `/quizme` -> `generate`; `/quizme` from a non-target user -> `none`
- [ ] Test: unrelated comment -> `none`
- [ ] Test: `issue_comment` on a non-PR issue -> `none`
- [ ] Implement, run tests, commit

## Task 7: `github.mjs` — REST helpers

**Files:** Create `scripts/lib/github.mjs`, `test/github.test.mjs`

`createClient({token, repo, fetchImpl})` exposing `getPullRequest`, `listChangedFiles`,
`listIssueComments`, `createComment`, `updateComment`, `setStatus`.

- [ ] Test: `setStatus` POSTs to `/repos/o/r/statuses/<sha>` with the right body and auth header
- [ ] Test: `listChangedFiles` follows `Link: rel="next"` pagination
- [ ] Test: retries a 500 three times then throws; retries `403` with `x-ratelimit-remaining: 0`
- [ ] Test: does not retry a 404 and throws with status and body in the message
- [ ] Implement with injected `fetchImpl` and zero-delay backoff in tests, run tests, commit

## Task 8: `opencode.mjs` — CLI runner and output validation

**Files:** Create `scripts/lib/opencode.mjs`, `test/opencode.test.mjs`, `test/fixtures/opencode/*.txt`

- [ ] Test: `buildConfig({model})` denies `edit`, denies `bash:*`, allows the read-only allowlist
- [ ] Test: `extractQuiz` on a fixture event stream returns the parsed object
- [ ] Test: `extractQuiz` strips ```json fences and leading/trailing prose
- [ ] Test: `validateQuiz` rejects wrong question count, missing option, `answer` not in `A`–`D`, empty explanation, non-object input — each with a distinct message
- [ ] Test: `validateQuiz` accepts a well-formed quiz
- [ ] Implement (`runOpencode` shells out via `node:child_process.spawn`; pure helpers are separately exported and tested), run tests, commit

## Task 9: `prompts/generate.md`

**Files:** Create `prompts/generate.md`

- [ ] Template with `{{QUESTION_COUNT}}`, `{{BASE_SHA}}`, `{{HEAD_SHA}}`, `{{BASE_REF}}` placeholders
- [ ] Instructs: explore with `git diff <base>...<head>` and read surrounding code; target rationale, side effects and consequences rather than trivia; distractors must be plausible; output strict JSON only, no prose, no fences
- [ ] Commit

## Task 10: `generate.mjs` + `main.mjs`

**Files:** Create `scripts/lib/generate.mjs`, `scripts/main.mjs`, `test/main.test.mjs`

- [ ] Test: `--phase=resolve` writes `mode`, `head_sha`, `pr_number`, `reason` to `$GITHUB_OUTPUT`
- [ ] Test: resolve on an ineligible PR emits `mode=skip` and the reason
- [ ] Test: `--phase=run` in `grade` mode with a stubbed client updates the comment and sets status `success` with `"2/3"` in the description
- [ ] Test: `grade` mode with malformed selections leaves status untouched and appends a nudge
- [ ] Test: `grade` mode with a corrupt key sets status `success` with the "quiz state lost" reason
- [ ] Test: `bypass` mode sets status `success` mentioning the actor
- [ ] Test: `carry` mode sets status `success` referencing the prior SHA
- [ ] Test: `generate` mode with a stubbed opencode that throws sets status `success` and posts an error comment (fail open)
- [ ] Test: `generate` twice updates the existing quiz comment rather than creating a second
- [ ] Implement, run tests, commit

## Task 11: `action.yml`

**Files:** Create `action.yml`

- [ ] All spec inputs plus `github_token` and `api_key`; composite `runs`
- [ ] Step 1 `resolve`: `node $GITHUB_ACTION_PATH/scripts/main.mjs --phase=resolve`, `id: resolve`
- [ ] Step 2 `actions/checkout@v4` with `if: steps.resolve.outputs.mode == 'generate'`, `ref: head_sha`, `fetch-depth: 0`, `path: quizme-pr`
- [ ] Step 3 install opencode pinned to `opencode_version`, same `if`
- [ ] Step 4 `run`: `node $GITHUB_ACTION_PATH/scripts/main.mjs --phase=run` with `if: mode != 'none'`, api key exported under the derived env var name
- [ ] Commit

## Task 12: `.github/workflows/quizme.yml`

**Files:** Create `.github/workflows/quizme.yml`

- [ ] `on: workflow_call` with all inputs and `secrets.api_key` required
- [ ] `concurrency: quizme-${{ pr or issue number }}`, `cancel-in-progress: false`
- [ ] Job `if:` prefilter: `pull_request` events, or `issue_comment` whose body contains `quizme:quiz` + `[x] **Submit answers**`, or starts with `/quizme`
- [ ] Checkout self at `github.job_workflow_sha` into `.quizme`, then `uses: ./.quizme`
- [ ] Commit

## Task 13: CI + dogfood workflows

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/self-quiz.yml`

- [ ] `ci.yml`: on push/PR, Node 20, `node --test test/`
- [ ] `self-quiz.yml`: calls `./.github/workflows/quizme.yml` on this repo's own PRs
- [ ] Commit

## Task 14: README + example

**Files:** Create `README.md`, `examples/caller.yml`

- [ ] Quickstart: add secret, add caller workflow, add `quizme` to required status checks
- [ ] Full input/secret reference table
- [ ] "How it works" walkthrough of the five modes
- [ ] "Testing it in a real repo" — step-by-step first-PR walkthrough plus how to verify each mode manually
- [ ] Troubleshooting: missing `statuses: write`, missing `workflow` token scope, forks, bot PRs, checkbox permission requirement
- [ ] Explicit limitations section: obfuscated-not-secret answer key, sticky pass, no fork support
- [ ] Commit

## Task 15: Verify and publish

- [ ] `node --test test/` fully green
- [ ] `node --check` every `.mjs`
- [ ] YAML parse check on all workflow files and `action.yml`
- [ ] `gh repo create carrfane/quizme-action --public --source=. --push` (refresh `workflow` scope first)
- [ ] Tag `v1` and push the tag
