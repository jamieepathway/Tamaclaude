/**
 * What the host believes about the link, as a value.
 *
 * The transport in `panel.ts` is unavoidably imperative — it opens ports,
 * writes bytes and sets timers. Everything it *decides* is here instead, as
 * pure folds over an immutable state: whether the panel's contents are
 * accounted for, whether the device has been lost, whether the firmware is one
 * we can talk to at all. That split is what lets the interesting behaviour be
 * tested without a board, and it is the same shape `packages/daemon` uses for
 * the session registry.
 */

import type { Counters, DeviceReport } from './report.js';
import type { Rect } from '@tamaclaude/protocol';

import { lostGround, NO_COUNTERS } from './report.js';

export type PanelSize = {
  readonly width: number;
  readonly height: number;
};

/**
 * `offline` and `online` are both ordinary. `refused` is not: it means the
 * device on the other end cannot be driven by this host at all, and no amount
 * of reconnecting will change that.
 */
type LinkPhase = 'offline' | 'online' | 'refused';

/**
 * What a sender needs to know before each frame, and nothing else.
 *
 * This is the whole of the transport's outward report, deliberately small
 * enough to read on every tick.
 */
export type LinkStatus = {
  readonly phase: LinkPhase;
  /**
   * Does the device hold pixels this host cannot account for?
   *
   * True before the first frame, after every reconnect, and after any loss the
   * firmware reports. **The sender must answer it with the frame it is
   * currently on, not the frame it started with.** Sending frame 0 while the
   * diff sequence carries on from wherever it had got to makes every
   * subsequent update `frame[n] - frame[n-1]` applied to a panel showing
   * frame 0, and the error compounds — measured at 120 of 300 ticks wrong,
   * visible on the panel as a stripe of one animation hanging over another.
   * `tools/blit.test.ts` holds that as a regression test.
   */
  readonly needsPrime: boolean;
  /** Why the link was refused, when it was. */
  readonly refusal?: string;
};

export type LinkState = LinkStatus & {
  /**
   * Is this refusal the kind a physical replug fixes?
   *
   * `refused` carries two unrelated things. A wedge is about the board's
   * *state*, and unplugging it clears that. A firmware/panel mismatch is about
   * what is *flashed*, and the next open finds exactly the same one. Only the
   * first may ever be cleared by `afterReplug`, and conflating them would turn
   * the mismatch refusal back into the re-priming loop it exists to end.
   */
  readonly wedged: boolean;
  readonly counters: Counters;
  /** The tail of a status line that arrived split across two reads. */
  readonly pending: string;
  /** The panel this host renders for, which the device has to agree with. */
  readonly panel: PanelSize;
};

/** A link to a device that is not there yet. */
export function newLink(panel: PanelSize): LinkState {
  return {
    phase: 'offline',
    wedged: false,
    // Nothing has ever been drawn, so everything is unaccounted for.
    needsPrime: true,
    counters: NO_COUNTERS,
    pending: '',
    panel,
  };
}

/** Just the part a sender should see. */
export function statusOf(state: LinkState): LinkStatus {
  const { phase, needsPrime, refusal } = state;
  return refusal === undefined
    ? { phase, needsPrime }
    : { phase, needsPrime, refusal };
}

/**
 * The port is open.
 *
 * Counters go back to zero because the board does: opening the port toggles
 * DTR/RTS and the USB-Serial/JTAG peripheral reboots the chip, which is the
 * same mechanism esptool uses to enter the bootloader. Carrying the old
 * counters across would make the device's first honest report look like a
 * reset — which it is, but one we caused and already know about, and treating
 * it as news would cost a re-prime we are about to do anyway.
 */
export function afterOpen(state: LinkState): LinkState {
  if (state.phase === 'refused') return state;
  return {
    ...state,
    phase: 'online',
    needsPrime: true,
    counters: NO_COUNTERS,
    pending: '',
  };
}

/**
 * The port is gone — unplugged, or the kernel dropped it.
 *
 * A refused link stays refused. It closed its own port on purpose and must not
 * be talked into reconnecting by the close it asked for.
 */
export function afterClose(state: LinkState): LinkState {
  if (state.phase === 'refused') return state;
  return { ...state, phase: 'offline', needsPrime: true };
}

/**
 * Refuse to drive a device whose firmware was built for another panel.
 *
 * The check is on the geometry rather than on the word, for two reasons. This
 * package may import `protocol` and nothing else, so the renderer's
 * `Orientation` is out of reach and would have to be duplicated here to
 * compare against. And the geometry is strictly the stronger test: it catches
 * a firmware built for a different display as well as one built the other way
 * up, where the word would pass. The word still goes in the message, because
 * `PANEL_LANDSCAPE` is what somebody has to change.
 */
function refusalFor(
  panel: PanelSize,
  report: DeviceReport,
): string | undefined {
  if (report.width === panel.width && report.height === panel.height) {
    return undefined;
  }
  return (
    `firmware is built for a ${report.width}x${report.height} ` +
    `${report.orientation} panel, and this host is sending ` +
    `${panel.width}x${panel.height}. Every packet fails the device's bounds ` +
    'check, so nothing would be drawn and nothing would say why. Rebuild ' +
    'with PANEL_LANDSCAPE in ' +
    'packages/device/firmware/blitter/main/main.c, or render the other ' +
    'orientation.'
  );
}

/**
 * Refuse the link because a write took too long to be believed.
 *
 * **The reason this is absorbing changed on 2026-09-06, and the new one is
 * better evidenced than the old one.** It used to be that a blocked `write(2)`
 * could not be taken back, so every reopen cost a threadpool thread and an fd
 * until `fs.open` stopped completing anywhere in the process. `serial.ts`
 * §WRITE_RETRY_MS removed that: the fd is `O_NONBLOCK`, nothing parks, and a
 * reopen is cheap. On that reasoning alone this refusal should have become an
 * ordinary reconnect, and a change doing exactly that was written and then
 * withdrawn.
 *
 * What settled it was watching the real failure. A genuine wedge on the
 * non-blocking fd, twice within three minutes: the daemon refused, a
 * supervisor restarted it, it reopened the port, reported `panel online`, and
 * wedged again immediately. Reopening does not reset a board that has stopped
 * accepting data. The thing that does is a physical replug, and until one
 * happens every reconnect is a wasted cycle that ends here again.
 *
 * So this stays absorbing, for a reason that is now about the *device* rather
 * than about the host's threadpool. The cost is real and worth naming: after
 * the person does unplug the panel, this state does not notice, and the daemon
 * has to be restarted before the healthy board is used. Retrying when the
 * device instance *changes* — which is what a replug looks like from here, and
 * what the watchdog already discriminates on — would close that, and is the
 * obvious next change rather than one this comment should pretend it made.
 */
export function afterWedge(state: LinkState): LinkState {
  if (state.phase === 'refused') return state;
  return {
    ...state,
    phase: 'refused',
    wedged: true,
    needsPrime: true,
    refusal:
      'the panel stopped accepting data — unplug it from the hub, plug it ' +
      'back in, and restart the daemon. Retrying in software does not help: ' +
      'reopening the port does not reset a board in this state, which was ' +
      'measured rather than assumed.',
  };
}

/**
 * A new panel is on the end of the cable: take back a wedge refusal.
 *
 * The narrow counterpart to `afterWedge`, and narrow on purpose. It clears
 * only a refusal that `wedged` marked, so a firmware/panel mismatch survives a
 * replug exactly as it survives everything else — the board that comes back is
 * running the same firmware that was wrong before.
 *
 * `needsPrime` because the device on the other end is, as far as this host is
 * concerned, a stranger: it has been power-cycled, it is showing its boot
 * splash, and nothing this host believes about its pixels is true any more.
 */
export function afterReplug(state: LinkState): LinkState {
  if (!state.wedged) return state;
  return {
    ...state,
    phase: 'offline',
    wedged: false,
    needsPrime: true,
    refusal: undefined,
  };
}

/**
 * Fold in one status line from the device.
 *
 * This is the only place the host ever learns it has been wrong. Nothing else
 * on this link comes back.
 */
export function afterReport(state: LinkState, report: DeviceReport): LinkState {
  if (state.phase === 'refused') return state;
  const refusal = refusalFor(state.panel, report);
  if (refusal) return { ...state, phase: 'refused', refusal };
  return {
    ...state,
    counters: report,
    needsPrime: state.needsPrime || lostGround(state.counters, report),
  };
}

/**
 * Assume the worst, on a schedule.
 *
 * The counters cover every loss the firmware can see. They do not cover the
 * one it cannot: if its receive ring overflows, IDF's ISR discards the bytes
 * without checking, so a packet vanishes with no resync and no abort and
 * nothing on either side ever says so. The panel then holds a stale frame with
 * fragments on it until somebody unplugs the board.
 *
 * A whole frame every few seconds costs about 1.5 KB — 0.05% of a link
 * measured at 562.5 KB/s — and turns that silent divergence into something
 * that heals itself. It is the same debt as a reported loss and gets the same
 * answer, which is why it is the same flag rather than a second one.
 */
export function afterRefresh(state: LinkState): LinkState {
  return state.phase === 'online' ? { ...state, needsPrime: true } : state;
}

/**
 * A rectangle reached the device.
 *
 * A whole-panel write accounts for every pixel on the glass, so it — and only
 * it — settles the prime debt. Deriving that from the rectangle rather than
 * from a separate call at least means nobody can *declare* a prime that was
 * not one.
 *
 * **It does not check that the prime carried the right frame, and it cannot.**
 * The frame a sender is on is the sender's knowledge; the transport sees
 * rectangles. `tools/blit.ts` learned this on hardware: re-priming with frame
 * 0 while the diff sequence carried on from wherever it had reached left every
 * later update painting onto the wrong base, measured at 120 of 300 ticks
 * wrong, and it reached the panel before anyone saw it. A review caught this
 * doc comment claiming the mechanism ruled that out.
 *
 * So it is an obligation on the caller, stated on `Transport.send`. When a
 * caller finally exists, the durable fix is to move diffing inside the
 * transport — then the current frame is the only frame it has, and the rule
 * enforces itself.
 */
export function afterWrite(state: LinkState, rect: Rect): LinkState {
  // The phase test is not redundant. A write can complete at the same moment
  // the cable comes out — the bytes reached the kernel, the read stream had
  // already reported the port gone — and settling the debt on the way down
  // would leave the reconnected panel owing nothing while showing the splash.
  if (state.phase !== 'online' || !state.needsPrime) return state;
  const whole =
    rect.x === 0 &&
    rect.y === 0 &&
    rect.width === state.panel.width &&
    rect.height === state.panel.height;
  return whole ? { ...state, needsPrime: false } : state;
}
