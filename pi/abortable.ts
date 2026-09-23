const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" && reason ? reason : "Operation aborted");
};

/** Abort waiting, not the effect. Always observe late settlement and remove listeners. */
export function runAbortable<T>(signal: AbortSignal | undefined, operation: () => T | PromiseLike<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal!)));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      Promise.resolve(operation()).then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
