import type { DeviceReport } from './report.js';

import { describe, expect, it } from 'vitest';

import {
  afterClose,
  afterOpen,
  afterReport,
  afterWrite,
  newLink,
  statusOf,
} from './link.js';

const LANDSCAPE = { width: 320, height: 172 };
const WHOLE = { x: 0, y: 0, ...LANDSCAPE };

function report(extra: Partial<DeviceReport> = {}): DeviceReport {
  return {
    rects: 1,
    resyncs: 0,
    dropped: 0,
    aborts: 0,
    width: 320,
    height: 172,
    orientation: 'landscape',
    ...extra,
  };
}

/** An online link that has been primed and has heard one healthy report. */
function settled() {
  return afterWrite(afterOpen(newLink(LANDSCAPE)), WHOLE);
}

describe('a new link', () => {
  it('starts offline and owing a whole frame', () => {
    expect(statusOf(newLink(LANDSCAPE))).toEqual({
      phase: 'offline',
      needsPrime: true,
    });
  });
});

describe('opening and losing the port', () => {
  it('comes online owing a whole frame, because the board just rebooted', () => {
    expect(statusOf(afterOpen(newLink(LANDSCAPE)))).toEqual({
      phase: 'online',
      needsPrime: true,
    });
  });

  it('owes a whole frame again after the panel is unplugged', () => {
    const back = afterOpen(afterClose(settled()));
    expect(statusOf(back)).toEqual({ phase: 'online', needsPrime: true });
  });

  it('forgets the counters across a reconnect', () => {
    // Otherwise the reconnected board's first report — starting from zero
    // because it rebooted when we opened the port — reads as a fresh loss.
    const busy = afterReport(settled(), report({ rects: 900 }));
    const back = afterOpen(afterClose(busy));
    expect(afterReport(back, report({ rects: 1 })).needsPrime).toBe(true);
    expect(afterReport(back, report({ rects: 5 })).counters.rects).toBe(5);
  });
});

describe('priming', () => {
  it('is settled by a whole-panel rectangle', () => {
    expect(afterWrite(afterOpen(newLink(LANDSCAPE)), WHOLE).needsPrime).toBe(
      false,
    );
  });

  it('is not settled by a frame that lands as the cable comes out', () => {
    // The bytes reached the kernel and the read stream had already reported
    // the port gone. Settling the debt on the way down would leave the
    // reconnected panel owing nothing while it showed the boot splash.
    const going = afterClose(afterOpen(newLink(LANDSCAPE)));
    expect(afterWrite(going, WHOLE).needsPrime).toBe(true);
  });

  it('is not settled by a rectangle that leaves pixels unaccounted for', () => {
    const online = afterOpen(newLink(LANDSCAPE));
    const partial = { x: 0, y: 0, width: 320, height: 100 };
    expect(afterWrite(online, partial).needsPrime).toBe(true);
    expect(afterWrite(online, { ...WHOLE, x: 1 }).needsPrime).toBe(true);
  });
});

describe('hearing from the device', () => {
  it('leaves a healthy link alone as the rect count climbs', () => {
    const heard = afterReport(settled(), report({ rects: 400 }));
    expect(statusOf(heard)).toEqual({ phase: 'online', needsPrime: false });
  });

  it('owes a whole frame the moment a packet is destroyed', () => {
    const heard = afterReport(settled(), report({ resyncs: 1 }));
    expect(heard.needsPrime).toBe(true);
  });

  it('owes a whole frame when the device resets under it', () => {
    const busy = afterReport(settled(), report({ rects: 900 }));
    expect(busy.needsPrime).toBe(false);
    expect(afterReport(busy, report({ rects: 2 })).needsPrime).toBe(true);
  });

  it('refuses a firmware built for the other orientation', () => {
    const heard = afterReport(
      settled(),
      report({ width: 172, height: 320, orientation: 'portrait' }),
    );
    expect(heard.phase).toBe('refused');
    // The message has to name the fix, because the symptom names nothing: a
    // mismatched device fails every bounds check and draws nothing at all.
    expect(heard.refusal).toContain('172x320 portrait');
    expect(heard.refusal).toContain('320x172');
    expect(heard.refusal).toContain('PANEL_LANDSCAPE');
  });

  it('stays refused through a reconnect', () => {
    // Reconnecting cannot help: the firmware is flashed and will not change
    // between one open and the next. A transport that kept retrying would sit
    // there re-priming into the void, which is the exact failure the check
    // exists to end.
    const refused = afterReport(
      settled(),
      report({ width: 172, height: 320, orientation: 'portrait' }),
    );
    expect(afterOpen(afterClose(refused)).phase).toBe('refused');
    expect(afterReport(refused, report()).phase).toBe('refused');
  });
});
