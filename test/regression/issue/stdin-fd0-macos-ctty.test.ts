import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { spawnSync } from "node:child_process";

/**
 * Regression test for the macOS-specific `process.stdin` keystroke delivery
 * bug that bites compiled-binary Bun apps launched via the
 * `curl | bash` → `exec bin </dev/tty` installer pattern.
 *
 * Symptom (pre-fix): on macOS, a Bun process whose fd 0 was a pipe at
 * `exec()` time and then redirected to `/dev/tty` via shell redirection
 * has `process.stdin.isTTY === true` and accepts `setRawMode(true)`, but
 * no `data` events are ever delivered to listeners. Clack/Ink-style TUIs
 * hang on their first prompt.
 *
 * Root cause: `open_as_nonblocking_tty` in `src/bun.js/bindings/c-bindings.cpp`
 * reopened the inherited fd by calling `ttyname_r(fd)` + `open(pathbuf, O_NOCTTY)`.
 * On XNU the resulting slave-path fd has kqueue `EVFILT_READ` wiring that
 * does not fire events when registered from a non-session-leader process
 * (see https://nathancraddock.com/blog/macos-dev-tty-polling/, Bun#24158,
 * Bun#26792).
 *
 * Fix: when `fd` is our controlling terminal, open `/dev/tty` directly
 * instead of via `ttyname_r`. This routes through the kernel's cttydev
 * lookup and produces an fd with working kqueue wiring.
 *
 * Skipped on Windows (no `/dev/tty`, no `pty.fork`) and when `python3` +
 * the `pty` module aren't available. The test uses a Python PTY harness
 * to mirror the exact shell flow.
 */

test("process.stdin delivers data events after exec bin </dev/tty (inherited ctty fd)", async () => {
  if (process.platform === "win32") {
    // No /dev/tty on Windows.
    return;
  }

  // `python3 -c 'import pty'` must work for the harness. Most macOS and
  // Linux CI runners ship Python; skip cleanly if it's absent so the
  // test isn't spuriously fragile.
  const pythonProbe = spawnSync("python3", ["-c", "import pty, os"], {
    stdio: "ignore",
  });
  if (pythonProbe.status !== 0) {
    return;
  }

  // A minimal Bun program that attaches a `data` listener to
  // `process.stdin` and exits on the first keystroke. Stock Bun on
  // macOS NEVER reaches the 'got:' print because the kqueue filter
  // never fires; the harness times out and the test fails.
  const childProgram = `
    process.stdout.write("ready\\n");
    process.stdin.setRawMode(true);
    process.stdin.on("data", chunk => {
      process.stdout.write("got:" + chunk.toString("hex") + "\\n");
      process.exit(0);
    });
  `;

  using dir = tempDir("stdin-fd0-macos-ctty", {
    "child.js": childProgram,
  });
  const childPath = `${dir}/child.js`;
  const bunPath = bunExe();

  // Python PTY harness:
  //   1. Fork under a PTY (so the child has a controlling terminal).
  //   2. In the child, dup a pipe onto fd 0 BEFORE exec — this mirrors
  //      `curl | bash`, where fd 0 starts as the pipe from curl.
  //   3. Exec bash to `exec bin child.js </dev/tty` — this is literally
  //      what install.sh does before invoking the CLI.
  //   4. In the parent, wait for "ready", then write "Y\\n" to the
  //      master side and assert the child echoes "got:5910" (59 = 'Y',
  //      10 = '\\n') within 3 seconds.
  const harness = `
import os, pty, sys, select, time

BUN = ${JSON.stringify(bunPath)}
SCRIPT = ${JSON.stringify(childPath)}

pid, master_fd = pty.fork()
if pid == 0:
    # Child. Simulate curl | bash: fd 0 is the read end of a pipe at exec time.
    r, w = os.pipe()
    os.dup2(r, 0)
    os.close(r)
    os.close(w)
    # Now exec bash which does `exec bin script.js </dev/tty` — the
    # redirect re-opens fd 0 as the controlling terminal just before
    # handing off to bin.
    os.execvp("bash", [
        "bash", "-c",
        f'exec "{BUN}" "{SCRIPT}" </dev/tty'
    ])

# Parent: wait for "ready", send a keystroke, read response.
deadline = time.monotonic() + 4.0
saw_ready = False
output = b""
wrote_input = False

while time.monotonic() < deadline:
    timeout = max(0.0, deadline - time.monotonic())
    r, _, _ = select.select([master_fd], [], [], timeout)
    if master_fd in r:
        try:
            chunk = os.read(master_fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        if not saw_ready and b"ready" in output:
            saw_ready = True
        if saw_ready and not wrote_input:
            os.write(master_fd, b"Y\\n")
            wrote_input = True
        if b"got:" in output:
            break

# Clean up the child if it's still running.
try:
    os.kill(pid, 9)
except OSError:
    pass
try:
    os.waitpid(pid, 0)
except OSError:
    pass

sys.stdout.buffer.write(output)
sys.stdout.flush()
# Exit 0 if the keystroke round-tripped; non-zero if we timed out.
sys.exit(0 if b"got:" in output else 1)
`;

  const result = spawnSync("python3", ["-c", harness], {
    encoding: "utf-8",
    timeout: 10_000,
    env: bunEnv,
  });

  // Useful diagnostic when the assertion below fails.
  if (result.status !== 0 || !result.stdout.includes("got:")) {
    console.error("harness exit code:", result.status);
    console.error("harness stdout:", result.stdout);
    console.error("harness stderr:", result.stderr);
  }

  expect(result.stdout).toContain("ready");
  // `Y\\n` is 0x59 0x0a. We assert exactly that sequence made it to the
  // child's data listener.
  expect(result.stdout).toContain("got:590a");
});
