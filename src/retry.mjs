/** Retry a function with exponential backoff. */
export async function retry(fn, { attempts = 3, baseMs = 100 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
