// Keeps a Proton session alive for as long as the process runs.
//
// Logging in once at start is not enough: when a later login fails (the
// 100-minute refresh during a Proton hiccup, say), the client stops being
// ready, /readyz answers 503, Kubernetes takes the pod out of the Service,
// and no request ever arrives to trigger the next login. This loop is what
// makes the pod come back on its own.

/** Waits `ms`, or less if `signal` fires. */
function pause(ms, signal) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * Logs in whenever `pass` is not ready, backing off from 2 s to 5 min while
 * it keeps failing, and otherwise checks every `checkMs`. Runs until
 * `signal` fires; `sleep` is injectable for tests.
 */
export async function keepLoggedIn(pass, { log, checkMs = 30_000, signal, sleep = pause } = {}) {
  let delay = 2;
  while (!signal?.aborted) {
    if (!pass.ready) {
      try {
        await pass.login();
        log('logged in to Proton Pass');
        delay = 2;
      } catch (err) {
        log(`${err.message}; next attempt in ${delay}s`);
        await sleep(delay * 1000, signal);
        delay = Math.min(delay * 2, 300);
        continue;
      }
    }
    await sleep(checkMs, signal);
  }
}
