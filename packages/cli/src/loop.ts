/**
 * The render loop, and nothing else.
 *
 * **Its own module for the reason `midnight.ts` gives**: `max-lines` put
 * `daemon.ts` two lines over 300 when quiet hours landed, and "a file with no
 * room for a thing is telling you where the thing goes". The loop is what came
 * out, because it is the piece with no dependency on the panel's contents — it
 * knows when to draw and what to say about the link, and nothing about pixels,
 * packs or sessions.
 */
import type { LinkStatus, openPanel } from '@tamaclaude/device';
import type { Frame } from '@tamaclaude/protocol';

/** What a person would want said about the link, right now. */
function linkLine(status: LinkStatus): string {
  // The refusal first, because it is the one that needs a person. The phase is
  // worth saying either way: "offline" with no explanation is what an unplugged
  // cable looks like, and so is a wrong firmware build.
  return status.refusal ?? `panel ${status.phase}`;
}

type Painting = {
  readonly transport: ReturnType<typeof openPanel>;
  readonly report: (line: string) => void;
  readonly frameMs: number;
  readonly aborted: () => boolean;
  readonly paint: (previous: Frame | undefined) => Promise<Frame | undefined>;
};

/**
 * Paint, say anything worth saying, then schedule the next one from the timer.
 *
 * **Scheduling from the timer rather than awaiting is the difference between
 * this and a memory leak.** Written as `return loop(...)` inside an `async`
 * function, every iteration awaits the next, so the promise chain never unwinds
 * and each frame permanently adds a suspended context.
 *
 * **State the tick rate with any figure here.** The retention is per *frame*,
 * about 83 bytes of it, so a measurement is meaningless without one — and the
 * first version of this comment gave "8.06 -> 9.41 MB over eighteen seconds"
 * (taken at `frameMs: 0`, the fastest tick the loop allows) next to "63 MB a
 * day at 8fps", which are the same defect described at rates two orders apart.
 * A reviewer who tried to reproduce the eighteen-second figure at 8fps saw
 * nothing, which is the worst outcome a measured claim can have.
 *
 * So: 83 bytes a frame, which is ~57 MB a day at the shipping 8fps, in a
 * process `BUILD_PLAN.md` intends to run under launchd. Handing the
 * continuation to `setTimeout` lets each iteration settle and start the next
 * from a fresh context — 0.035 MB over sixty seconds at `frameMs: 0`, flat.
 *
 * Both pieces of state — the frame on the glass and the last thing said about
 * the link — are passed forward rather than held. Note that avoiding a `let`
 * was never the point: `docs/CONVENTIONS.md` §"Holding mutable state" specifies
 * a budget of one disable, not a clean sheet, and reading it as a purity score
 * is what produced the leak in the first place. This shape happens to need
 * neither.
 */
export async function painting(
  ctx: Painting,
  previous?: Frame,
  said?: string,
): Promise<void> {
  if (ctx.aborted()) return;
  const line = linkLine(ctx.transport.status());
  if (line !== said) ctx.report(line);
  // A frame that fails is one frame, and the panel is repainted eight times a
  // second. `openPanel` already survives an unplugged device, so there is
  // nothing here worth stopping the daemon over — but it must carry on from the
  // frame it last *sent*, which on a failure is the one before.
  const shown = await ctx.paint(previous).catch(() => previous);
  setTimeout(() => {
    void painting(ctx, shown, line);
  }, ctx.frameMs).unref();
}
