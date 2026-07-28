/**
 * Pure skip rules. First matching rule wins, so the order below is the
 * documented precedence in the spec.
 */

/**
 * @param {{inputs: object, pr: object, changedFiles: Array<{filename: string, additions: number, deletions: number}>}} args
 * @returns {{eligible: boolean, reason: string}}
 */
export function checkEligibility({ inputs, pr, changedFiles }) {
  const author = pr?.user?.login ?? '';

  if (!inputs.enabled) {
    return skip('quizme is disabled for this repository');
  }

  if (isBot(author, pr?.user?.type)) {
    return skip(`author ${author || 'unknown'} is a bot`);
  }

  if (inputs.users.length > 0 && !inputs.users.includes(author.toLowerCase())) {
    return skip(`author ${author} is not in the configured users list`);
  }

  if (pr?.draft) {
    return skip('pull request is a draft');
  }

  if (isFork(pr)) {
    return skip(
      'pull request comes from a fork (answering requires write access to edit the quiz comment)',
    );
  }

  if (!changedFiles || changedFiles.length === 0) {
    return skip('no changed files');
  }

  if (
    inputs.ignorePaths.length > 0 &&
    changedFiles.every((file) => matchesAnyGlob(file.filename, inputs.ignorePaths))
  ) {
    return skip('all changed files match ignored paths');
  }

  const changedLines = changedFiles.reduce(
    (total, file) => total + (file.additions ?? 0) + (file.deletions ?? 0),
    0,
  );
  if (changedLines < inputs.minChangedLines) {
    return skip(
      `${changedLines} changed lines is below the min_changed_lines threshold of ${inputs.minChangedLines}`,
    );
  }

  return { eligible: true, reason: '' };
}

/**
 * A login is a bot if GitHub says so or it carries the conventional suffix.
 */
export function isBot(login, type) {
  if (type === 'Bot') return true;
  return /\[bot\]$/i.test(login ?? '');
}

export function isFork(pr) {
  const head = pr?.head?.repo?.full_name;
  const base = pr?.base?.repo?.full_name;
  if (!head || !base) return true;
  return head !== base;
}

/**
 * Minimal glob matcher: supports `**`, `*`, `?` and `{a,b}`.
 * `*` and `?` never cross a `/`; `**` does.
 */
export function matchesAnyGlob(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

const regexCache = new Map();

function globToRegExp(pattern) {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` should also match zero directories, so consume the slash.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
      } else {
        const alternatives = pattern
          .slice(i + 1, close)
          .split(',')
          .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        out += `(?:${alternatives.join('|')})`;
        i = close;
      }
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  const regex = new RegExp(`^${out}$`);
  regexCache.set(pattern, regex);
  return regex;
}

function skip(reason) {
  return { eligible: false, reason };
}
