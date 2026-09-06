/**
 * Quiet hours: when the panel should be dark although the Mac is awake.
 *
 * The firmware already blanks the backlight after `IDLE_BLANK_MS` of silence,
 * which covers a Mac that sleeps, a daemon that stops and a cable that is
 * pulled. It does not cover the case that prompted this: a Mac kept awake all
 * night — Claude Code holds a power assertion, so `pmset` reports
 * `sleep prevented by powerd, Claude` — with the daemon painting at 8fps into
 * a dark room. The host is the only thing that can decide it should stop.
 *
 * **Not a blackout, and that distinction is the design.** A hard window would
 * have blanked this panel at 01:40 on 6 September, while the person it belongs
 * to was using it. So the window is the default and activity is the override:
 * dark between the hours unless somebody is actually working, and dark again
 * `QUIET_WAKE_MS` after they stop.
 *
 * Nothing here turns the backlight off. It decides whether to *send*, and the
 * firmware's own timeout does the rest — which is why the panel goes dark
 * `IDLE_BLANK_MS` after this starts returning true rather than immediately.
 * Two mechanisms, one behaviour, and the seam between them is silence.
 */

/*
 * ## Carrying the frame across
 *
 * `daemon.ts` §painting skips the *render* while this returns true, not just
 * the send, so no CPU is spent on a frame nobody can see. It carries its
 * `previous` frame forward untouched, and that is correct rather than
 * convenient: the panel's controller still holds the last frame it was sent —
 * the backlight is off, its RAM is not — so when this stops returning true,
 * the ordinary diff against `previous` describes exactly what is on the glass.
 * Priming instead would repaint a picture already there.
 */

/** Minutes since local midnight, `from` inclusive and `to` exclusive. */
export type QuietHours = {
  readonly from: number;
  readonly to: number;
};

/**
 * How long after the last hook event the panel is allowed to go dark.
 *
 * Long enough to read something without the panel dying beside you, short
 * enough that walking away at midnight does not leave it lit. Five minutes is
 * a judgement rather than a measurement, and worth saying so.
 */
export const QUIET_WAKE_MS = 5 * 60 * 1000;

/**
 * `HH:MM-HH:MM`, anchored, with the hour and minute ranges in the pattern.
 *
 * Strict on purpose. A window this misreads is a panel dark at the wrong time
 * with nothing anywhere saying why, and the failure mode of returning
 * `undefined` is the panel behaving exactly as it did before the feature
 * existed — which is the right way round.
 */
const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** Read `TAMACLAUDE_QUIET`, or nothing if it is absent or unreadable. */
export function parseQuietHours(
  spec: string | undefined,
): QuietHours | undefined {
  const found = spec === undefined ? null : WINDOW.exec(spec.trim());
  if (found === null) return undefined;
  const from = Number(found[1]) * 60 + Number(found[2]);
  const to = Number(found[3]) * 60 + Number(found[4]);
  // An empty window is off rather than always-on. `23:00-23:00` is far more
  // likely to be a typo than a request for a permanently dark panel.
  if (from === to) return undefined;
  return { from, to };
}

/**
 * Should the daemon stop sending?
 *
 * **Local time, for the reason `midnight.ts` §isSmallHours gives**: the night
 * somebody is having is the one they are having beside the panel, not the one
 * UTC is having. A test that builds local dates and compares them against a
 * function reading UTC passes by comparing a value with itself.
 */
export function isQuiet(
  hours: QuietHours | undefined,
  now: number,
  lastEventAt: number | undefined,
): boolean {
  if (hours === undefined) return false;
  const clock = new Date(now);
  const minutes = clock.getHours() * 60 + clock.getMinutes();
  // Two shapes, because the interesting window crosses midnight. `23:00-07:00`
  // is `from > to` and matches either side of the wrap; `09:00-17:00` is the
  // ordinary between.
  const inside =
    hours.from < hours.to
      ? minutes >= hours.from && minutes < hours.to
      : minutes >= hours.from || minutes < hours.to;
  if (!inside) return false;
  // Nothing has ever happened: quiet. A daemon that has just started inside
  // the window has nobody to stay lit for.
  if (lastEventAt === undefined) return true;
  return now - lastEventAt >= QUIET_WAKE_MS;
}

/** `23:00`, from minutes since midnight. */
function clockFace(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * The `status` line, or nothing when the feature is off.
 *
 * **This line is the other half of the firmware change.** `main.c` used to
 * carry the rule that "a dark panel still means a fault", and it no longer
 * does — a panel can now be dark because it was asked to be. Somebody looking
 * at a black panel at midnight needs one place that says so, and `status` is
 * the place `docs/INSTALL.md` already sends them.
 *
 * Deliberately says nothing about *activity*: `status` reads launchd and the
 * filesystem rather than talking to the daemon, so it knows the window but not
 * whether somebody typed a minute ago. Claiming "dark now" while the panel is
 * lit for a working session would be worse than the vaguer truth, so the words
 * are about the window being in force, not about the glass.
 */
export function describeQuietHours(
  hours: QuietHours | undefined,
  now: number,
): string | undefined {
  if (hours === undefined) return undefined;
  const window = `${clockFace(hours.from)}-${clockFace(hours.to)}`;
  // Reuses the real predicate rather than re-deriving "inside", by asking it
  // about a moment with no activity — which is the case this line describes.
  const inForce = isQuiet(hours, now, undefined);
  return inForce
    ? `${window} — dark now unless you are working, until ${clockFace(hours.to)}`
    : window;
}

/**
 * The two places this feature meets the environment.
 *
 * Kept together and kept thin. Everything above is pure and tested against
 * fixed clocks; these read `TAMACLAUDE_QUIET` and hand the result straight to
 * it, so the parsing happens once at startup rather than on every frame.
 */

/** The predicate `daemon.ts` asks each frame. Off when the variable is unset. */
export function quietGate(
  spec: string | undefined,
): (now: number, lastEventAt: number | undefined) => boolean {
  const hours = parseQuietHours(spec);
  return (now, lastEventAt) => isQuiet(hours, now, lastEventAt);
}

/** The `status` line, ready to write — empty when the feature is off. */
export function quietStatusLine(spec: string | undefined): string {
  const line = describeQuietHours(parseQuietHours(spec), Date.now());
  return line === undefined ? '' : `quiet     ${line}\n`;
}
