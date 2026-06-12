export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize async work and enforce a minimum gap between task starts. */
export function createSerialGate(minIntervalMs: number) {
  let tail: Promise<void> = Promise.resolve();
  let lastStartedAt = 0;

  return function runQueued<T>(task: () => Promise<T>): Promise<T> {
    const job = tail.then(async () => {
      if (minIntervalMs > 0) {
        const waitMs = Math.max(0, lastStartedAt + minIntervalMs - Date.now());
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
      lastStartedAt = Date.now();
      return task();
    });

    tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  };
}

export interface FetchWith429RetryOptions {
  fetchImpl: typeof fetch;
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  maxRetries?: number;
  /** Floor delay when Retry-After is missing or zero. */
  minRetryDelayMs?: number;
}

export function resolve429RetryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  minRetryDelayMs: number,
): number {
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  const fromHeader =
    Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : Number.NaN;
  const exponential = Math.min(2000 * 2 ** attempt, 60_000);
  const base = Number.isFinite(fromHeader)
    ? Math.max(fromHeader, minRetryDelayMs)
    : Math.max(exponential, minRetryDelayMs);
  return base + Math.floor(Math.random() * 500);
}

export async function fetchWith429Retry(options: FetchWith429RetryOptions): Promise<Response> {
  const {
    fetchImpl,
    url,
    init,
    timeoutMs,
    maxRetries = 8,
    minRetryDelayMs = 2000,
  } = options;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      lastResponse = response;

      if (response.status === 429 && attempt < maxRetries) {
        const delayMs = resolve429RetryDelayMs(
          attempt,
          response.headers.get("retry-after"),
          minRetryDelayMs,
        );
        await sleep(delayMs);
        continue;
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  throw new Error("Semantic Scholar request failed after retries");
}
