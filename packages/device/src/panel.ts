/**
 * The panel, over USB-CDC.
 *
 * A `Transport` that survives the cable being pulled, because it will be: this
 * sits on a desk and somebody unplugs it mid-session. Losing the panel must
 * never take the daemon with it, so nothing here throws for a missing device —
 * `send` drops the bytes, `status()` says the link is offline, and a
 * supervisor keeps trying the port until it comes back. A daemon that dies
 * with its display is worse than no daemon, because the hooks keep firing into
 * nothing.
 *
 * The decisions all live in `link.ts` as pure folds, the serial calls in
 * `serial.ts` behind a fake-able seam, and the single piece of mutable state
 * in `cell.ts`. What is left here is the wiring: when to open, when to give
 * up, and how to get a whole packet onto the wire.
 */

import type { Cell } from './cell.js';
import type { LinkState, LinkStatus, PanelSize } from './link.js';
import type { SerialPort, SerialSystem } from './serial.js';
import type { Transport } from './transport.js';
import type { Encoded, Rect } from '@tamaclaude/protocol';

import { writeRectHeader } from '@tamaclaude/protocol';

import { cell } from './cell.js';
import {
  afterClose,
  afterOpen,
  afterRefresh,
  afterReport,
  afterWedge,
  afterWrite,
  newLink,
  statusOf,
} from './link.js';
import { parseReport, splitLines } from './report.js';
import { nodeSerial } from './serial.js';

/**
 * How long to wait before trying the port again.
 *
 * An absent device fails at `stty` in microseconds, so this is the whole cost
 * of the retry: one second of latency between plugging the panel in and
 * seeing it light up, against one process spawn per second while it is not
 * there. Both are the right way round for something that spends most of its
 * life connected.
 */
const RETRY_MS = 1000;

/** How often to owe a whole frame anyway. See `afterRefresh`. */
const REFRESH_MS = 5000;

/**
 * How long shutdown waits for a write in flight before letting the port go.
 *
 * Draining first is right: tearing the port out from under a half-written
 * packet is the corruption this file is arranged to avoid. Draining *without a
 * bound* was not. `serial.ts` §openPort records the device state that makes it
 * matter — "a device whose tx buffer fills stops servicing its rx path" — and a
 * write to a panel in that state neither returns nor throws, so `close()` never
 * returned either and a restart hung on the failure the panel is most likely to
 * be in.
 *
 * `packages/daemon`'s listener made this call explicitly and the other way, for
 * the same reason: "a peer holding one open is not a reason for a restart to
 * hang". This is that, for the wire.
 *
 * Be precise about what it buys, because an earlier version of this paragraph
 * was not. It bounds `close()`. It does not on its own guarantee the process
 * leaves: a review measured the real shape — a genuinely blocked `write(2)` in
 * libuv's threadpool — and found that `FileHandle.close()`, which `serial.ts`
 * awaits, also never resolves, and that the process survives even
 * `process.exit(0)`.
 *
 * `serial.ts` §WRITE_RETRY_MS has since taken the parked thread out of that
 * account: the fd is `O_NONBLOCK`, so no *write* sleeps in the kernel. Two
 * things that reads like a fix for are not fixed. `raw` still shells out to
 * `stty`, which opens the device itself and can park on a port something else
 * wedged. And whether `close(2)` on a serial tty drains pending output before
 * returning is not established here — if it does, this bound is still the only
 * thing standing between a stalled panel and a shutdown that waits on it.
 * What the bound removes remains what it always did: the daemon waiting on a
 * promise that will never settle.
 *
 * A quarter second is comfortably longer than a real frame and far shorter
 * than a person waiting for a daemon to come back. "Comfortably" rather than
 * "far": `docs/ARCHITECTURE.md` puts the link at 562.5 KB/s and a full-screen
 * prime at 110,080 bytes, which is 191ms — so this is 1.3x the worst
 * *legitimate* write, not orders above it. Real art compresses 24:1 to 203:1
 * — `bouldering` to `permission-sign` in `docs/ARCHITECTURE.md` — for a worst
 * measured frame of 3,008 bytes, so nothing near that is sent today, and the
 * number is right for the wrong reason if you only think about steady-state
 * frames.
 *
 * That bracket read "37:1 to 148:1" until 2026-09-06, which was true when it
 * was written and drifted as animations landed: 37:1 is now the second-worst
 * rather than the worst, and 148:1 was never in the table at all. The
 * conclusion held throughout, which is exactly why nobody noticed.
 *
 * The frame is genuinely lost, not deferred — `close()` clears the refresh
 * interval before it calls this, so there is no next refresh for this
 * transport. What repaints is the *next run*: `afterOpen` sets `needsPrime`, so
 * the daemon that comes back owes a whole frame anyway. An earlier version of
 * this paragraph credited the refresh, which by then no longer exists.
 *
 * The abandoned write is also abandoned as a promise. `Transport.send`
 * documents that awaiting it is the backpressure, and the caller awaiting one
 * that was dropped here waits for ever. Nothing in the daemon does that today —
 * the composition that would is Stage 3's `daemon` command, and it should
 * `void` a send it is not prepared to outlive.
 */
const SHUTDOWN_DRAIN_MS = 250;

/**
 * How long one frame may sit in `write(2)` before the link is treated as lost.
 *
 * Generous against a real frame — `docs/ARCHITECTURE.md` puts a full-screen
 * prime at 191ms on a 562.5 KB/s link, and a dirty rect at a fraction of that —
 * and short against a person waiting for the panel to come back. Longer than
 * `SHUTDOWN_DRAIN_MS` on purpose: shutdown may abandon a frame that this would
 * still be waiting on, and the way out should never be the slower path.
 */
const WRITE_TIMEOUT_MS = 1000;

export type PanelOptions = {
  /** The serial device, e.g. `/dev/cu.usbmodem1101`. */
  readonly path: string;
  /** The panel this host renders for. The device has to agree — see `link.ts`. */
  readonly panel: PanelSize;
  /** Told whenever what a sender can see about the link changes. */
  readonly onChange?: (status: LinkStatus) => void;
  /** Injected by tests. Defaults to the real thing. */
  readonly serial?: SerialSystem;
  readonly retryMs?: number;
  readonly refreshMs?: number;
  /**
   * Consecutive failed opens before this stops trying. Unbounded by default.
   *
   * **For the moved-port case, which is otherwise silent forever.** macOS
   * derives `/dev/cu.usbmodem1101` from the USB port, so plugging the panel
   * into the socket next to the old one changes its path. This loop would
   * retry the dead path once a second for as long as the process lived, the
   * glass would hold the last frame it was sent, and nothing anywhere would be
   * red. A desk move produces it.
   *
   * The answer is not rediscovery in here — that would mean this package
   * choosing which port to open, which is the caller's job and a design
   * change. It is to give up, so the caller can exit and be restarted by
   * whatever supervises it, and start again with a fresh look at the bus.
   *
   * Unbounded remains the default because `tamaclaude daemon` typed by hand
   * should not exit under a person watching the terminal.
   */
  readonly giveUpAfter?: number;
  /** Called once when `giveUpAfter` consecutive opens have failed. */
  readonly onGiveUp?: () => void;
};

type Runtime = {
  readonly link: LinkState;
  readonly port?: SerialPort;
  /**
   * The tail of the write chain.
   *
   * Two `send` calls that overlap would interleave their bytes, and a packet
   * cut in half by another packet is precisely the corruption the firmware
   * recovers from by discarding. Chaining costs nothing at 8fps and makes that
   * unreachable regardless of how the caller drives us.
   */
  readonly queue: Promise<void>;
  readonly retry?: NodeJS.Timeout;
  readonly stopped: boolean;
  /** Consecutive failed opens. Reset by a successful one, not accumulated. */
  readonly failures: number;
};

type Ctx = {
  readonly path: string;
  readonly serial: SerialSystem;
  readonly retryMs: number;
  readonly giveUpAfter?: number;
  readonly onGiveUp?: () => void;
  readonly announce: (status: LinkStatus) => void;
  readonly state: Cell<Runtime>;
};

// ── State ─────────────────────────────────────────────────────────

function changed(before: LinkStatus, after: LinkStatus): boolean {
  return (
    before.phase !== after.phase ||
    before.needsPrime !== after.needsPrime ||
    before.refusal !== after.refusal
  );
}

/** Adopt a new link state, and tell the caller if it can see the difference. */
function commit(ctx: Ctx, link: LinkState): void {
  const before = statusOf(ctx.state.read().link);
  ctx.state.write({ ...ctx.state.read(), link });
  const after = statusOf(link);
  if (!changed(before, after)) return;
  try {
    ctx.announce(after);
  } catch {
    // A listener that throws is the listener's problem. This is called from
    // inside `attempt`'s try block and from a stream event handler, so letting
    // it through would either open a second port on top of a working one or
    // take the daemon down from a `console.log` — neither of which has
    // anything to do with the link.
  }
}

// ── The port ──────────────────────────────────────────────────────

/** Close the port without arranging for another one. */
function shutPort(ctx: Ctx): void {
  const now = ctx.state.read();
  ctx.state.write({ ...now, port: undefined });
  if (now.port) void now.port.close().catch(() => undefined);
}

/** Refuse the link because a write wedged, and let the port go. */
function wedgedOut(ctx: Ctx): void {
  commit(ctx, afterWedge(ctx.state.read().link));
  shutPort(ctx);
}

function scheduleRetry(ctx: Ctx): void {
  const now = ctx.state.read();
  // A refused link is not waiting for a better moment: the firmware is flashed
  // and the next open finds the same one. Retrying would be the re-priming
  // into the void that the refusal exists to end.
  if (now.stopped || now.retry || now.link.phase === 'refused') return;
  // Given up: the path is not coming back, and something above us is better
  // placed to work out what changed than this loop is.
  if (ctx.giveUpAfter !== undefined && now.failures >= ctx.giveUpAfter) {
    ctx.onGiveUp?.();
    return;
  }
  const retry = setTimeout(() => {
    ctx.state.write({ ...ctx.state.read(), retry: undefined });
    void attempt(ctx);
  }, ctx.retryMs);
  // Never hold the process open for a panel that is not there. The daemon has
  // its own reasons to live and this is not one of them.
  retry.unref();
  ctx.state.write({ ...ctx.state.read(), retry });
}

/**
 * The port is gone.
 *
 * Reached from a failed write and from the read stream ending, which is what
 * makes an unplug visible even during a long still frame. A port raises this
 * at most once and ports are opened strictly one at a time, so there is no
 * risk of a dead port's news arriving after its successor is up.
 */
function dropped(ctx: Ctx): void {
  const now = ctx.state.read();
  if (now.stopped || !now.port) return;
  shutPort(ctx);
  commit(ctx, afterClose(now.link));
  scheduleRetry(ctx);
}

async function attempt(ctx: Ctx): Promise<void> {
  if (ctx.state.read().stopped) return;
  try {
    const port = await ctx.serial.open(ctx.path, {
      onData: (chunk) => {
        receive(ctx, chunk);
      },
      onClosed: () => {
        dropped(ctx);
      },
    });
    // Opening takes a second and a half, and `close()` can land inside it.
    if (ctx.state.read().stopped) {
      await port.close().catch(() => undefined);
      return;
    }
    ctx.state.write({ ...ctx.state.read(), port, failures: 0 });
    commit(ctx, afterOpen(ctx.state.read().link));
  } catch {
    // Absent is an ordinary state for a desk toy, not an error. The reason is
    // deliberately not logged: it would be the same line once a second for as
    // long as the panel is unplugged.
    const failed = ctx.state.read();
    ctx.state.write({ ...failed, failures: failed.failures + 1 });
    scheduleRetry(ctx);
  }
}

// ── Listening ─────────────────────────────────────────────────────

function absorbLine(link: LinkState, line: string): LinkState {
  const report = parseReport(line);
  return report ? afterReport(link, report) : link;
}

/**
 * Fold in whatever the device just said.
 *
 * Decoded as latin1 rather than utf8 on purpose: this is a byte stream that
 * happens to carry ASCII, and a multi-byte decoder split across two reads —
 * or handed noise from a resynchronising line — invents replacement
 * characters in the middle of a status line. Every byte maps to one character
 * this way, and the ASCII is identical.
 */
function receive(ctx: Ctx, chunk: Uint8Array): void {
  const now = ctx.state.read();
  const text = Buffer.from(chunk).toString('latin1');
  const split = splitLines(now.link.pending, text);
  const link = split.lines.reduce((state, line) => absorbLine(state, line), {
    ...now.link,
    pending: split.pending,
  });
  commit(ctx, link);
  // Nothing this host sends will ever be drawn, and every packet it sends
  // costs the device a resynchronisation. Stop talking to it.
  if (link.phase === 'refused') shutPort(ctx);
}

// ── Writing ───────────────────────────────────────────────────────

/**
 * Header and payload in one buffer, so one packet is one write.
 *
 * There is no sync word in this protocol, so a packet split across writes is
 * not wrong — the firmware reads a byte stream — but keeping them together
 * removes one way for a partial write to leave a header stranded.
 */
function packet(rect: Rect, encoded: Encoded): Uint8Array {
  const header = writeRectHeader(
    rect,
    encoded.payload.byteLength,
    encoded.mode,
  );
  return Buffer.concat([header, encoded.payload]);
}

/**
 * Write every byte, however many syscalls that takes.
 *
 * A short write is the one corruption this program could cause on its own: the
 * firmware reads a header, finds the next header's bytes where it expected
 * payload, and resynchronises by discarding — a dropped frame with no visible
 * cause on either side.
 */
async function writeWhole(
  port: SerialPort,
  bytes: Uint8Array,
  from = 0,
): Promise<void> {
  const wrote = await port.write(bytes.subarray(from));
  if (wrote <= 0) throw new Error('the port stopped accepting bytes');
  if (from + wrote < bytes.byteLength) {
    await writeWhole(port, bytes, from + wrote);
  }
}

async function transmit(ctx: Ctx, rect: Rect, encoded: Encoded): Promise<void> {
  const now = ctx.state.read();
  if (!now.port || now.link.phase !== 'online') return;
  try {
    const wrote = await Promise.race([
      writeWhole(now.port, packet(rect, encoded)).then(() => true),
      wedged(),
    ]);
    if (!wrote) {
      // Not a lost frame — a lost *panel*. Refuse once, loudly, and let a
      // person do the one thing that works.
      //
      // **The reason is no longer the one this comment gave for a day.** It
      // said the write could not be taken back, so each retry cost a
      // threadpool thread and an fd — and cited `afterWedge`, which by then
      // had been rewritten to retract exactly that. `serial.ts`
      // §WRITE_RETRY_MS made the fd non-blocking: nothing parks and a reopen
      // is cheap. The citation survived the commit that falsified it and
      // pointed, for a day, straight at its own refutation.
      //
      // What keeps this absorbing is about the board rather than the host.
      // Reopening was watched not to bring a wedged panel back — see
      // `afterWedge` for what that observation does and does not establish —
      // and `serial.ts` §raw is the residual cost of trying: `stty` opens the
      // device itself and parks on a wedged port.
      wedgedOut(ctx);
      return;
    }
  } catch {
    dropped(ctx);
    return;
  }
  commit(ctx, afterWrite(ctx.state.read().link, rect));
}

/**
 * Resolves `false` if a write has taken long enough to count as wedged.
 *
 * **A write that never settles used to end the link for the life of the
 * process.** `serial.ts` §openPort records the device state — a panel whose tx
 * buffer fills stops servicing its rx path — and a `write(2)` to it in libuv's
 * threadpool neither returns nor throws. Every later frame then queued behind
 * it forever, because `send` chains on `queue`. Measured: unplugging the wedged
 * panel and plugging in a healthy one delivered **zero** frames to the new
 * port, while the daemon went on reporting the link online.
 *
 * `SHUTDOWN_DRAIN_MS` already bounded this on the way out; it needed bounding
 * on the way through as well, and for the same reason. A frame abandoned here
 * is one frame — the panel is repainted eight times a second and the reopened
 * link owes a whole one anyway.
 */
function wedged(): Promise<false> {
  return new Promise((done) => {
    setTimeout(() => {
      done(false);
    }, WRITE_TIMEOUT_MS).unref();
  });
}

function send(ctx: Ctx, rect: Rect, encoded: Encoded): Promise<void> {
  // Tested here, where the frame is accepted, rather than in `transmit`, where
  // it runs. A frame handed over before `close()` still goes out; one handed
  // over afterwards is dropped. Testing it in `transmit` conflates the two,
  // because the queue defers by a microtask and `close()` lands in between —
  // which showed up as a shutdown that abandoned the frame it was meant to be
  // waiting for.
  if (ctx.state.read().stopped) return Promise.resolve();
  const queued = ctx.state
    .read()
    .queue.then(() => transmit(ctx, rect, encoded));
  ctx.state.write({
    ...ctx.state.read(),
    queue: queued.catch(() => undefined),
  });
  return queued;
}

// ── Shutdown ──────────────────────────────────────────────────────

async function shutdown(ctx: Ctx): Promise<void> {
  const now = ctx.state.read();
  if (now.retry) clearTimeout(now.retry);
  ctx.state.write({ ...now, stopped: true, retry: undefined });
  // Let anything mid-write finish first. Tearing the port out from under a
  // half-written packet is the corruption this file is arranged to avoid, and
  // doing it on the way out would be no less real — but a wedged panel never
  // finishes, so the wait is bounded. See `SHUTDOWN_DRAIN_MS`.
  await Promise.race([
    now.queue.catch(() => undefined),
    new Promise<void>((done) => {
      // Unref'd: a shutdown already under way must not be the thing keeping
      // the process alive.
      setTimeout(done, SHUTDOWN_DRAIN_MS).unref();
    }),
  ]);
  shutPort(ctx);
}

// ── Opening ───────────────────────────────────────────────────────

/**
 * Start driving a panel, whether or not one is plugged in.
 *
 * Returns immediately and connects in the background, because the daemon must
 * come up either way — a transport that awaited its device would make the
 * panel a startup dependency of the session pipeline, which is the coupling
 * this design exists to avoid.
 */
export function openPanel(options: PanelOptions): Transport {
  const ctx: Ctx = {
    path: options.path,
    serial: options.serial ?? nodeSerial(),
    retryMs: options.retryMs ?? RETRY_MS,
    giveUpAfter: options.giveUpAfter,
    onGiveUp: options.onGiveUp,
    announce: options.onChange ?? (() => undefined),
    state: cell<Runtime>({
      link: newLink(options.panel),
      queue: Promise.resolve(),
      stopped: false,
      failures: 0,
    }),
  };
  const refresh = setInterval(() => {
    commit(ctx, afterRefresh(ctx.state.read().link));
  }, options.refreshMs ?? REFRESH_MS);
  refresh.unref();
  void attempt(ctx);
  return {
    send: (region, encoded) => send(ctx, region, encoded),
    status: () => statusOf(ctx.state.read().link),
    close: async () => {
      clearInterval(refresh);
      await shutdown(ctx);
    },
  };
}
