/**
 * Failure text that is safe to put in a public pull request comment.
 *
 * A generate failure is published, and GitHub's secret masking covers workflow
 * logs but *not* bodies written through the REST API. So the default has to be
 * that nothing is published: the generate handler falls back to a fixed string
 * rather than to `error.message`, and a throw site opts in explicitly when its
 * message is both safe and useful to the author.
 *
 * That direction matters. The first version of this fallback was
 * `publicMessage ?? message`, which failed open — every new throw site was one
 * oversight away from publishing a filesystem path, a provider response, or raw
 * model output.
 */

/**
 * @param {string} logMessage Full detail, for the workflow log.
 * @param {string} [publicMessage] Comment-safe variant. Defaults to logMessage,
 *   which is correct only when the message interpolates nothing untrusted.
 */
export function publicError(logMessage, publicMessage) {
  const error = new Error(logMessage);
  error.publicMessage = publicMessage ?? logMessage;
  return error;
}

/**
 * Flatten untrusted text so it cannot break out of the fenced block it is
 * rendered into, and bound it so a provider cannot fill the comment.
 */
export function forComment(text, max = 500) {
  const flat = String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/`/g, "'")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
