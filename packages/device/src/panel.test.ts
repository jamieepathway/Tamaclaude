/**
 * The transport, driven against a fake serial port.
 *
 * There is no board in CI and there is usually no board on the desk either, so
 * everything worth getting right here — whole packets, reconnection, refusing
 * a mismatched firmware — is tested through the `SerialSystem` seam. What is
 * left in `serial.ts` is `stty`, `open` and a timer: three facts about a real
 * `/dev/cu.*` device that no test without hardware could establish anyway.
 */
import type { LinkStatus, PanelSize, Transport } from './index.js';
import type { SerialPort, SerialSystem, SerialWatch } from './serial.js';
import type { Encoded, Rect } from '@tamaclaude/protocol';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RAW_MODE,
  readRectHeader,
  RECT_HEADER_BYTES,
} from '@tamaclaude/protocol';

import { openPanel } from './index.js';

const PANEL: PanelSize = { width: 320, height: 172 };
const WHOLE = { x: 0, y: 0, ...PANEL };
const HEALTHY = '# rects 5 resync 0/0 abort 0 panel 320x172 landscape';
const PORTRAIT = '# rects 0 resync 0/3 abort 0 panel 172x320 portrait';

const delay = (ms = 0): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** Let the transport's own promise chain and timers run. */
async function settle(ms = 2): Promise<void> {
  await delay(ms);
  await delay(0);
}

function payload(byte: number, length: number): Encoded {
  return { mode: RAW_MODE, payload: new Uint8Array(length).fill(byte) };
}

/**
 * A port that can be unplugged, made to stutter, and made to talk back.
 *
 * `chunk` is the number of bytes it will accept per write — the short-write
 * behaviour a real `FileHandle` shows and the one thing this program can do to
 * corrupt the stream by itself.
 */
function fakeSerial(chunk = Number.MAX_SAFE_INTEGER) {
  const state = {
    present: true,
    opens: 0,
    closes: 0,
    written: [] as number[],
    watch: undefined as SerialWatch | undefined,
    wedged: false,
  };
  const port: SerialPort = {
    write: async (bytes) => {
      // Never settles. `serial.ts` §openPort records the device state — "a
      // device whose tx buffer fills stops servicing its rx path" — and says
      // its symptom is a link that mysteriously slows down. That a write to a
      // panel in that state never settles at all is this fake's own
      // assumption, not something the note establishes; it is the shape a
      // blocking `FileHandle` write on a wedged CDC endpoint would take, and
      // it is what makes the bound worth having.
      if (state.wedged) return new Promise<number>(() => undefined);
      await delay(0);
      if (!state.present) throw new Error('ENXIO: device not configured');
      const take = Math.min(chunk, bytes.byteLength);
      state.written.push(...bytes.subarray(0, take));
      return take;
    },
    close: async () => {
      state.closes += 1;
    },
  };
  const system: SerialSystem = {
    open: async (_path, watch) => {
      await delay(0);
      if (!state.present) throw new Error('ENOENT: no such file or directory');
      state.opens += 1;
      state.watch = watch;
      return port;
    },
  };
  return {
    state,
    system,
    /** One status line, as the firmware would send it. */
    say: (line: string) => state.watch?.onData(Buffer.from(`${line}\n`)),
    /** Yank the cable: the read stream ends and writes start failing. */
    unplug: () => {
      state.present = false;
      state.watch?.onClosed();
    },
    /** Fill its tx buffer: writes stop settling, and never fail either. */
    wedge: () => {
      state.wedged = true;
    },
    /** Drain it again, so a reopened port behaves. */
    unwedge: () => {
      state.wedged = false;
    },
    /** Yank it without the read stream noticing, so only a write finds out. */
    stall: () => {
      state.present = false;
    },
    plug: () => {
      state.present = true;
    },
  };
}

type Seen = {
  readonly rect: Rect;
  readonly mode: number;
  readonly payload: readonly number[];
};

/**
 * Walk the written bytes the way the firmware walks the stream.
 *
 * `trailing` is what is left over when the last packet does not end where the
 * buffer does — a header stranded without its payload, which is the shape a
 * short write leaves behind and the thing worth asserting is absent.
 */
function packets(written: readonly number[]) {
  const bytes = Uint8Array.from(written);
  const walk = (
    at: number,
    seen: readonly Seen[],
  ): { packets: readonly Seen[]; trailing: number } => {
    if (at + RECT_HEADER_BYTES > bytes.byteLength) {
      return { packets: seen, trailing: bytes.byteLength - at };
    }
    const head = readRectHeader(bytes.subarray(at, at + RECT_HEADER_BYTES));
    const from = at + RECT_HEADER_BYTES;
    const one = {
      rect: head.rect,
      mode: head.mode,
      payload: [...bytes.subarray(from, from + head.payloadLength)],
    };
    return walk(from + head.payloadLength, [...seen, one]);
  };
  return walk(0, []);
}

const opened = new Set<Transport>();

function open(options: Partial<Parameters<typeof openPanel>[0]> = {}) {
  const panel = openPanel({
    path: '/dev/fake',
    panel: PANEL,
    retryMs: 2,
    ...options,
    serial: options.serial ?? fakeSerial().system,
  });
  opened.add(panel);
  return panel;
}

afterEach(async () => {
  await Promise.all([...opened].map((panel) => panel.close()));
  opened.clear();
});

describe('giving up on a path that is not coming back', () => {
  it('stops retrying after the bound and says so once', async () => {
    // **The moved-port failure.** Unplug the panel, plug it into the next USB
    // port along, and macOS gives it a different `/dev/cu.usbmodem*`. The
    // reconnect loop retries the old path once a second forever, the daemon
    // never exits, and the glass keeps showing the last frame it received. It
    // looks like it is working. `tamaclaude pack` answers correctly. Nothing
    // is red — which is the exact failure class this codebase is arranged
    // against, and it recurs on every desk move.
    //
    // The fix is not to teach `panel.ts` to rediscover. It is to let it admit
    // defeat, so the process can exit and the supervisor that installed it can
    // start it again — and starting again is what runs discovery afresh.
    const fake = fakeSerial();
    fake.state.present = false;
    let gaveUp = 0;
    open({
      serial: fake.system,
      retryMs: 1,
      giveUpAfter: 3,
      onGiveUp: () => {
        gaveUp += 1;
      },
    });
    await delay(60);
    expect(gaveUp).toBe(1);
    // Three attempts, and then it stopped — not "slowed down".
    expect(fake.state.opens).toBe(0);
    const attempts = gaveUp;
    await delay(40);
    expect(gaveUp).toBe(attempts);
  });

  it('forgets the failures once the panel answers', async () => {
    // A flaky cable that reconnects must not accumulate its way to a give-up
    // over an evening. The count is *consecutive* failures.
    //
    // **Asserted on which attempt gives up, not on elapsed time.** Three fail,
    // the fourth succeeds and is dropped, then the rest fail. With the reset,
    // the tail starts from zero and give-up lands on attempt 4 + 5 = 9.
    // Without it, the three earlier failures still count and it lands on 6.
    // Two earlier versions of this test used delays instead, and the mutant
    // that removes the reset survived both — the window between the two
    // outcomes was inside the timing noise.
    const fake = fakeSerial();
    let attempts = 0;
    let gaveUpAt = 0;
    const counting: SerialSystem = {
      open: async (path, watch) => {
        attempts += 1;
        fake.state.present = attempts === 4;
        const port = await fake.system.open(path, watch);
        // Dropped immediately, or the loop stops at the success and the tail
        // never runs.
        setTimeout(() => {
          watch.onClosed();
        }, 1);
        return port;
      },
    };
    open({
      serial: counting,
      retryMs: 1,
      giveUpAfter: 5,
      onGiveUp: () => {
        gaveUpAt = attempts;
      },
    });
    await delay(120);
    expect(gaveUpAt).toBe(9);
  });

  it('retries forever when no bound is given', async () => {
    // The default, and what `tamaclaude daemon` typed by hand should do: a
    // person watching the terminal does not want it exiting under them.
    const fake = fakeSerial();
    fake.state.present = false;
    open({ serial: fake.system, retryMs: 1 });
    await delay(40);
    expect(fake.state.opens).toBe(0);
  });
});

describe('with no panel attached', () => {
  it('comes up offline instead of failing', async () => {
    const fake = fakeSerial();
    fake.stall();
    const panel = open({ serial: fake.system });
    await settle(10);
    expect(panel.status()).toEqual({ phase: 'offline', needsPrime: true });
  });

  it('swallows a frame rather than rejecting', async () => {
    // The daemon must not have to know whether the cable is in. This is the
    // whole of decision one: hooks keep firing, and nothing about a missing
    // panel is allowed to reach them.
    const fake = fakeSerial();
    fake.stall();
    const panel = open({ serial: fake.system });
    await settle(10);
    await expect(panel.send(WHOLE, payload(1, 4))).resolves.toBeUndefined();
    expect(fake.state.written).toEqual([]);
  });
});

describe('with a panel attached', () => {
  it('comes online owing a whole frame', async () => {
    const panel = open();
    await settle();
    expect(panel.status()).toEqual({ phase: 'online', needsPrime: true });
  });

  it('gives up rather than spinning when the port accepts nothing', async () => {
    // `writeWhole` recurses on a short write. A port that accepts zero bytes
    // would recurse forever on the same offset, so it throws instead — and
    // that guard had no test, which made it indistinguishable from one that
    // could not fire. A real blocking `FileHandle` does not return 0 for a
    // non-empty buffer; `fakeSerial(0)` is the only way to reach it.
    const fake = fakeSerial(0);
    const panel = open({ serial: fake.system });
    await settle();
    // Still swallowed, per decision one — a dead port must not reach the
    // daemon — but nothing is written and the link stops claiming it is fine.
    await expect(panel.send(WHOLE, payload(1, 4))).resolves.toBeUndefined();
    expect(fake.state.written).toEqual([]);
  });

  it('writes a header and its payload as one packet', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    await panel.send({ x: 8, y: 4, width: 2, height: 3 }, payload(0xa5, 6));
    const seen = packets(fake.state.written);
    expect(seen.trailing).toBe(0);
    expect(seen.packets).toEqual([
      {
        rect: { x: 8, y: 4, width: 2, height: 3 },
        mode: RAW_MODE,
        payload: [0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5],
      },
    ]);
  });

  it('finishes a packet a stuttering port only takes in pieces', async () => {
    // A short write is the one corruption this program can cause on its own.
    // The firmware would read a header, find the next header's bytes where the
    // payload should be, and resynchronise by discarding: a dropped frame with
    // no visible cause on either side. Seven is chosen to divide neither the
    // 16-byte header nor the payload.
    const fake = fakeSerial(7);
    const panel = open({ serial: fake.system });
    await settle();
    await panel.send(WHOLE, payload(0x5a, 40));
    const seen = packets(fake.state.written);
    expect(seen.trailing).toBe(0);
    expect(seen.packets).toHaveLength(1);
    expect(seen.packets[0].payload).toHaveLength(40);
  });

  it('never interleaves two frames sent without awaiting', async () => {
    // A caller that does not await would otherwise have two writes in flight
    // at once, and a packet cut in half by another packet is exactly what the
    // firmware recovers from by throwing both away.
    const fake = fakeSerial(5);
    const panel = open({ serial: fake.system });
    await settle();
    await Promise.all([
      panel.send({ x: 0, y: 0, width: 1, height: 1 }, payload(0x11, 8)),
      panel.send({ x: 1, y: 1, width: 1, height: 1 }, payload(0x22, 8)),
    ]);
    const seen = packets(fake.state.written);
    expect(seen.trailing).toBe(0);
    expect(seen.packets.map((one) => one.payload[0])).toEqual([0x11, 0x22]);
    expect(seen.packets[0].payload.every((byte) => byte === 0x11)).toBe(true);
  });
});

describe('priming', () => {
  it('is settled by a whole-panel frame and nothing less', async () => {
    const panel = open();
    await settle();
    await panel.send({ x: 0, y: 0, width: 320, height: 100 }, payload(1, 4));
    expect(panel.status().needsPrime).toBe(true);
    await panel.send(WHOLE, payload(1, 4));
    expect(panel.status().needsPrime).toBe(false);
  });

  it('is owed again when the device reports a lost packet', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    await panel.send(WHOLE, payload(1, 4));
    fake.say(HEALTHY);
    expect(panel.status().needsPrime).toBe(false);
    fake.say('# rects 9 resync 1/16 abort 0 panel 320x172 landscape');
    expect(panel.status().needsPrime).toBe(true);
  });

  it('is owed again when the device resets under us', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    await panel.send(WHOLE, payload(1, 4));
    fake.say('# rects 900 resync 0/0 abort 0 panel 320x172 landscape');
    expect(panel.status().needsPrime).toBe(false);
    // Every counter back near zero on a board that had never lost anything.
    fake.say('# rects 2 resync 0/0 abort 0 panel 320x172 landscape');
    expect(panel.status().needsPrime).toBe(true);
  });

  it('is owed again periodically, for the loss the firmware cannot see', () => {
    const panel = open({ refreshMs: 5 });
    return settle(20).then(async () => {
      await panel.send(WHOLE, payload(1, 4));
      expect(panel.status().needsPrime).toBe(false);
      await settle(20);
      expect(panel.status().needsPrime).toBe(true);
    });
  });

  it('reassembles a status line split across two reads', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    await panel.send(WHOLE, payload(1, 4));
    fake.state.watch?.onData(Buffer.from('# rects 9 resync 1/16 ab'));
    expect(panel.status().needsPrime).toBe(false);
    fake.state.watch?.onData(Buffer.from('ort 0 panel 320x172 landscape\n'));
    expect(panel.status().needsPrime).toBe(true);
  });
});

describe('losing the panel', () => {
  it('reports it and carries on when the cable is pulled', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    fake.unplug();
    expect(panel.status()).toEqual({ phase: 'offline', needsPrime: true });
    await expect(panel.send(WHOLE, payload(1, 4))).resolves.toBeUndefined();
  });

  it('finds out from a failed write when the reader misses it', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    fake.stall();
    await expect(panel.send(WHOLE, payload(1, 4))).resolves.toBeUndefined();
    expect(panel.status().phase).toBe('offline');
  });

  it('reconnects when the panel comes back, owing a whole frame', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    await panel.send(WHOLE, payload(1, 4));
    expect(panel.status().needsPrime).toBe(false);
    fake.unplug();
    await settle(10);
    fake.plug();
    await settle(20);
    expect(panel.status()).toEqual({ phase: 'online', needsPrime: true });
    expect(fake.state.opens).toBe(2);
  });

  it('announces every change a sender could see', async () => {
    const fake = fakeSerial();
    const seen: LinkStatus[] = [];
    const panel = open({
      serial: fake.system,
      onChange: (status) => seen.push(status),
    });
    await settle();
    await panel.send(WHOLE, payload(1, 4));
    fake.unplug();
    await settle();
    expect(seen).toEqual([
      { phase: 'online', needsPrime: true },
      { phase: 'online', needsPrime: false },
      { phase: 'offline', needsPrime: true },
    ]);
  });
});

describe('a firmware built for the other orientation', () => {
  it('is refused, with a message naming the fix', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    await panel.send(WHOLE, payload(1, 4));
    fake.say(PORTRAIT);
    expect(panel.status().phase).toBe('refused');
    expect(panel.status().refusal).toContain('PANEL_LANDSCAPE');
  });

  it('stops writing, because every packet costs the device a resync', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    fake.say(PORTRAIT);
    const before = fake.state.written.length;
    await panel.send(WHOLE, payload(1, 4));
    expect(fake.state.written.length).toBe(before);
  });

  it('does not reconnect, because the next open finds the same firmware', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    fake.say(PORTRAIT);
    await settle(20);
    expect(fake.state.opens).toBe(1);
    expect(panel.status().phase).toBe('refused');
  });
});

describe('closing', () => {
  it('stops the supervisor, so an unplug no longer reconnects', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    await panel.close();
    fake.unplug();
    fake.plug();
    await settle(20);
    expect(fake.state.opens).toBe(1);
  });

  it('drops a frame offered afterwards', async () => {
    const fake = fakeSerial();
    const panel = open({ serial: fake.system });
    await settle();
    await panel.close();
    await expect(panel.send(WHOLE, payload(1, 4))).resolves.toBeUndefined();
    expect(fake.state.written).toEqual([]);
  });

  it('drops one offered while the last frame is still draining', async () => {
    // The window that matters. `close()` returns only once the queue is empty,
    // and a frame offered inside that wait is chained onto the same promise as
    // the shutdown itself — where it reaches the port first, because the
    // shutdown's `await` is one microtask further back. Refusing at the moment
    // the frame is accepted is what closes it.
    const fake = fakeSerial(3);
    const panel = open({ serial: fake.system });
    await settle();
    const draining = panel.send(WHOLE, payload(0x7f, 24));
    const closing = panel.close();
    const late = panel.send(WHOLE, payload(0x11, 24));
    await Promise.all([draining, closing, late]);
    const seen = packets(fake.state.written);
    expect(seen.trailing).toBe(0);
    expect(seen.packets.map((one) => one.payload[0])).toEqual([0x7f]);
  });

  it('waits for a frame that is still going out', async () => {
    // A packet cut in half on the way out is no less corrupt for being the
    // last one.
    const fake = fakeSerial(3);
    const panel = open({ serial: fake.system });
    await settle();
    const sending = panel.send(WHOLE, payload(0x7f, 24));
    await panel.close();
    await sending;
    const seen = packets(fake.state.written);
    expect(seen.trailing).toBe(0);
    expect(seen.packets[0].payload).toHaveLength(24);
  });
});

describe('a panel that wedges mid-write', () => {
  it('refuses the link and says what a person has to do', async () => {
    // The bound stops a wedged write freezing the panel for ever. What it must
    // *not* do is retry: a `write(2)` blocked in libuv's threadpool cannot be
    // taken back, so each attempt costs a thread and an fd. Measured — four
    // abandoned writes exhaust the default pool, after which `fs.open` never
    // completes anywhere in the process, so the daemon could no longer open the
    // port at all. That is the freeze this bound exists to prevent, reached
    // four retries later and now poisoning everything else too.
    //
    // An earlier version of this test asserted the opposite — that the panel
    // recovered on the next port — which was the behaviour that had that cost.
    const serial = fakeSerial();
    const panel = open({ serial: serial.system, retryMs: 5 });
    await settle();
    serial.say(HEALTHY);
    await settle();
    expect(panel.status().phase).toBe('online');

    serial.wedge();
    void panel.send(WHOLE, payload(1, 4));
    await delay(1_100);

    const status = panel.status();
    expect(status.phase).toBe('refused');
    expect(status.refusal).toMatch(/unplug it and plug it back in/);
  }, 10_000);

  it('does not reopen the port after a wedge, however long it waits', async () => {
    // `refused` is absorbing by design, and this is why it has to be: every
    // reopen would abandon another blocked write.
    const serial = fakeSerial();
    const panel = open({ serial: serial.system, retryMs: 5 });
    await settle();
    serial.say(HEALTHY);
    await settle();

    serial.wedge();
    void panel.send(WHOLE, payload(1, 4));
    await delay(1_100);
    const opens = serial.state.opens;

    serial.unwedge();
    serial.plug();
    await delay(200);
    expect(serial.state.opens).toBe(opens);
  }, 10_000);
});

describe('shutting down a wedged panel', () => {
  it('closes within a bound when a write never settles', async () => {
    // The device state `serial.ts` §openPort documents: "a device whose tx
    // buffer fills stops servicing its rx path". A `write` that then never
    // settles makes `await now.queue` in `shutdown` wait for ever, so `close()`
    // never returns and a daemon restart hangs on the failure the panel is most
    // likely to be in. The daemon made the opposite call explicitly for its own
    // sockets — "a peer holding one open is not a reason for a restart to
    // hang" — and this path had not.
    const serial = fakeSerial();
    const panel = open({ serial: serial.system });
    await settle();
    serial.say(HEALTHY);
    await settle();

    serial.wedge();
    void panel.send(WHOLE, payload(1, 4));
    await settle();

    const raced = await Promise.race([
      panel.close().then(() => 'closed' as const),
      delay(2_000).then(() => 'hung' as const),
    ]);
    expect(raced).toBe('closed');
    // `shutPort` does call close on it. Note what this does *not* prove:
    // `close()` there is fire-and-forget (`void ... .catch()`), so this counts
    // the invocation, not the release — a real port whose own `close()` hangs
    // would satisfy it too.
    expect(serial.state.closes).toBe(1);
  });
});
