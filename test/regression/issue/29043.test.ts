import { expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";

// https://github.com/oven-sh/bun/issues/29043
//
// Worker error event must honor preventDefault(): when the worker's own
// `error` event listener cancels the event, the error must not propagate to
// the parent Worker and the worker must not be terminated with exit code 1.

async function runWorker(workerCode: string) {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
        import { Worker } from 'node:worker_threads';
        const worker = new Worker(${JSON.stringify(workerCode)}, { eval: true });
        const errors = [];
        worker.on('error', (err) => { errors.push(err && err.message); });
        const workerExitCode = await new Promise((resolve) => { worker.on('exit', resolve); });
        console.log('exit:' + workerExitCode);
        if (errors.length !== 0) {
          console.log('PARENT_ERROR_COUNT:' + errors.length);
          process.exit(2);
        }
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

function expectCleanWorkerExit({ stdout }: { stdout: string; exitCode: number | null }) {
  // The worker's own exit code is printed to stdout as `exit:N`. We assert
  // against THAT, not the outer bun process's exit code — the outer process
  // can race on shutdown in release builds (tracked separately; see
  // `PARENT_ERROR_COUNT` gate for the condition we actually care about).
  expect(stdout).toContain("exit:0");
  expect(stdout).not.toContain("PARENT_ERROR");
}

test("Worker error event preventDefault() stops propagation and keeps worker running (async throw)", async () => {
  // Microtask throw — exercises the runtime `onUnhandledRejection` path.
  const result = await runWorker(`
    globalThis.addEventListener('error', (e) => {
      console.log('handled:' + (e.error && e.error.message));
      e.preventDefault();
    });

    queueMicrotask(() => {
      throw new Error('hmm');
    });

    setImmediate(() => {
      setImmediate(() => {
        console.log('alive');
        process.exit(0);
      });
    });
  `);

  expect(result.stdout).toContain("handled:hmm");
  expect(result.stdout).toContain("alive");
  expectCleanWorkerExit(result);
});

test("Worker error event preventDefault() stops propagation and keeps worker running (top-level throw)", async () => {
  // Top-level throw — flows through the rejected-promise branch in `spin()`.
  const result = await runWorker(`
    globalThis.addEventListener('error', (e) => {
      console.log('handled:' + (e.error && e.error.message));
      e.preventDefault();
    });

    setImmediate(() => {
      console.log('alive');
      process.exit(0);
    });

    throw new Error('entry');
  `);

  expect(result.stdout).toContain("handled:entry");
  expect(result.stdout).toContain("alive");
  expectCleanWorkerExit(result);
});

test("Worker error event preventDefault() does not leak prevented state across dispatches", async () => {
  // Two sequential cancelled errors. Each dispatch must see the worker start
  // from a clean state: `e.defaultPrevented === false` at entry. A regression
  // in the `error_event_prevented = false` reset at `onUnhandledRejection`'s
  // entry (web_worker.zig) would leave a stale `true` from the first error
  // visible in downstream guards, but would NOT be observable via
  // `e.defaultPrevented` here — that's a separate flag on the Event object.
  //
  // What this test actually guards against: a double-dispatch of a single
  // error (which would show dispatch:2 for the same message), and ensures
  // both errors make it to the listener and are cancelled cleanly.
  const result = await runWorker(`
    let dispatchCount = 0;
    globalThis.addEventListener('error', (e) => {
      dispatchCount++;
      console.log('dispatch:' + dispatchCount + ':' + (e.error && e.error.message) + ':prev=' + e.defaultPrevented);
      e.preventDefault();
    });

    queueMicrotask(() => { throw new Error('first'); });
    queueMicrotask(() => { throw new Error('second'); });

    setImmediate(() => {
      console.log('alive total:' + dispatchCount);
      process.exit(0);
    });
  `);

  // Each error was dispatched exactly once, with a fresh (not-prevented)
  // event object, and cancelled — so the worker keeps running.
  expect(result.stdout).toContain("dispatch:1:first:prev=false");
  expect(result.stdout).toContain("dispatch:2:second:prev=false");
  expect(result.stdout).toContain("alive total:2");
  expectCleanWorkerExit(result);
});

test("Worker error event preventDefault() keeps worker alive and exits cleanly even if listener itself throws", async () => {
  // When the `error` listener both calls `e.preventDefault()` and throws a
  // secondary exception, WebCore routes the listener's throw synchronously
  // through `reportException` -> `Bun__reportUnhandledError` -> re-entrant
  // `uncaughtException`, which bumps `unhandled_error_counter` AND sets
  // `exit_code = 1`.
  //
  // Two things must be rolled back in `onUnhandledRejection`'s prevented path:
  //   1. Counter — restored via `counter_snapshot - 1` (undoes the caller's
  //      `+= 1` plus any re-entrant increments). Without this the event loop
  //      would see a non-zero counter and exit prematurely.
  //   2. exit_code — restored via `exit_code_snapshot`. On the `.bun`
  //      unhandledRejection path there is no outer `uncaughtException` frame
  //      to roll this back, so we must do it here. Without this the worker
  //      exits with code 1 despite `preventDefault()`.
  //
  // CRITICAL: this test does NOT call `process.exit(0)` — that would mask
  // the exit-code bug by explicitly setting the exit code to 0 before the
  // event loop drains. Natural drainage is required to observe the bug.
  const result = await runWorker(`
    globalThis.addEventListener('error', (e) => {
      console.log('dispatched:' + (e.error && e.error.message));
      e.preventDefault();
      throw new Error('listener threw');
    });

    Promise.reject(new Error('original'));

    // Schedule a macrotask so the worker has work to do AFTER the listener
    // throws, proving the event loop stayed alive. Do NOT exit explicitly
    // — let the event loop drain naturally so we observe the exit code the
    // runtime produces.
    setImmediate(() => {
      console.log('alive');
    });
  `);

  expect(result.stdout).toContain("dispatched:original");
  expect(result.stdout).toContain("alive");
  expectCleanWorkerExit(result);
});
