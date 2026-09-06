/**
 * Quiet hours: when the panel should be dark although the Mac is awake.
 *
 * The firmware already blanks the backlight after `IDLE_BLANK_MS` of silence,
 * which covers a Mac that sleeps, a daemon that stops and a cable that is
 * pulled. It does not cover the case that prompted this: a Mac kept awake all
 * night, with the daemon painting at 8fps into a dark room. The host is the
 * only thing that can decide it should stop.
 *
 * `pmset -g` reports `sleep 0 (sleep prevented by powerd, Claude)` on the
 * machine this was written for, and the first version of this comment read
 * that as Claude Code holding the assertion. It is not: `pmset -g assertions`
 * names `pid 1123(Claude): NoIdleSleepAssertion named: "Electron"`, which is
 * the Claude *desktop app*, alongside powerd's own display-on assertion. The
 * CLI holds none. The premise survives — the Mac stays awake — but it stays
 * awake for a reason this feature cannot assume, so the window is a window
 * rather than something clever keyed off sleep.
 *
 * **Not a blackout, and that distinction is the design.** A hard window blanks
 * the panel in the middle of a session for anybody who works past their own
 * bedtime, which is exactly when a desk toy reacting to Claude has something
 * to say. So the window is the default and activity is the override:
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
 * `daemon.ts` §runDaemon's `paint` closure skips the *render* while this
 * returns true, not just the send, so no CPU is spent on a frame nobody can
 * see. It carries its `previous` frame forward untouched.
 *
 * **What actually reaches the glass at 07:00 is a whole frame, not a diff**,
 * and the first version of this paragraph claimed the opposite. `panel.ts`
 * §REFRESH_MS runs `afterRefresh` on a free-running interval that quiet does
 * not stop, `link.ts` §afterRefresh sets `needsPrime` whenever the link is
 * online, and only a whole-panel write clears it — so within five seconds of
 * going quiet the prime debt is set and stays set.
 *
 * That is the right outcome and the reasoning matters, because a future change
 * "optimising away" the redundant prime would be licensed by the old wording
 * and would break the case that makes it necessary: if the board resets during
 * quiet hours it comes back showing its splash, and a diff against `previous`
 * would paint onto a picture that is no longer there. The prime debt is the
 * protection. Carrying `previous` forward is what makes the diff *correct* if
 * one is ever taken; the prime is what makes it *safe* when it is not.
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
  // `undefined` never arrives from the daemon: `registry.ts` types
  // `lastEventAt` as a plain `number` and seeds it at boot — "boot counts as
  // the last thing that happened". It is here for `describeQuietHours`, which
  // asks about the window with no activity in hand at all.
  //
  // The consequence of that seeding is worth naming rather than hiding: a
  // daemon starting fresh at 02:00 with no state file has `now - lastEventAt`
  // of zero, so the panel lights for `QUIET_WAKE_MS` before going dark. Five
  // minutes, once, on a first run or after the state file is cleared. Left
  // alone deliberately — the alternative is treating a boot as inactivity,
  // which would blank the panel for somebody who has just plugged it in.
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
  options: { readonly stale?: boolean } = {},
): string | undefined {
  if (hours === undefined) return undefined;
  const drift =
    options.stale === true
      ? ' (the plist says otherwise — reload it with `install-agent --apply`)'
      : '';
  const window = `${clockFace(hours.from)}-${clockFace(hours.to)}${drift}`;
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

/**
 * The window the *daemon* was given, which three sources answer differently.
 *
 * **`status` first read this process's own `process.env`, and the variable
 * lives in the launchd job**, so it reported nothing while the feature worked.
 * The correction after that read the plist file, which is closer and still
 * wrong: the file is what is *configured*, and the running job is what is *in
 * force*. Those differ exactly when somebody edited the plist without
 * reloading — which, until `install-agent` learned to carry the window, was
 * the only way to set it.
 *
 * So: the running job first. `launchctl print` prints an `environment` block
 * containing it, which `agent.ts` §"What it deliberately does carry" already
 * relies on — "naming them also makes `launchctl print` ground truth rather
 * than a guess". `launchctl list` is the one that omits it, which is what the
 * previous version of this comment was really about.
 *
 * Then the plist, for a job that is not loaded at all, and finally the
 * environment, for a `tamaclaude daemon` run by hand where there is no job in
 * the story.
 */
export function quietSpecIn(sources: {
  readonly running?: string;
  readonly plist?: string;
  readonly env?: string;
}): string | undefined {
  // Anchored on the key in both shapes, so `TAMACLAUDE_PACK` and
  // `TAMACLAUDE_SOCKET` beside it in the same block cannot match.
  const inRunning = /^\s*TAMACLAUDE_QUIET\s*=>\s*(\S+)\s*$/mu.exec(
    sources.running ?? '',
  );
  const inPlist =
    /<key>TAMACLAUDE_QUIET<\/key>\s*<string>([^<]*)<\/string>/u.exec(
      sources.plist ?? '',
    );
  return inRunning?.[1] ?? inPlist?.[1] ?? sources.env;
}

/**
 * Is the file promising something the running job is not doing?
 *
 * Only interesting when both exist and differ. A plist with a window and no
 * running job is not drift, it is a daemon that has not started yet.
 */
function quietIsStale(running?: string, plist?: string): boolean {
  const live = quietSpecIn({ running });
  const filed = quietSpecIn({ plist });
  return live !== undefined && filed !== undefined && live !== filed;
}

/**
 * The `status` line, ready to write — empty when the feature is off.
 *
 * Takes the clock so it can be tested; `status` passes `Date.now()`. The
 * version before this one called it internally and was the only function here
 * without an injectable clock, which a review pointed out was the one
 * composition `status` actually uses.
 */
export function quietStatusLine(
  sources: {
    readonly running?: string;
    readonly plist?: string;
    readonly env?: string;
  },
  now: number,
): string {
  const line = describeQuietHours(parseQuietHours(quietSpecIn(sources)), now, {
    stale: quietIsStale(sources.running, sources.plist),
  });
  return line === undefined ? '' : `quiet     ${line}\n`;
}
