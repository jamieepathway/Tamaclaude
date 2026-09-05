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
 * so that the loop lives in `panel.ts` where a fake can short-write on purpose.
 * A short write is this program's one opportunity to corrupt the stream by
 * itself, and it would be a shame for the code that prevents it to be the code
 * that cannot be tested.
 *
 * **The fd is non-blocking, and that is the whole point of this file.** See
 * `WRITE_RETRY_MS` for what a blocking one did to the host.
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
 * - The driver port stays acquired, so every *later* `open(2)` on that device
 *   node also parks — including `O_NONBLOCK` ones, and including `stty`'s.
 *   Seven processes were stuck this way at once, one of them an unrelated
 *   editor session that merely touched the port.
 * - launchd counts the undead pid as running, so `KeepAlive` never fires, and
 *   a supervisor that answers with `kickstart -k` manufactures another one.
 * - Nothing in userspace clears it. Only physically unplugging the panel does,
 *   because the release comes from the USB detach tearing the driver down.
 * - macOS shutdown must terminate every process. Two kernel panics were logged
 *   the same day: `watchdog timeout: no checkins from watchdogd in 133
 *   seconds, shutdown in progress`.
 *
 * `O_NONBLOCK` removes the disease rather than treating it: the syscall
 * returns `EAGAIN` instead of sleeping, so no thread is ever parked, the port
 * is always closeable, and the process is always killable.
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
 * is the wrong trade for a desk toy. 562.5 KB/s is also, exactly, both the
 * blocking implementation this replaces (563.1 KB/s measured) and the figure
 * `docs/ARCHITECTURE.md` has always quoted — so the fix is free in the only
 * currency the link is budgeted in.
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

const pause = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms).unref();
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
 * This subprocess is the one call here that can still park, because it opens
 * the device itself and `open(2)` on an already-wedged port blocks whatever
 * flags it is given. It is left as it is on purpose: it can only park on a
 * port some *other* process wedged, and after `WRITE_RETRY_MS` this package no
 * longer wedges ports. Replacing it means a native `tcsetattr`, which is a
 * dependency this repo would rightly refuse for a case it no longer causes.
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
      await pause(READ_POLL_MS);
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
