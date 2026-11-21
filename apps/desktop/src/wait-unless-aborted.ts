/** Cancel one wait without transferring its signal to the shared operation. */
export function waitUnlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const fail = (reason: unknown) => reject(reason instanceof Error ? reason : new Error('Operation interrupted', {cause: reason}));
    const cancel = () => fail(signal.reason);
    void work.then(value => {
      signal.removeEventListener('abort', cancel);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', cancel);
      fail(error);
    });
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, {once: true});
  });
}
