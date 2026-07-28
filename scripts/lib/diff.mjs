/**
 * Collects the change under review with git and hands it to the model directly.
 *
 * Why not let the agent explore with its own bash tool? Because it does not
 * work. Observed on a real run: the model emitted a tool call, opencode ended
 * the session without executing it, and exited 0 having produced no quiz — no
 * tool event, no permission event, no error. Rather than guess at opencode's
 * non-interactive permission semantics, we remove the need for tools. That also
 * makes generation cheaper, faster, deterministic, and trivially sandboxed.
 *
 * Cost: the model sees the diff and the changed files rather than the whole
 * repository, so "blast radius" questions are weaker than they would be with
 * full exploration.
 */

import { execFile } from 'node:child_process';

/** Character budget for the patch. Roughly 15k tokens. */
export const DEFAULT_MAX_CHARS = 60000;

/**
 * @returns {Promise<{range: string, stat: string, patch: string, commits: string, truncated: boolean}>}
 */
export async function collectDiff({
  cwd,
  baseSha,
  headSha,
  baseRef,
  maxChars = DEFAULT_MAX_CHARS,
  runGit = defaultRunGit,
}) {
  const git = (args) => runGit(args, cwd);
  const range = await resolveRange({ git, baseSha, headSha, baseRef });

  const [stat, rawPatch, commits] = await Promise.all([
    git(['diff', '--stat', range]).catch(() => ''),
    git(['diff', range]).catch(() => ''),
    git(['log', '--oneline', '--no-decorate', range.replace('...', '..')]).catch(() => ''),
  ]);

  const truncated = rawPatch.length > maxChars;
  const patch = truncated
    ? `${rawPatch.slice(0, maxChars)}\n\n[... diff truncated at ${maxChars} characters ...]`
    : rawPatch;

  return { range, stat: stat.trim(), patch: patch.trim(), commits: commits.trim(), truncated };
}

/**
 * A rebase or force-push can leave the recorded base commit unreachable, so fall
 * back through progressively weaker but always-available ranges.
 */
async function resolveRange({ git, baseSha, headSha, baseRef }) {
  const head = (await exists(git, headSha)) ? headSha : 'HEAD';

  if (baseSha && (await exists(git, baseSha))) return `${baseSha}...${head}`;
  if (baseRef && (await exists(git, `origin/${baseRef}`))) return `origin/${baseRef}...${head}`;
  if (baseRef && (await exists(git, baseRef))) return `${baseRef}...${head}`;
  return `${head}~1...${head}`;
}

async function exists(git, ref) {
  if (!ref) return false;
  try {
    await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function defaultRunGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(' ')} failed: ${String(stderr || error.message).slice(0, 300)}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
