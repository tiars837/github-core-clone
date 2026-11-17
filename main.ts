// Entry point: the lifecycle that connects this forge to the trial env.
//
// The env is the only thing that can tell this process where it lives and
// when the trial is over, so the whole job of this file is three steps:
//   1. start the forge from app.ts on a port the OS picks for us,
//   2. tell the env that port so the suite can reach the forge,
//   3. keep polling the env until it says the trial is done, then stop.
//
// Nothing here talks to the outside world except the env itself. The forge
// never binds a fixed port (the env owns 8080), never exits before the env
// says done, and never needs a model call to do its job.

import { createApp } from './app.ts';

// The env's origin, e.g. http://store:8080 inside a trial pod. Without it
// there is nobody to register with, so there is no point starting at all.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('entry: MAKEFUN_ENV_URL is not set, no env to register with\n');
  process.exit(1);
}

// One env request may take this long before it is abandoned and retried.
const REQUEST_BUDGET_MS = 30_000;
// Retries start this far apart and back off, but never beyond this cap.
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait after the n-th failed attempt (0-based): doubling, capped.
function backoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempt, 8));
}

// A response the caller should treat as "give up for good" instead of
// retrying. Only contract errors land here; anything else is transient.
class FatalEnvError extends Error {}

// POST {envOrigin}/register with the port we bound. 200 means registered;
// 409 means some other entry registered first and this one just waits like
// everyone else. 400/405 mean our request itself is wrong, so stop at once.
// Any network error or other status is retried: the env may still be booting.
async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new FatalEnvError(`register failed with HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof FatalEnvError) throw err;
      // Anything else (env down, timeout, odd status): fall through and retry.
    }
    await wait(backoffMs(attempt));
  }
}

// GET {envOrigin}/done until it answers {"done": true}. The env answers
// immediately either way, so this is a plain poll: a failed poll just means
// "not done yet", never a reason to quit.
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Env unreachable or the poll timed out: keep polling.
    }
    await wait(backoffMs(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`entry: forge listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('entry: registered with env, waiting for done\n');

  await waitUntilDone();
  // Wait until the server has actually stopped accepting connections before
  // exiting, instead of racing process.exit against the close.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('entry: env says done, shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`entry: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
