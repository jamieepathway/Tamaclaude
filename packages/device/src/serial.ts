/**
 * The host's serial stack, behind a seam narrow enough to fake.
 *
 * Everything in this file needs a board plugged into a Mac, which is exactly
 * why it is separated from the transport that uses it: `panel.ts` holds the
 * behaviour worth testing — reconnection, whole-packet writes, refusing a
 * mismatched firmware — and gets a fake `SerialSystem` in its tests, while
 * this file holds the three facts about a real `/dev/cu.*` device that no test
 * without hardware could establish anyway.
 *
 * The seam is deliberately lower-level than "send a packet". `write` reports
 * how many bytes the port took rather than looping until they have all gone,
 * so that the *whole-packet* loop lives in `panel.ts` where a fake can
 * short-write on purpose. A short write is this program's one opportunity to
 * corrupt the stream by itself, and it would be a shame for the code that
 * prevents it to be the code that cannot be tested.
 *
 * **The fd is non-blocking, and that is the whole point of this file.** See
 * `WRITE_RETRY_MS` for what a blocking one did to the host.
 *
 * Be honest about what that cost the arrangement above, because the paragraph
 * before it used to say this file held only "`stty`, `open` and a timer". It
 * no longer does. A non-blocking fd needs an `EAGAIN` retry under the write
 * and a poll loop under the read, both of them real logic, both of them here,
 * and neither covered by a test — `write` cannot report a refusal upwards
 * without `writeWhole` reading it as the port dying. The seam did not move and
 * everything it was drawn to protect is still on the `panel.ts` side; what
 * grew is the untested remainder, and it grew on purpose.
 */

import type { FileHandle } from 'node:fs/promises';

import { execFile } from 'node:child_process';
import { constants, open } from 'node:fs/promises';
import { promisify } from 'node:util';

import { cell } from './cell.js';

/**
 * How long to wait after opening the port before writing anything.
 *
 * Opening the port resets the board: the USB-Serial/JTAG peripheral reboots it
 * on the DTR/RTS transition, the same mechanism esptool uses to enter the
 * bootloader. Anything written before it finishes booting is simply gone.
 *
 * That is not hypothetical. The first landscape run wrote its clear and its
 * priming frame immediately, the device reported receiving one rect rather
 * than two, and the boot splash then survived everywhere the surviving packet
 * did not paint — a blue panel with a stray border on it, from a race at
 * startup. A C6 reaches app_main in roughly 300ms; a second and a half is
 * generous and is paid once per connect.
 */
const BOOT_SETTLE_MS = 1500;

/**
 * How long to wait before retrying a write the port would not take.
 *
 * **This constant exists because a blocking fd could take the whole Mac
 * down.** With `open(path, 'r+')` — no `O_NONBLOCK` — a `write(2)` to a panel
 * that has stopped draining parks in the kernel uninterruptibly. What follows
 * was measured on 2026-09-05, not reasoned about:
 *
 * - The parked thread cannot be signalled. `SIGTERM` is ignored and `SIGKILL`
 *   leaves an unreapable `?E` process.
 * - The wedged driver instance stays acquired, so a later `open(2)` that lands
 *   on *that* instance parks too — including `O_NONBLOCK` ones, and including
 *   `stty`'s. Seven processes were stuck this way at once, one of them an
 *   unrelated agent session that merely touched the port. Scope it to the
 *   instance rather than the path: a replug that re-enumerates on a new minor
 *   opens fine at the same path while the old holder is still stuck, which is
 *   why `kickstart` sometimes appears to fix this and sometimes does nothing.
 * - launchd counts the undead pid as running, so `KeepAlive` never fires, and
 *   a supervisor that answers with `kickstart -k` manufactures another one.
 * - Nothing in userspace clears it. Only physically unplugging the panel does,
 *   because the release comes from the USB detach tearing the driver down.
 * - macOS shutdown must terminate every process, and two kernel panics were
 *   logged the same day: `watchdog timeout: no checkins from watchdogd in 133
 *   seconds, shutdown in progress`. **Correlation, not established cause** —
 *   `/usr/libexec/airportd` was also observed in uninterruptible sleep, and a
 *   stuck WiFi daemon would block shutdown identically. The experiment that
 *   would settle it is a reboot with zero stuck processes present, and it has
 *   not been run. Treat this as the motivating suspicion, not a measurement.
 *
 * `O_NONBLOCK` removes the disease rather than treating it: the syscall
 * returns `EAGAIN` instead of sleeping, so no write ever parks a thread, and a
 * port this package opened is always closeable.
 *
 * Not "always killable", which an earlier draft of this paragraph claimed and
 * `raw` below disproves eighty lines later: `stty` opens the device itself and
 * can still park on a port something else wedged. What is bounded here is the
 * write path, which is the one that wedges ports in the first place.
 *
 * Two milliseconds, and the number is measured. Writing a 16KB buffer flat out
 * at each strategy, over five seconds each, against this panel:
 *
 * | backoff        | throughput  | CPU   |
 * | -------------- | ----------- | ----- |
 * | tight spin     | 581.2 KB/s  | 99.8% |
 * | `setImmediate` | 579.9 KB/s  | 97.4% |
 * | 1ms            | 564.3 KB/s  | 11.6% |
 * | 2ms            | 562.5 KB/s  |  8.9% |
 *
 * Retrying without a delay costs a whole core to buy 3% more throughput, which
 * is the wrong trade for a desk toy.
 *
 * Read the table as a *controlled comparison*, not as four absolute figures.
 * All four ran in one session against one board through one harness, which is
 * what makes the CPU column trustworthy. The absolute numbers move more than
 * the table's own spread: `tools/usb-throughput.ts`, on the same board minutes
 * later and with the same 2ms backoff, measured 580.4 KB/s — 17.9 KB/s above
 * the 562.5 here, and above the tight spin's 581.2 only by rounding. So "2ms
 * costs 3%" is the honest reading of a within-harness comparison, and may well
 * be nothing at all. 562.5 KB/s is also within 0.6 KB/s of the
 * blocking implementation this replaces (563.1 KB/s, measured the same way in
 * the same session) and lands on the figure `docs/ARCHITECTURE.md` carries
 * today — which that file reached by correcting a 700 KB/s guess, so "the
 * documented figure" is a number with a history rather than a constant. The
 * fix is free in the currency the link is budgeted in; it is not to-the-decimal
 * identical, and 0.6 KB/s is three times the spread seen *within* the single
 * run `ARCHITECTURE.md` publishes.
 */
const WRITE_RETRY_MS = 2;

/**
 * How long to wait before asking the port for input again.
 *
 * A non-blocking `read(2)` with nothing to read returns `EAGAIN` immediately,
 * so this is a poll rather than a wait, and the interval is pure overhead
 * spent looking. The device only ever sends occasional status lines, and the
 * one latency this adds that anybody could feel is how quickly an unplug is
 * noticed — 20ms against a panel repainted eight times a second.
 *
 * Deliberately far looser than `WRITE_RETRY_MS`: nothing is queued behind a
 * read, so there is no throughput to lose by being patient.
 */
const READ_POLL_MS = 20;

/** Bytes to ask for per read. Comfortably over one status line. */
const READ_CHUNK = 4096;

export type SerialWatch = {
  /** Bytes the device sent, in whatever chunks USB delivered them. */
  readonly onData: (chunk: Uint8Array) => void;
  /** The port is gone: unplugged, or the kernel dropped it under us. */
  readonly onClosed: () => void;
};

export type SerialPort = {
  /** Write what the port will take now, and report how much that was. */
  write(bytes: Uint8Array): Promise<number>;
  close(): Promise<void>;
};

export type SerialSystem = {
  /** Open `path`, ready to write, with `watch` already draining it. */
  open(path: string, watch: SerialWatch): Promise<SerialPort>;
};

const run = promisify(execFile);

/**
 * Wait, and say whether waiting should hold the process open.
 *
 * **Not a detail, and `.unref()` on both was a bug.** A write that is retrying
 * `EAGAIN` is work in flight and must keep the event loop alive: with both the
 * write retry and the read poll parked in unref'd timers there is nothing
 * ref'd left, and a program whose only other handle is a top-level `await`
 * simply exits — mid-frame, code 13, no error. The daemon happened to survive
 * that because `packages/daemon`'s unix socket listener holds a ref, which is
 * composition luck rather than a design.
 *
 * The read poll is the other way round on purpose. Looking for input that may
 * never come is not a reason for a process to stay alive, and a ref'd 20ms
 * timer would keep one running for as long as the port was open.
 */
const pause = (ms: number, hold = true): Promise<void> =>
  new Promise((done) => {
    const timer = setTimeout(done, ms);
    if (!hold) timer.unref();
  });

/** `EAGAIN` is "not now", every other errno is "not ever". */
function isAgain(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EAGAIN';
}

/**
 * Take the terminal line discipline out of the path.
 *
 * A `/dev/cu.*` device arrives in canonical mode: it buffers by line, expands
 * and translates control characters, and honours flow control. Every one of
 * those corrupts a binary stream, and the corruption looks exactly like a
 * firmware bug from up here — which is how it was first found.
 *
 * `stty -f` is the BSD spelling, so this is macOS-only. That matches where the
 * daemon runs (a launchd agent, per `BUILD_PLAN.md`); a Linux host would need
 * `-F`, and adding that branch before anything can exercise it would be adding
 * an untested path, not portability.
 *
 * **This subprocess is the one call here that can still park, and the caveat
 * is narrower than the first draft of it claimed.** `stty` opens the device
 * itself, and `open(2)` on an already-wedged port blocks whatever flags it is
 * given — measured: a probe printed its "about to open O_RDONLY|O_NONBLOCK"
 * line and never printed the next one. It then sets the line discipline with
 * `tcsetattr(…, TCSADRAIN, …)`, which waits for the output queue to empty, and
 * on a board that has stopped accepting data that queue cannot empty. Neither
 * half is bounded and neither is interruptible.
 *
 * **It is not only inferred: three of these were watched parked at once.** A
 * review objected that no probe records `stty` hanging, which is right about
 * the probe transcripts — every one of them ran `stty` against a *healthy*
 * port and every one logged `stty ok`. What is not in those files is the
 * incident itself, where `ps` showed pids 2366, 2591 and 2900 sitting in state
 * `U`, each of them `stty -f /dev/cu.usbmodem11401 raw -echo -crtscts`, each
 * spawned by a daemon a supervisor had just restarted into the wedged port,
 * and none of them ever reaped.
 *
 * The same review noted those daemons ran the blocking build, which is true —
 * they predate `WRITE_RETRY_MS` by half an hour — and does not weaken the
 * point. `stty` is a separate process running the system binary against the
 * device node; what flags *this* file passes to `open` has no bearing on it.
 * The hazard is a property of the port, and it outlived the fix.
 *
 * That draft argued it was safe because "it can only park on a port some other
 * process wedged, and this package no longer wedges ports". The second clause
 * is true and the first does not follow from it: a Variant-B wedge starts at
 * the *board*, so the port can be unusable with no process at fault, and this
 * call runs at the top of every `openPort`. It is left as it is because the
 * caller does not currently reconnect into a wedge — `link.ts` §afterWedge
 * refuses the link instead — and not because the call is safe. Anything that
 * changes that refusal has to deal with this first. The alternative is a
 * native `tcsetattr` to get `TCSANOW`, which Node does not expose.
 */
async function raw(path: string): Promise<void> {
  try {
    await run('stty', ['-f', path, 'raw', '-echo', '-crtscts']);
  } catch (error) {
    // `execFile` attaches its entire result to the error — status, pid, and
    // stdout and stderr as printed byte arrays. The daemon logs this on every
    // failed reconnect, once a second, for as long as the panel is unplugged.
    throw new Error(`${path} is not there, or is not a serial port`, {
      cause: error,
    });
  }
}

/**
 * Drain the device's output, and notice when it stops existing.
 *
 * A poll loop rather than a stream, because `FileHandle.createReadStream` does
 * not tolerate a non-blocking fd: it surfaces the first `EAGAIN` as a stream
 * error and stops, which on this device happens immediately and always. That
 * is measured — the stream delivered zero bytes and errored `EAGAIN` on a
 * healthy panel — and it is the one thing `O_NONBLOCK` costs us.
 */
function watchHandle(handle: FileHandle, watch: SerialWatch): () => void {
  const buffer = Buffer.allocUnsafe(READ_CHUNK);
  // `cell` rather than a `let`: `functional/no-let` is on in this package and
  // `cell.ts` is deliberately the only disable in it, audited by
  // `tools/disable-budget.test.ts`.
  const listening = cell(true);

  void (async () => {
    while (listening.read()) {
      try {
        const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, null);
        if (!listening.read()) return;
        if (bytesRead > 0) {
          // Copied, because the next read reuses this buffer and the caller is
          // under no obligation to have finished with the last one.
          watch.onData(new Uint8Array(buffer.subarray(0, bytesRead)));
          continue;
        }
        // Zero is end of file, not "nothing yet" — "nothing yet" on a
        // non-blocking fd is `EAGAIN`, which arrives as a throw. The stream
        // this loop replaces reported the same condition as `close`, and
        // treating it as an idle tick would poll a dead port for ever without
        // ever telling anybody. Not observed on this hardware (a probe saw
        // 344,977 `EAGAIN` and zero short reads across three seconds), so this
        // is the branch that keeps the promise `SerialWatch.onClosed` makes
        // rather than one with a measurement behind it.
        listening.write(false);
        watch.onClosed();
        return;
      } catch (error) {
        if (!listening.read()) return;
        if (!isAgain(error)) {
          // Anything that is not "nothing to read yet" is the port going away
          // — `ENXIO` on an unplug, `EBADF` if it was closed under us.
          listening.write(false);
          watch.onClosed();
          return;
        }
      }
      await pause(READ_POLL_MS, false);
    }
  })();

  return () => {
    listening.write(false);
  };
}

/**
 * The real thing: `stty`, `open`, wait out the reboot, start reading.
 *
 * Draining matters as much as writing. The firmware reports over this same CDC
 * endpoint, and a device whose tx buffer fills stops servicing its rx path —
 * which arrives here as a link that mysteriously slows down. Reading is also
 * the only way its counters are ever seen.
 */
async function openPort(path: string, watch: SerialWatch): Promise<SerialPort> {
  await raw(path);
  const handle = await open(path, constants.O_RDWR | constants.O_NONBLOCK);
  await new Promise((done) => setTimeout(done, BOOT_SETTLE_MS));
  // Reading starts after the settle, not before it. A stream opened first
  // would be free to report the port gone while this function was still
  // sleeping, handing the caller a closure for a port it had not been given
  // yet — and the caller would then be reconnecting and connecting at once.
  const stop = watchHandle(handle, watch);
  const shut = cell(false);
  return {
    /**
     * Retry `EAGAIN` until the port takes something, and report how much.
     *
     * The retry has to be here rather than in `panel.ts` — the natural home
     * for a loop — because `writeWhole` reads a zero-byte write as the port
     * dying, and on this fd a refused write is the ordinary case rather than a
     * fatal one. Returning 0 would drop the link thousands of times a second.
     *
     * Unbounded on purpose, and safe in a way the blocking version was not:
     * `panel.ts` races every write against `WRITE_TIMEOUT_MS` and abandons the
     * promise, and a loop of timers is genuinely abandonable where a parked
     * thread never was. `shut` is what stops the abandoned one, so a panel
     * that never drains costs a closed port rather than a leaked core.
     */
    write: async (bytes) => {
      for (;;) {
        if (shut.read()) return 0;
        try {
          return (await handle.write(bytes, 0, bytes.byteLength)).bytesWritten;
        } catch (error) {
          if (!isAgain(error)) throw error;
          await pause(WRITE_RETRY_MS);
        }
      }
    },
    close: async () => {
      // Reader before handle: the loop holds the fd and would read from a
      // closed one on its next tick, turning an ordinary shutdown into an
      // `EBADF` that looks like the port failing.
      shut.write(true);
      stop();
      await handle.close().catch(() => undefined);
    },
  };
}

/** The host's real serial stack. */
export function nodeSerial(): SerialSystem {
  return { open: openPort };
}
