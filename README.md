# quizme

A GitHub Action that quizzes you on your own pull request, and blocks the merge
until you answer.

It reads the diff with [opencode](https://opencode.ai), writes three
multiple-choice questions about what the change actually does, and posts them as
a PR comment with clickable checkboxes. Merging is blocked by a commit status
until you tick your answers. Then it tells you which ones you got wrong and why.

**The point is not the score.** The point is the moment you read *"the correct
answer was C"* and think *hang on, is that really what I wanted?* If you let an
agent write the code, this is the thing that makes you read it.

---

## Quickstart

**1. Add your model provider's API key as a repository secret.**

Settings → Secrets and variables → Actions → New repository secret. For example
`ANTHROPIC_API_KEY`.

**2. Add `.github/workflows/quizme.yml` to your repository:**

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
      issues: write
      pull-requests: write
      statuses: write
    uses: carrfane/quizme-action/.github/workflows/quizme.yml@v1
    with:
      model: anthropic/claude-sonnet-4-5
      users: your-github-login
    secrets:
      api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Those four `permissions` lines are **required**. A called workflow cannot grant
itself more permission than its caller, so if you omit `statuses: write` quizme
fails with a 403 and an explanation.

The `issue_comment` trigger is also required — that is how ticking a checkbox
gets back to the action.

**3. Make it blocking.**

Settings → Branches → branch protection rule for `main` → *Require status checks
to pass* → add **`quizme`**.

Skip this step and quizme still posts quizzes; it just cannot stop you merging.
Do this step and merging is genuinely blocked until you answer.

Open a pull request. That's it.

---

## What it looks like

quizme posts one comment:

> ## Do you understand this PR?
>
> Merging is blocked until you answer. Tick **one** option per question, then
> tick **Submit answers**.
>
> **1.** Why does `loadConfig()` now return `null` instead of throwing?
>
> - [ ] A. Throwing was measurably slow in the hot path
> - [ ] B. So `boot()` can distinguish a missing file from a malformed one
> - [ ] C. To satisfy the `no-throw-literal` lint rule
> - [ ] D. A side effect of the TypeScript upgrade
>
> ---
>
> - [ ] **Submit answers**
>
> _Grading runs as a GitHub Actions job — results usually appear within 30 seconds._

You click the checkboxes directly in the comment. When you tick **Submit
answers**, the comment is rewritten in place with your score, the correct
answers and an explanation for each, and the `quizme` status turns green.

Expect a short wait. Ticking a checkbox edits the comment, which triggers a
workflow run — around 12 seconds in practice, of which roughly 7 is GitHub
queueing and provisioning a runner. Nothing visible happens during it, hence the
note in the comment.

The answer key is already sitting in that comment as base64, so it is fair to ask
why revealing it needs a server round trip. Two reasons: GitHub strips
JavaScript from comment bodies, so there is no client-side code that could decode
it; and passing the quiz has to write a commit status to unblock the merge, which
is an authenticated API call regardless. A `<details>` block would reveal
instantly without JavaScript, but it would make peeking a single idle click and
destroy the only thing this tool is for.

---

## Configuration

| Input | Default | Description |
| --- | --- | --- |
| `model` | `anthropic/claude-sonnet-4-5` | `provider/model`, as opencode expects it |
| `small_model` | same as `model` | Cheaper secondary model for opencode's internal work. Must use the same provider |
| `users` | *(empty)* | Comma or newline separated logins the quiz applies to. Empty means every human contributor |
| `question_count` | `3` | Questions per quiz, 1–10 |
| `enabled` | `true` | Set `false` to switch quizme off without deleting the workflow |
| `ignore_paths` | docs and markdown globs | Newline separated globs. The quiz is skipped when *every* changed file matches. Set to `none` to disable |
| `min_changed_lines` | `0` | Skip the quiz when additions + deletions is below this |
| `opencode_version` | `1.18.4` | Pinned opencode CLI version |
| `api_key_env` | *(derived)* | Override the env var the key is exported as |
| `status_context` | `quizme` | Commit status name; this is what you add to branch protection |
| `runs_on` | `ubuntu-latest` | Runner label |

| Secret | Required | Description |
| --- | --- | --- |
| `api_key` | yes | API key for your model provider |

### Providers

**The provider comes from the `model` input, not from your environment.** quizme
never guesses by looking at which keys happen to be set. The chain is:

```
model: openai/gpt-5.5          # you write this
        └─ prefix "openai"     # quizme splits on the first "/"
            └─ OPENAI_API_KEY  # your single `api_key` secret is exported as this
                └─ opencode reads it
```

So you always pass exactly **one** secret, and quizme renames it to whatever the
provider expects. Only that one key exists in the runner, which means opencode
can never silently fall back to a different vendor.

| Model prefix | Key exported as |
| --- | --- |
| `openai/` | `OPENAI_API_KEY` |
| `anthropic/` | `ANTHROPIC_API_KEY` |
| `openrouter/` | `OPENROUTER_API_KEY` |
| `google/` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `groq/` | `GROQ_API_KEY` |
| `xai/` | `XAI_API_KEY` |
| `deepseek/` | `DEEPSEEK_API_KEY` |
| `mistral/` | `MISTRAL_API_KEY` |

For anything else — including **Azure**, which needs a resource name or endpoint
that a single secret cannot express — set `api_key_env` to the variable your
provider expects:

```yaml
with:
  model: acme/some-model
  api_key_env: ACME_TOKEN
secrets:
  api_key: ${{ secrets.ACME_TOKEN }}
```

Two consequences worth knowing:

- **A mismatch is not detected.** Setting `model: openai/...` while passing an
  Anthropic key just fails with a provider auth error. quizme does not sniff key
  formats to guess your intent.
- **`small_model` must share the provider.** Because only one key is exported, a
  secondary model from another provider could never authenticate. quizme rejects
  that on the first event with an explicit message rather than dying halfway
  through generation. Leave `small_model` unset and it simply reuses `model`.

### Commands

| Comment | Effect |
| --- | --- |
| `/quizme` | Throw away the current quiz and generate a fresh one for the current head commit |
| `/quizme skip` | Bypass the quiz. The status goes green and the thread records who bypassed it |

---

## How it works

Five modes, chosen from the webhook payload:

| Mode | When | Effect |
| --- | --- | --- |
| `generate` | PR opened / reopened / ready for review, or `/quizme` | Reads the diff, posts the quiz, sets the status **pending** |
| `grade` | You tick **Submit answers** | Scores it, reveals the key, sets the status **success** |
| `carry` | You push more commits after answering | Marks the new commit green without re-quizzing |
| `bypass` | `/quizme skip` | Green, with the actor recorded |
| `skip` | Draft, fork, bot, docs-only, below threshold, or disabled | Green — never leaves a PR wedged |

A few decisions worth knowing about:

**A GitHub Action cannot be interactive.** Runs are non-interactive and
time-boxed. So the "interaction" is asynchronous: quizme posts and exits, you
click, and a *second* workflow run reads your click. Markdown task lists are the
only clickable control GitHub offers, and ticking one edits the comment, which
fires `issue_comment.edited`.

**The gate is a commit status, not a check run.** Workflows triggered by
`issue_comment` run in the default branch's context and are not attached to the
PR's check list, so a commit status on the head SHA is the only mechanism that
works from every mode.

**Grading is offline and deterministic.** The answer key travels with the
comment in a base64 blob, so grading needs no second model call, no checkout and
no extra secret. One model call per quiz, and none at all for grading,
bypassing, carrying or skipping.

**The model gets no tools.** quizme collects the diff itself with `git` and
embeds it in the prompt; every opencode tool is switched off. This started as a
bug fix — when the model was allowed to explore, it emitted a tool call, opencode
ended the session without executing it and exited 0 having produced nothing — but
it is better anyway: cheaper, faster, deterministic, and there is no sandbox to
escape. The cost is that the model sees the diff rather than the whole
repository, so questions about distant blast radius are weaker. Large diffs are
truncated at 60,000 characters.

**It fails open.** A model outage, a malformed response, a corrupt key — all of
them unblock the PR and tell you what happened. This is a discipline aid, not a
security control, and it must never wedge your repository.

**Passing is engagement, not correctness.** Answer everything and the status
goes green whatever you scored. There are no retry loops and no nagging. Getting
one wrong and reading why is the whole product.

---

## Testing it in a real repository

Unit tests cover the logic. Only a real pull request proves the trigger
filtering, the clickable checkboxes and the commit status work against the real
GitHub API. Here is a walkthrough that exercises every mode in about ten
minutes.

### Setup

1. Pick a repository you can push to and that you own. **Do not** use a busy
   shared repo for the first run.
2. Add your provider key as a secret.
3. Add the caller workflow from [Quickstart](#quickstart) to `main`. It must be
   on the **default branch** — `issue_comment` events only ever run the workflow
   version found there.
4. Do **not** add the required status check yet. Confirm it works first,
   otherwise a bug leaves you unable to merge the fix.

### 1. Generate

```bash
git checkout -b quizme-trial
printf 'export const RETRY_LIMIT = 3;\n' > src/retry.mjs
git add src/retry.mjs && git commit -m "Add a retry limit"
git push -u origin quizme-trial
gh pr create --fill
```

Within a minute you should see a quiz comment and a **pending** `quizme` status
on the PR. Verify:

```bash
gh pr checks
gh api "repos/:owner/:repo/commits/$(git rev-parse HEAD)/status" \
  --jq '.statuses[] | {context, state, description}'
```

Expect `{"context": "quizme", "state": "pending", ...}`.

### 2. Incomplete submission

Tick **one** answer, leave the rest blank, then tick **Submit answers**.

Expected: the comment gains a warning listing the questions you missed,
**Submit answers** is unticked again, and the status stays **pending**. This
also proves loop protection — the bot's own edit must not retrigger grading.
Confirm only one extra workflow run appeared:

```bash
gh run list --workflow=quizme.yml --limit 5
```

### 3. Grade

Tick the rest, then tick **Submit answers**.

Expected: the comment becomes "Quiz results — N / 3" with explanations, and the
status flips to **success** with `Answered N/3`. Read the explanations — that is
the actual feature.

### 4. Carry forward

```bash
printf 'export const TIMEOUT_MS = 5000;\n' >> src/retry.mjs
git commit -am "Add a timeout" && git push
```

Expected: the new commit gets **success** with `Already answered at <sha>`, and
no new quiz. A pass is sticky by design.

### 5. Force a fresh quiz

Comment `/quizme`.

Expected: the existing comment is replaced by a new quiz for the current head,
status back to **pending**. Note it *edits* the comment rather than posting a
second one.

### 6. Bypass

Comment `/quizme skip`.

Expected: the quiz comment is retired to a short "bypassed" notice, status
**success** with `Bypassed by @you`.

### 7. Skip rules

Open a PR that only touches `README.md`. Expected: no comment at all, and a
**success** status reading `Not applicable: all changed files match ignored
paths`. Then try a draft PR: same, with `pull request is a draft`.

### 8. Make it blocking

Now that everything behaves, add `quizme` as a required status check in branch
protection, and confirm the merge button is disabled on a fresh PR until you
answer.

### Debugging a run

```bash
# Which mode did it pick, and why?
gh run list --workflow=quizme.yml --limit 10
gh run view <run-id> --log | grep 'quizme:'
```

Every run logs one line like `quizme: mode=generate (opened on #12)`. If a run
did not start at all, the job-level `if:` filtered it out — that is usually
correct and intentional.

---

## Troubleshooting

**Nothing happens when I open a PR.**
Is the caller workflow on your default branch? Is the PR a draft, from a fork,
or docs-only? Check for a `quizme` status with `gh pr checks` — a `Not
applicable: ...` description tells you which rule fired.

**403 "Resource not accessible by integration".**
Your caller job is missing `statuses: write` or `issues: write`. A called
workflow cannot escalate its caller's permissions, so the permissions must be on
the job that has the `uses:` line.

**Ticking a checkbox does nothing.**
Ticking a bot's comment requires write access to the repository. Also confirm
your caller workflow includes `issue_comment: types: [created, edited]` — the
`edited` type is what a checkbox click produces.

**`refusing to allow an OAuth App to create or update workflow`.**
Your local `gh` token lacks the `workflow` scope. Run
`gh auth refresh -s workflow`.

**"Quiz could not be generated".**
The comment contains the underlying error. Usually a bad API key or a model that
ignored the JSON output contract. Try a stronger model, or comment `/quizme` to
retry.

**Dependabot PRs are stuck.**
They are not. Bot authors are always skipped and get an immediate green status.

**A fork PR shows `quizme` as never having run.**
Expected. A fork's `pull_request` token cannot write commit statuses. Comment
`/quizme skip` as a maintainer to unblock it — comment-triggered runs do have a
writable token. See [Limitations](#limitations).

---

## Limitations

Stated plainly, because they are design decisions rather than bugs:

- **The answer key is obfuscated, not secret.** It is base64 in an HTML comment
  in the PR. You can decode it. You can also just paste the quiz into an LLM.
  Neither is preventable, and both take about the same effort as reading the
  diff, which is the thing we actually want. This is a tool for people who want
  the friction, not a control that survives an adversary.
- **A pass is sticky.** Once you have answered, later pushes are carried forward
  green. You can pass early and then push anything. Comment `/quizme` when you
  want a fresh quiz for new work.
- **Forks are skipped, and cannot be reported on.** Clicking a checkbox means
  editing the bot's comment, which needs write access. Worse, a fork's
  `pull_request` token is read-only, so quizme cannot even write the green
  status — it logs a warning and exits cleanly rather than painting a red X on a
  contributor's PR. `/quizme` is refused on a fork too, for a second and stronger
  reason: see [Security](#security). **Consequence:** if you make `quizme` a
  *required* check on a public repository, fork PRs will sit with the check
  unreported. A maintainer can comment `/quizme skip` to unblock them, because
  `issue_comment` runs do have a writable token. If you take many fork
  contributions, consider leaving `quizme` optional.
- **Bots are always skipped**, even if you list them in `users`, so automated
  PRs never wedge on a quiz nobody will answer.
- **One model call per quiz** costs whatever your provider charges for reading a
  diff and writing three questions. Cheap, but not free. `ignore_paths` and
  `min_changed_lines` keep it off trivial changes.

## Security

quizme holds a model provider API key and reads your diff. Three properties keep
those two facts apart.

**The model gets no tools and no filesystem.** The whole diff is embedded in the
prompt, so opencode is run with every tool disabled and — more importantly — with
its working directory set to an *empty* temporary directory, never the checkout.
That matters because opencode merges configuration by precedence, and a
`opencode.json` committed to a repository outranks the one quizme supplies. A
`.opencode/plugins/` directory is worse still: it is code opencode loads and
executes. Both are discovered relative to the working directory, so an empty
working directory removes the whole class rather than trying to out-configure it.
`test/sandbox.test.mjs` pins this.

**Unreviewed code is never checked out.** `issue_comment` events run in the base
repository with secrets available, so `/quizme` on a fork pull request is refused
outright. Only `pull_request` events from the same repository reach the generate
path.

**The key is exported only for a generate, and never published.** grade, carry,
bypass and skip never receive it. The action shell never echoes it and never
enables tracing. GitHub masks secrets in workflow logs, but *not* in anything
written through the REST API, so failure comments carry only the structured
provider error — raw stdout and stderr stay in the log — and every comment body
passes through a redaction step on the way out.

What this does **not** protect against, stated plainly:

- **`/quizme skip` is not authorised.** Any non-bot commenter — on a public
  repository, any GitHub user — can flip the status to green. That is the same
  posture as the answer key: quizme is a speed bump for people who want one, not
  a gate that survives someone who does not. Do not treat a green `quizme` status
  as evidence of anything.
- **Anyone who can push a branch to your repository can already read your
  secrets** by editing a workflow. quizme does not widen that, and cannot narrow
  it.
- **The answer key is readable.** See Limitations above.

### Why not `act`?

[`act`](https://github.com/nektos/act) was evaluated and deliberately not used.
It ships no GitHub API, so the REST interactions still need a stub; it does not
populate `github.job_workflow_sha`, which this reusable workflow depends on; and
exercising `generate` under it needs Docker plus a real API key. The same risks
are covered faster and more reliably by `test/e2e.test.mjs`, which runs the real
entry point against a real local HTTP server and a real subprocess spawn, and by
`test/contract.test.mjs`, which statically pins the workflow's `contains()`
filters to the strings the renderer actually emits. That filter drift is the one
bug class that would otherwise fail silently.

---

## Development

```bash
npm ci        # yaml, for the contract tests only
npm test      # 156 tests, no network, no Docker
```

The action itself has **zero runtime dependencies** — plain ESM run by the
runner's Node, GitHub API via built-in `fetch`. There is no build step and no
committed `dist/`. CI enforces that nothing under `scripts/` imports a package.

`self-quiz.yml` dogfoods the action on this repo's own pull requests using
`openai/gpt-5.5`, which is deliberately **not** the shipped default
(`anthropic/claude-sonnet-4-5`). Consequence: the default model path is not
exercised by CI here.

| Path | Responsibility |
| --- | --- |
| `scripts/main.mjs` | Entry point; `--phase=resolve` then `--phase=run` |
| `scripts/lib/router.mjs` | Event payload → mode. The whole decision table |
| `scripts/lib/modes.mjs` | The five handlers, and every fail-open path |
| `scripts/lib/comment.mjs` | Comment rendering, parsing and the answer-key codec |
| `scripts/lib/eligibility.mjs` | Skip rules and their precedence |
| `scripts/lib/diff.mjs` | Collects the diff with `git`, with fallbacks for force-pushes |
| `scripts/lib/opencode.mjs` | CLI config, spawn, output extraction and validation |
| `scripts/lib/github.mjs` | REST client over injectable `fetch` |
| `prompts/generate.md` | The quiz generation prompt |
| `action.yml` | Composite action, for custom triggers |
| `.github/workflows/quizme.yml` | Reusable workflow, for everyone else |

Design notes live in `docs/superpowers/specs/`.

The model never executes anything. All opencode tools are disabled
(`tools: { "*": false, ... }`), with `edit: deny`, `webfetch: deny` and
`bash: { "*": deny }` as a redundant second layer. It runs under the `plan`
agent, and the checkout uses `persist-credentials: false` so no git credential
is ever written into the workspace. The only input the model receives is the
diff text quizme collected.

## Licence

MIT
