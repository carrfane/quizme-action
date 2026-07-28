You are writing a short comprehension quiz for the author of a pull request.

The author may have generated this code with an AI agent and merged it without
reading it carefully. Your job is to produce questions that are impossible to
answer correctly without actually understanding what the change does. The goal is
not to trick them — it is to make them notice something they would otherwise have
merged blind.

You have **no tools**. Do not attempt to run commands, read files, or search the
repository: nothing will execute and the run will fail. Everything you need is
below. Reason from it directly and reply with the JSON.

## The change under review

- Base ref: `{{BASE_REF}}`
- Diff range: `{{RANGE}}`

### Commits

```
{{COMMITS}}
```

### Files changed

```
{{DIFF_STAT}}
```

### Full diff

```diff
{{DIFF}}
```

## What to ask

Write exactly {{QUESTION_COUNT}} multiple-choice questions. Prioritise, in order:

1. **Consequences.** What breaks, changes behaviour, or becomes possible because
   of this change? What happens on the error path, at a boundary, or with empty,
   missing or concurrent input?
2. **Rationale.** Why was it done this way? What would the obvious alternative
   have cost?
3. **Blast radius.** What else does this affect that the diff does not show —
   callers, jobs, migrations, configuration, or callers' assumptions? Infer this
   from the diff; do not claim specifics you cannot see.

Hard rules:

- Never ask about formatting, naming, line counts, or which files changed. That
  is trivia, not understanding.
- Never write a question answerable from the PR title alone.
- Every question must be decidable from the diff above. No opinions, and no
  guessing at intent that the code does not evidence.
- All four options must be plausible to someone who skimmed the diff. Exactly one
  must be correct. Wrong options should be things a careless reader would
  genuinely believe — not jokes, and not obviously absurd.
- Keep each option under 120 characters. Use backticks for identifiers.
- Reference concrete symbols and file paths so the author can verify you.
- The explanation must state *why* the answer is right and cite the file or
  symbol that proves it. One or two sentences.

If the diff is too small to support meaningful questions, still produce
{{QUESTION_COUNT}} questions about the most consequential thing it touches.

## Output format

Reply with a single JSON object and nothing else. No prose before or after, no
markdown code fence, no commentary.

{
  "questions": [
    {
      "question": "Why does `loadConfig()` now return `null` instead of throwing?",
      "options": {
        "A": "Throwing was measurably slow in the hot path",
        "B": "So `boot()` can distinguish a missing file from a malformed one",
        "C": "To satisfy the `no-throw-literal` lint rule",
        "D": "It is a side effect of the TypeScript upgrade"
      },
      "answer": "B",
      "explanation": "`boot()` in `src/boot.mjs` now branches on a null return and falls back to defaults, whereas a throw would have aborted startup."
    }
  ]
}
