/**
 * The serial link to the board, and what the board says back.
 *
 * Split out of `tools/blit.ts` to keep that file under its line limit, but the
 * boundary is real: everything here is about the wire and nothing about
 * pixels. `tools/usb-throughput.ts` opens the same port the same way and would
 * be the next caller.
 */
import type { FileHandle } from 'node:fs/promises';

import { execFileSync } from 'node:child_process';
import { constants, open } from 'node:fs/promises';

/**
 * How long to wait after opening the port before writing anything.
 *
 * See `connect` — the board reboots when the port opens.
 */
const BOOT_SETTLE_MS = 1500;

/**
 * How long to wait before retrying a write the port would not take, and before
 * asking it for input again.
 *
 * These tools open the same port the daemon does, and used to open it the same
 * way it did — blocking. `packages/device/src/serial.ts` §WRITE_RETRY_MS is the
 * full account of why that was dangerous: a `write(2)` to a panel that has
 * stopped draining parks uninterruptibly, the process becomes unkillable, a
 * later `open(2)` landing on that same driver instance parks too, and macOS is
 * left with processes it cannot terminate at shutdown. Two kernel panics were
 * logged the same day; that the wedge caused them is suspected rather than
 * shown. What is not in doubt is that a tool run from a terminal put the host
 * in exactly the same state as the daemon did.
 *
 * The read poll is looser than the write retry for the same reason it is there:
 * nothing is queued behind a read, so there is no throughput to lose.
 */
const WRITE_RETRY_MS = 2;
const READ_POLL_MS = 20;

/** Bytes to ask for per read. Comfortably over one status line. */
const READ_CHUNK = 4096;

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

export type Link = {
  readonly handle: FileHandle;
  readonly close: () => Promise<void>;
  readonly health: Health;
};

/**
 * What the device says about itself, and whether it has lost anything.
 *
 * The firmware reports `# rects N resync A/B abort C` once a second. Any
 * movement in resync or abort means a packet was destroyed, and from that
 * moment every diff sent is being applied to content the device never
 * received — the panel keeps a stale frame with fragments painted onto it and
 * never converges again. `lost` latches that so the sender can re-prime.
 */
type Health = {
  resyncs: number;
  aborts: number;
  lost: boolean;
  /** What the firmware says it was built for, once it has said anything. */
  orientation?: string;
};

// ── The link ──────────────────────────────────────────────────────

/**
 * Read one status line and fold it into what we know about the device.
 *
 * Split out so the reader stays a reader. It also means the parsing has one
 * place to live, which matters more than it looks: the firmware's line is a
 * second wire format that `packages/protocol` does not define, so this is the
 * whole of the contract on our side.
 */
function absorb(text: string, health: Health): void {
  const counters = /resync (\d+)\/\d+ abort (\d+)/.exec(text);
  if (!counters) {
    // A status line we cannot read is worse than none: the recovery it drives
    // would go quiet with nothing to say so, leaving only the periodic timer.
    console.log('  device| (unparsed status line — has the format drifted?)');
    return;
  }
  const resyncs = Number(counters[1]);
  const aborts = Number(counters[2]);
  // Not `>`. A counter that goes *backwards* means the device reset — a
  // brownout, a watchdog, an accidental replug — and its panel is back to the
  // splash with everything the host believes about it now stale. That is the
  // most unambiguous loss signal available, and `>` reads it as nothing
  // having happened.
  if (resyncs !== health.resyncs || aborts !== health.aborts) {
    health.lost = true;
  }
  health.resyncs = resyncs;
  health.aborts = aborts;

  const panel = /panel \d+x\d+ (\w+)/.exec(text);
  if (panel) health.orientation = panel[1];
}

/**
 * The device's output, polled.
 *
 * `FileHandle.createReadStream` cannot be used on a non-blocking fd: it
 * surfaces the first `EAGAIN` as a stream error and stops, which on this
 * device happens immediately and always. An async generator keeps
 * `echoDeviceLines` exactly as it was — it only ever wanted an iterable.
 */
async function* drain(
  handle: FileHandle,
  stopped: () => boolean,
): AsyncGenerator<Buffer> {
  const buffer = Buffer.allocUnsafe(READ_CHUNK);
  while (!stopped()) {
    try {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, null);
      if (bytesRead > 0) {
        // Copied: the next read reuses this buffer.
        yield Buffer.from(buffer.subarray(0, bytesRead));
        continue;
      }
    } catch (error) {
      // Anything that is not "nothing to read yet" is the port going away.
      if (!isAgain(error)) return;
    }
    await pause(READ_POLL_MS, false);
  }
}

/** Print whatever the firmware says, and watch its counters for losses. */
async function echoDeviceLines(
  stream: AsyncIterable<Buffer | string>,
  health: Health,
): Promise<void> {
  let pending = '';
  for await (const block of stream) {
    pending += String(block);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      console.log(`  device| ${text}`);
      if (text.startsWith('#')) absorb(text, health);
    }
  }
}

/**
 * Open the port in raw mode and start draining what the device says.
 *
 * Raw mode first, or the terminal line discipline gets a vote on our bytes: a
 * /dev/cu.* device arrives in canonical mode, buffers by line, expands control
 * characters and honours flow control. Every one of those corrupts a binary
 * stream, and the corruption looks exactly like a firmware bug from up here.
 * `tools/usb-throughput.ts` carries the same call for the same reason.
 *
 * Draining matters as much as writing. The firmware reports its resync count
 * over this same CDC endpoint, and a device whose tx buffer fills stops
 * servicing its rx path — which arrives here as a link that mysteriously slows
 * down. Reading is also the only way the resync count is ever seen.
 */
export async function connect(port: string): Promise<Link> {
  execFileSync('stty', ['-f', port, 'raw', '-echo', '-crtscts']);
  const handle = await open(port, constants.O_RDWR | constants.O_NONBLOCK);
  // Opening the port resets the board — the USB-Serial/JTAG peripheral reboots
  // it on the DTR/RTS transition, the same mechanism esptool uses to enter the
  // bootloader. Anything written before it finishes booting is simply gone.
  //
  // That is not hypothetical: the first landscape run wrote its clear and its
  // priming frame immediately, the device reported having received one rect
  // rather than two, and the splash it drew on boot then survived everywhere
  // the surviving packet did not paint. A blue panel with a stray border on
  // it, from a race at startup.
  //
  // A C6 reaches app_main in roughly 300ms. A second and a half is generous
  // and costs nothing once per run.
  await new Promise((done) => setTimeout(done, BOOT_SETTLE_MS));
  let stopped = false;
  const health: Health = { resyncs: 0, aborts: 0, lost: false };
  const reader = echoDeviceLines(
    drain(handle, () => stopped),
    health,
  );
  const close = async (): Promise<void> => {
    // Reader before handle: the poll loop holds the fd and would read from a
    // closed one on its next tick, turning an ordinary teardown into an
    // `EBADF` that would discard the summary we came for.
    stopped = true;
    await reader.catch(() => undefined);
    await handle.close().catch(() => undefined);
  };
  return { handle, close, health };
}

/**
 * Write a whole packet, however many syscalls that takes.
 *
 * A short write is the one corruption this tool could cause on its own: the
 * firmware would read a header, find the next header's bytes where it expected
 * payload, and resynchronise by discarding — a dropped frame with no visible
 * cause on either side.
 */
export async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    // On a non-blocking fd a refused write is the ordinary case, not a fatal
    // one — the port is simply full. `undefined` is that, and it is spelled as
    // a caught rejection so the success path keeps one `const`.
    const took = await handle
      .write(bytes, written, bytes.byteLength - written)
      .catch((error: unknown) => {
        if (!isAgain(error)) throw error;
        return undefined;
      });
    if (!took) {
      await pause(WRITE_RETRY_MS);
      continue;
    }
    if (took.bytesWritten <= 0) throw new Error('port stopped accepting bytes');
    written += took.bytesWritten;
  }
}
