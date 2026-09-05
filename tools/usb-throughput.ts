/**
 * Drive the host side of the USB-CDC throughput spike.
 *
 * `docs/ARCHITECTURE.md` used to state its compression figures as a percentage
 * of a 700 KB/s floor — a conservative guess at what a 12 Mbps full-speed link
 * yields after protocol overhead, which nothing had ever observed. This
 * measures it.
 *
 * What it measures is what *this firmware* sustains, which is not the same as
 * what the link can carry. The result sits at roughly 47% of the theoretical
 * full-speed bulk ceiling (19 transactions x 64 B per 1 ms frame), so the
 * binding constraint is more likely the device's read path than the wire.
 * That makes the number a sound conservative floor to plan against and a poor
 * basis for claiming the link is saturated.
 *
 *   node tools/usb-throughput.ts [port] [seconds] [chunkBytes]
 *
 * The third argument is what makes the write-size sweep in
 * `docs/ARCHITECTURE.md` reproducible; `pnpm throughput:sweep` runs it.
 *
 * Pair it with `packages/device/firmware/throughput`, which must be flashed
 * first. That firmware reads and discards, reporting `RX <bytes> <us> <total>`
 * once a second; this writes as fast as the port accepts and reconciles the
 * two sides at the end.
 *
 * Both numbers are reported on purpose. The host's own write rate is the
 * optimistic one — a write that lands in a kernel buffer counts as sent — and
 * on a link that cannot keep up it measures the buffer rather than the wire.
 * The device's count is the honest one. When they agree, the figure is real;
 * when they diverge, the gap is exactly the backlog the daemon would have to
 * absorb, which is worth knowing before it is discovered at 8fps.
 */
import type { FileHandle } from 'node:fs/promises';

import { execFileSync } from 'node:child_process';
import { constants, open } from 'node:fs/promises';
import process from 'node:process';

/** Bytes per write. A round 4 KB, and the sweep below shows the choice does
 *  not matter: throughput is flat from 256 B to 64 KB, so this is a default
 *  rather than a tuning decision. */
const DEFAULT_CHUNK_BYTES = 4096;

/** Default measurement window. Long enough for the rate to settle past USB
 *  enumeration and any initial buffering, short enough to iterate on. */
const DEFAULT_SECONDS = 10;

type Report = { bytes: number; micros: number; total: number };

/** Parse one `RX <bytes> <us> <total>` line from the device. */
function parseReport(line: string): Report | undefined {
  const match = /^RX (\d+) (\d+) (\d+)$/.exec(line.trim());
  if (!match) return undefined;
  return {
    bytes: Number(match[1]),
    micros: Number(match[2]),
    total: Number(match[3]),
  };
}

function human(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
}

type Measurement = {
  written: number;
  elapsed: number;
  reports: Report[];
  windowsWhileWriting: number;
};

/**
 * Collect the device's status lines until told to stop.
 *
 * Split out of `measure` to keep it under its line limit, and a poll loop
 * rather than `createReadStream`, which surfaces the first `EAGAIN` as a
 * stream error and stops — immediately, and always, on a non-blocking fd.
 */
async function collectReports(
  handle: FileHandle,
  reports: Report[],
  listening: () => boolean,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(4096);
  let pending = '';
  while (listening()) {
    let read = 0;
    try {
      ({ bytesRead: read } = await handle.read(buffer, 0, buffer.length, null));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') return;
    }
    if (read <= 0) {
      // Ref'd, unlike the daemon's equivalent: this is a measurement run with
      // a definite end, and there is no other handle keeping it alive.
      await new Promise((done) => setTimeout(done, 20));
      continue;
    }
    pending += buffer.subarray(0, read).toString('latin1');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const report = parseReport(line);
      if (report) reports.push(report);
    }
  }
}

/**
 * Write to the port flat out for `seconds`, collecting the device's reports.
 *
 * Reading runs concurrently with writing on purpose. Draining only at the end
 * would let the device's tx buffer fill and stall its read loop, which shows
 * up as a throughput problem entirely of our own making.
 */
async function measure(
  port: string,
  seconds: number,
  chunkBytes: number,
): Promise<Measurement> {
  // Raw mode, or the terminal line discipline gets a vote on our bytes. A
  // /dev/cu.* device arrives in canonical mode: it buffers by line, expands
  // and translates control characters, and honours flow control. Every one of
  // those corrupts a binary stream, and the corruption looks exactly like a
  // slow link from up here.
  execFileSync('stty', ['-f', port, 'raw', '-echo', '-crtscts']);

  // Non-blocking, and not as a detail. `packages/device/src/serial.ts`
  // §WRITE_RETRY_MS records what a blocking fd on this device does when the
  // panel stops draining: the write parks uninterruptibly, the process cannot
  // be killed, a later `open(2)` landing on that same driver instance parks
  // too, and macOS is left with processes it cannot terminate at shutdown —
  // suspected, not shown, to be behind two kernel panics the same day. A tool
  // that measures the link must not be able to take the host down with it, and
  // this one writes flat out at the panel, which is the surest way to find
  // that state.
  //
  // The measurement it exists to make survives the change: retrying `EAGAIN`
  // every 2ms gave 562.5 KB/s against 563.1 KB/s blocking, in one session on
  // one board. No run-to-run spread has ever been published for this tool, so
  // whether 0.6 KB/s is inside it is not something anybody can currently say —
  // the only spread on record is 0.2 KB/s *within* a single run.
  const handle = await open(port, constants.O_RDWR | constants.O_NONBLOCK);
  const payload = Buffer.alloc(chunkBytes, 0xa5);
  const reports: Report[] = [];
  let listening = true;
  const reader = collectReports(handle, reports, () => listening);

  console.log(`writing ${chunkBytes}B chunks to ${port} for ${seconds}s…`);
  let written = 0;
  const start = process.hrtime.bigint();
  const deadline = start + BigInt(seconds) * 1_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    try {
      const { bytesWritten } = await handle.write(payload);
      written += bytesWritten;
    } catch (error) {
      // A refused write is the port being full, not the port being broken.
      // Counted as zero bytes, which is exactly what it moved.
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      await new Promise((done) => setTimeout(done, 2));
    }
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
  // Everything reported from here on describes a link with nothing on it.
  const windowsWhileWriting = reports.length;

  // Let the last report arrive, then stop the reader before closing the
  // handle. The poll loop holds the fd and would read from a closed one on its
  // next tick, discarding the results we came for.
  await new Promise((done) => setTimeout(done, 1500));
  listening = false;
  await reader.catch(() => undefined);
  await handle.close().catch(() => undefined);

  return { written, elapsed, reports, windowsWhileWriting };
}

/** Print both sides and reconcile them. */
function report(result: Measurement, chunkBytes: number): void {
  const hostRate = result.written / result.elapsed;
  console.log(
    `\nhost wrote   ${result.written} bytes in ${result.elapsed.toFixed(2)}s -> ${human(hostRate)}`,
  );
  if (result.reports.length === 0) {
    console.log(
      'device reported nothing — is the throughput firmware flashed?',
    );
    return;
  }

  // Drop the first window, which straddles startup, and everything after the
  // last write. Both trims matter: the run that produced the first real number
  // here averaged in a trailing 133 KB/s window and reported 527 KB/s for a
  // link that had held 562 on every window that was actually loaded.
  const steady = result.reports.slice(1, result.windowsWhileWriting);
  if (steady.length === 0) {
    console.log('no full window under load — try a longer run');
    return;
  }

  const rateOf = (r: Report): number => (r.bytes / r.micros) * 1e6;
  const deviceRate =
    steady.reduce((sum, r) => sum + rateOf(r), 0) / steady.length;
  // Sum this run's windows rather than reading the device's running total,
  // which counts every byte since it booted — a second run on the same flash
  // would otherwise report the sum of both. The first attempt here showed
  // exactly twice what the host had sent, which looks like a discovery until
  // you notice it is too round a number to be one.
  const received = steady.reduce((sum, r) => sum + r.bytes, 0);
  const loaded = steady.reduce((sum, r) => sum + r.micros / 1e6, 0);

  console.log(
    `device saw   ${received} bytes over ${loaded.toFixed(2)}s of load -> ${human(deviceRate)}`,
  );
  console.log(
    `\nper-second: ${steady.map((r) => human(rateOf(r))).join(', ')}`,
  );

  const shortfall = hostRate * loaded - received;
  console.log(
    shortfall > chunkBytes * 4
      ? `\n${Math.round(shortfall)} bytes (${((100 * shortfall) / (hostRate * loaded)).toFixed(1)}%) were ` +
          `written but never arrived — that gap is buffering, and the device rate is the real one.`
      : `\nhost and device agree to within ${Math.abs(hostRate - deviceRate).toFixed(0)} B/s — ` +
          `nothing is queueing between them, so this rate is real rather than a buffer draining. ` +
          `It is what this firmware sustains, not proof the link is saturated.`,
  );
}

async function main(): Promise<void> {
  const port = process.argv[2] ?? '/dev/cu.usbmodem1101';
  const seconds = Number(process.argv[3] ?? DEFAULT_SECONDS);
  const chunkBytes = Number(process.argv[4] ?? DEFAULT_CHUNK_BYTES);
  report(await measure(port, seconds, chunkBytes), chunkBytes);
}

await main();
