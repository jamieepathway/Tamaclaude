/**
 * The `daemon` command: the one place the packages become a panel.
 *
 * `BUILD_PLAN.md` §Stage 3 carried this as its open exit for the whole stage —
 * "the listener holds the registry and offers a snapshot; nothing yet renders
 * it or pushes a frame down the wire". Every piece existed and was tested in
 * isolation. This is the composition, and it is deliberately the only file in
 * the repo that imports every other workspace package:
 *
 *   socket  ->  registry  ->  resolution  ->  scene  ->  pixels  ->  rect  ->  wire
 *   daemon      daemon        daemon          cli       renderer   protocol   device
 *
 * (`packs` is not on that row but is imported too, sitting under `scene` — the
 * pack is what the renderer draws with. `cli` is on the row and is not an
 * import, because this file *is* `cli`.)
 *
 * Nothing here is clever, and that is the intent — every decision worth making
 * was made in the package that owns it. What lives here is the glue that has no
 * other home: turning a `Resolution` into a `Scene`, and turning consecutive
 * framebuffers into the smallest rectangle that changed.
 */ import type {
  AnimationName,
  createRegistry,
  Session,
  SessionState,
} from '@tamaclaude/daemon';
import type { SerialSystem, Transport } from '@tamaclaude/device';
import type { PackManifest } from '@tamaclaude/packs';
import type { Frame, Rect } from '@tamaclaude/protocol';
import type {
  Scene,
  SessionChip,
  Sprite,
  TimeOfDay,
} from '@tamaclaude/renderer';

import process from 'node:process';

import {
  animationFor,
  effectiveState,
  resolvePanel,
  startSocketServer,
} from '@tamaclaude/daemon';
import { openPanel } from '@tamaclaude/device';
import { isBirthday, parsePackManifest } from '@tamaclaude/packs';
import {
  dirtyRect,
  encodeRect,
  extractRect,
  frame,
} from '@tamaclaude/protocol';
import {
  BIRTHDAY_QR,
  loadSprite,
  panelSize,
  render,
  SPRITE_NAMES,
} from '@tamaclaude/renderer';

import { painting } from './loop.js';
import { messageFor } from './message.js';
import { stageCoverFor } from './midnight.js';

/**
 * How often the panel is recomposed.
 *
 * Eight, because that is what `tools/svg2frames.ts` rasterises at and what the
 * animation timings in `docs/ANIMATION.md` divide into. It is also now the rate
 * Clawd is actually played at — `paintOnce` indexes the current animation by
 * this same constant, so a clock that ticked at some other rate would show a
 * loop at the wrong speed rather than merely disagree with the art.
 */
const FRAME_MS = 125;

/**
 * Which way up the panel is, and **the one line to change when that is
 * decided**.
 *
 * **Decided, not defaulted.** `.claude/research/screens/spec.md` §10a carried
 * this as an open freeze item until Alex closed it on 21 Aug: the device is
 * mounted on its side. `docs/HARDWARE.md` §Orientation already had both the
 * mock and the harness defaulting to landscape, so nothing had to move.
 *
 * A constant rather than an option because landscape is not a rotated portrait
 * layout — the stage as authored is 200px tall against a 172px landscape panel,
 * and 172/25 is 6.88 device pixels per unit, so every motion in every animation
 * would land between pixels. Changing it is an art decision, not a flag.
 *
 * An earlier version of this comment cited `CLAUDE.md`, which says the panel is
 * 172x320 and nothing at all about how it is mounted.
 */
const ORIENTATION = 'landscape';

/**
 * How far the rock pool reaches.
 *
 * `panel`, so the scenery fills the glass rather than sitting in a band behind
 * Clawd with the pack's flat background above and below it. Both extents are
 * built (`ENVIRONMENT_EXTENTS` in the renderer); this picks one, the way
 * `ORIENTATION` above picks one. Picked here on 22 Aug, in the commit that
 * wired the scenery on, and not overturned since — and not at the 25 Aug
 * freeze, whose record covers the screen list, the state machine and the pack
 * format and says nothing about extent.
 *
 * A constant, and not a pack field. A switch was asked for so the owner or the
 * recipient could change it later, and a pack manifest entry is where that
 * would belong — the pack is the personalisation layer.
 *
 * Cut on 25 Aug rather than deferred, and the precedent is the screen spec's
 * timings table, which refused this shape of field outright: schema,
 * validation and tests for knobs nobody will ever turn. Extent is one knob,
 * and its non-default position is the one this line rejected — so the field
 * buys a lever with one useful setting, for an hour of code and a schema
 * entry, 29 days out. `BUILD_PLAN.md`'s deferred table carries the re-entry
 * condition, and `tools/panel-mock.ts --extent stage` draws the rejected side
 * so the judgement can be re-checked by looking rather than by reading this.
 */
const ENVIRONMENT_EXTENT = 'panel';

/**
 * Which screens the pet appears on.
 *
 * The spec puts it on the quiet ones — loafing and asleep — and nowhere else.
 * Total over `AnimationName`, so adding an animation is a type error here
 * rather than a silent `false`.
 */
const PET_APPEARS: Readonly<Record<AnimationName, boolean>> = {
  asleep: true,
  idle: true,
  birthday: false,
  'board-game': false,
  bouldering: false,
  confused: false,
  dizzy: false,
  gym: false,
  overheated: false,
  payoff: false,
  'permission-sign': false,
  sweeping: false,
  thinking: false,
  typing: false,
  wizard: false,
};

export type DaemonOptions = {
  readonly socketPath: string;
  readonly devicePath: string;
  /** Untrusted until `parsePackManifest` has had it. */
  readonly pack: unknown;
  /** Injected by tests. Defaults to the real serial port. */
  readonly serial?: SerialSystem;
  readonly now?: () => number;
  readonly frameMs?: number;
  /** Forwarded to `openPanel`, so a test can reach the refresh prime. */
  readonly refreshMs?: number;
  readonly retryMs?: number;
  /**
   * Consecutive failed opens before the panel stops trying. See `panel.ts`.
   *
   * Set only when something will restart this process, because giving up is
   * only useful if somebody picks it back up. `tamaclaude daemon` typed by
   * hand leaves it unset and retries forever.
   */
  readonly giveUpAfter?: number;
  readonly onGiveUp?: () => void;
  /**
   * Asked each frame; true means send nothing. Built by `quiet.ts`.
   *
   * A predicate rather than a window, so the policy — hours, activity, local
   * time — stays in `quiet.ts` and this file keeps knowing only that some
   * frames are not sent. It is handed the two things it cannot get for itself:
   * this daemon's clock, so a test can move it, and when the registry last saw
   * an event, so somebody working at one in the morning keeps their panel.
   */
  readonly quiet?: (now: number, lastEventAt: number | undefined) => boolean;
  /**
   * Told what the link is doing, in words.
   *
   * Defaults to stderr rather than to nothing. `link.ts` composes a specific,
   * actionable sentence for a firmware/panel mismatch — the single most likely
   * bring-up failure — and before this was wired the daemon computed it and
   * dropped it: writes stopped after the first frame, permanently, and nothing
   * anywhere said why. `panel.ts` never retries a refused link, by design, so
   * silence there is forever.
   */
  readonly report?: (line: string) => void;
};

export type RunningDaemon = {
  readonly stop: () => Promise<void>;
};

/**
 * Which sky the panel is wearing.
 *
 * Here rather than in the renderer for the same reason `clockText` is here:
 * the renderer takes the answer, not the clock. `packages/renderer/src` reads
 * a `Date` nowhere at all, and keeping it that way is what makes a frame a
 * function of its inputs.
 *
 * An earlier version of this argued runtime-neutrality — that a timezone lookup
 * would block `BUILD_PLAN.md` Stage 1's browser-bundle exit. That reasoning was
 * borrowed from `sprites/index.ts`, where it is about `node:buffer` and is
 * true; `Date#getHours` is standard ECMAScript and runs in a browser fine.
 *
 * The boundaries are the ones a person would name looking out of a window,
 * not civil twilight: this is a desk toy, and a rock pool that turns golden at
 * six in the evening is the point. `dawn` and `dusk` get three hours each and
 * `day` gets nine, because the two transitions are what make the panel look
 * like a place rather than a picture, and a nine-hour midday is one flat sky
 * nobody watches change.
 */
function timeOfDay(now: number): TimeOfDay {
  const hour = new Date(now).getHours();
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'dusk';
  return 'night';
}

/** The clock as the status band wants it: 24-hour, no seconds. */
function clockText(now: number): string {
  const at = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Which of the strip's three tones a state reads as.
 *
 * A total `Record` rather than a chain of ternaries, because the chain ended in
 * a default: any state added to `SESSION_STATES` compiled clean and silently
 * became an ordinary working chip. `COMPACTING` arrived on 25 Aug and this
 * table is what made `tsc` ask for its tone instead of defaulting one — the
 * argument working rather than a prediction about it. A future `FAILED`-class
 * state arriving as "nothing to see" would lose exactly the signal the strip
 * exists for. It will not build.
 *
 * The *decision* to collapse lives in `packages/renderer/src/strip.ts`: a pack
 * carries a handful of colours, so spec §5's ten states cannot each have a
 * tint, and the renderer collapsed them to three tones — fewer even than §4's
 * five tiers, which the three mapped onto cleanly while every state was one of
 * §4's tiers: attention is tier 2, active tiers 3 and 4, resting tier 5.
 * `DONE` broke that — the spec puts it in tier 1 and this daemon ranks it with
 * the resting states, so it is the first row whose tone is chosen rather than
 * derived. The collapse itself is this table, and it
 * had to land somewhere the moment something fed the strip — `strip.ts` says as
 * much, that "the day the daemon wants to name one in a state-to-tone table,
 * `export` is the whole change".
 */
const TONE: Readonly<Record<SessionState, SessionChip['tone']>> = {
  NEEDS_PERMISSION: 'attention',
  FAILED: 'attention',
  WAITING: 'attention',
  // Resting, because that is the tier this daemon ranks it in. `strip.ts` is
  // clear the tint carries §4's tier rather than anything else, and "needs a
  // human" would not separate `DONE` from `WORKING` or `THINKING`, which need
  // one just as little and are `active`. An earlier version of this comment
  // gave that reason, and it would have justified making `WORKING` resting.
  DONE: 'resting',
  WORKING: 'active',
  THINKING: 'active',
  // Work, so `active` rather than `resting` — the chip should not say a
  // compacting session is idle.
  COMPACTING: 'active',
  IDLE: 'resting',
  ASLEEP: 'resting',
};

/**
 * A session as the strip draws it.
 *
 * Its own effective state, not the hero's. A chip that showed the hero's tone
 * would say every session is doing whatever the loudest one is doing, which is
 * the opposite of what a strip is for.
 */
function chipFor(session: Session, now: number): SessionChip {
  // Always local, and now permanently so: the remote transport `origin` was
  // built for was cut on 25 Aug (`BUILD_PLAN.md` §Stage 3). Nothing on the
  // *host* produces a remote session — the panel could never produce any
  // session, it has no knowledge of Claude Code — so `paintStrip`'s
  // hollow-chip branch is unreachable in production — kept because it is built and tested and
  // the panel can show the distinction the day something produces one, not
  // because anything is coming. A `Session` still carries no origin of its
  // own; this is the only place one is decided.
  return { tone: TONE[effectiveState(session, now)], origin: 'local' };
}

/**
 * The status band's right end: how many subagents are running, across all of
 * them.
 *
 * `BUILD_PLAN.md` §Stage 3 carried the badge as "drawn from placeholder text
 * until the daemon feeds the scene". This is the daemon feeding it. Blank
 * rather than a zero, because a zero is a thing to read and the common case is
 * nothing to say.
 */
function subagentText(sessions: readonly Session[]): string {
  const running = sessions.reduce((total, one) => total + one.subagents, 0);
  return running > 0 ? `+${String(running)}` : '';
}

/**
 * Whether the birthday may take the stage from a state.
 *
 * True for the two states whose picture says nothing is happening, and there
 * the birthday is strictly more informative than a Clawd standing about. False
 * everywhere else: the stage has one picture, so celebrating over a running
 * tool or a raised hand means *replacing* the thing the panel exists to show.
 *
 * **A total `Record` rather than a `Set`, for the reason `TOOL_STATES` gives
 * in `message.ts` — `TONE` above rejects a chain of ternaries rather than a
 * `Set`, so the argument generalises from it rather than being stated by it: a `Set` compiles clean
 * when a state is added to `SESSION_STATES` and silently puts it outside.**
 * This was a `Set` until a review planted `WAITING` in it — a party hat over a
 * session that had asked a human a question a minute earlier and not been
 * answered — and all six gates stayed green, because no test named `WAITING`
 * and nothing made one necessary. That is the precise outcome `message.ts`
 * says the feature exists to prevent. Defaulting safe was not the problem;
 * "safe by absence" and "decided" are different things, and only one of them
 * survives a tenth state arriving.
 *
 * Not named `RESTING`: `TONE` calls `DONE` resting, and this table
 * deliberately excludes it.
 */
const BIRTHDAY_COVERS: Readonly<Record<SessionState, boolean>> = {
  // Nothing is happening. The birthday is the more informative picture.
  IDLE: true,
  ASLEEP: true,
  // A real event with its own picture, and a bounded window that falls through
  // to `IDLE` — so the birthday follows it seconds later rather than losing.
  DONE: false,
  // Work in progress. `birthdayLine` covers these on the message band, which is
  // safe there because the stage still shows the work; here it *is* the stage.
  WORKING: false,
  THINKING: false,
  COMPACTING: false,
  // Asking for a human. The one day of the year it matters most that the panel
  // still says when to look is the day nobody is watching it for status.
  NEEDS_PERMISSION: false,
  WAITING: false,
  FAILED: false,
};

/**
 * Which animation a resolved panel shows.
 *
 * Extracted and exported for one reason: as three lines inlined in `paintOnce`
 * it had **no test at all**. `paintOnce` is not exported and `sceneFor` takes
 * the animation as an input, so deleting the `errorType` argument left all 430
 * tests green with the feature gone — which is the same shape of silent gap as
 * `packages/hooks` reading a field name that does not exist. One export and one
 * test is the whole cost of noticing.
 *
 * `sessions[0]` is the hero by construction: `resolve.ts` sorts once and
 * returns `state` from `ranked.at(0)` and `sessions` from the same array, so
 * they cannot disagree.
 *
 * **The birthday is decided here rather than in `animationFor`**, which is a
 * pure function of state in a package that never sees a pack — so the date
 * stays out of the table that maps states to pictures.
 *
 * The same *ordering* `message.ts` uses for the quip: `birthdayLine` runs ahead
 * of the `quips.mapped[state]` lookup exactly as this check runs ahead of
 * `animationFor`. Not the same package split, and an earlier draft claimed it
 * was — `birthdayLine` and `messageFor` are both in `cli`, and nothing in
 * `daemon` produces a message for it to sit one layer above.
 */
export function animationForPanel(
  panel: ReturnType<typeof resolvePanel>,
  pack: PackManifest,
  now: number,
): AnimationName {
  if (BIRTHDAY_COVERS[panel.state] && isBirthday(pack, now)) return 'birthday';
  return animationFor(panel.state, {
    tool: panel.tool,
    errorType: panel.sessions.at(0)?.errorType,
  });
}

/**
 * The frames for an animation, or none if it has not been baked.
 *
 * `animationFor` maps every session state and every `PreToolUse.tool_name` onto
 * a name in `ANIMATIONS`, and every one of those is baked — so this guard
 * cannot fire today, and saying otherwise would be inventing a hazard. It
 * exists for the next animation rather than the current ones — and the example
 * it names is maintenance. `sweeping` stood here until 25 Aug, when its art
 * landed; `payoff` until 24 Aug. Both are baked now, so neither illustrates the
 * hazard any more, and naming the next one would only queue up the same edit —
 * `assets/clawd/animations/PLANS.md` still lists unbuilt screens, and the moment
 * any of them is added to `ANIMATIONS` it is reachable here before its art is
 * baked. An empty stage is
 * the right answer to that; taking the panel down is not.
 *
 * Typed `AnimationName` rather than `string` on purpose. A `string` here is how
 * "nothing in 360 tests notices a referenced animation going missing" happens
 * one layer up.
 *
 * **The `return []` is unreachable by construction, not merely unreachable
 * today.** Planting an unbaked name in `ANIMATIONS` errors `tsc` twice in this
 * function — at `SPRITE_NAMES.includes` and again at `loadSprite`, which
 * rejects the widened union on its own — so no build that typechecks can enter
 * the branch. Deleting the guard would not remove the compile error; the one
 * path that reaches it is a `dist/` mismatch between packages built separately,
 * which is why it stays. An earlier version of this comment justified it by a
 * mid-frame throw that the type system already prevents.
 */
export async function framesFor(
  name: AnimationName,
): Promise<readonly Sprite[]> {
  if (!SPRITE_NAMES.includes(name)) return [];
  return loadSprite(name);
}

/**
 * Which frame of the current animation is showing.
 *
 * Driven by the clock rather than by a counter, so it does not need to be
 * carried through the paint loop and so two panels started a minute apart are
 * on the same beat — the index is a pure function of absolute epoch time.
 *
 * Every loop is a whole number of seconds at 8fps (16, 12, 8, 6, 4, 3 and 2), so a
 * loop restarts on a wall-clock second. That is a nicety and not what makes
 * this safe: the modulo lands in range for any frame count, and an earlier
 * version of this comment offered the one as the reason for the other.
 */
export function frameAt(frames: number, now: number): number {
  return Math.floor(now / FRAME_MS) % frames;
}

export type SceneInput = {
  readonly registry: Parameters<typeof resolvePanel>[0];
  readonly pack: PackManifest;
  readonly now: number;
  /** Empty is a complete scene: `scene.ts` leaves unfilled slots empty. */
  readonly sprites?: readonly Sprite[];
  /**
   * Which animation the sprites are frames of.
   *
   * **Five things read it now**, and it stays optional, so a caller that omits
   * it loses all five with no type error to show for it: the QR on the
   * birthday, the lid logo, the pet, the contact shadow, and — since the rare
   * scene landed — the birthday's precedence over that scene, which is decided
   * from this field in `midnight.ts` rather than from a second `isBirthday`
   * call. This said "two" while four read it, and the commit that added the
   * fifth left the count alone.
   *
   * The ground shadow was the first: the environment is painted before any
   * sprite exists, so the layer that draws the shadow cannot tell whether the
   * character about to go in front of it is standing on the ground or half way
   * up a wall. The name is the only thing that knows.
   */
  readonly animation?: AnimationName;
};

/**
 * What the panel should look like right now.
 *
 * Exported for its tests. Everything a person reads on the glass is decided
 * here, and until it was exported the only assertions available were on the
 * *byte count* that reached the wire — under which five of the six things this
 * puts on the panel could be destroyed outright with the whole suite green.
 *
 * The stage takes whatever frame the caller has to hand. An empty array is
 * still a complete scene — `scene.ts` documents that slots past the end stay
 * empty — which is what the tests want and what the panel shows for a state
 * whose animation has not been drawn yet.
 */
export function sceneFor(input: SceneInput): Scene {
  const { registry, pack, now } = input;
  const sprites = input.sprites ?? [];
  const panel = resolvePanel(registry, now);
  const stage = stageCoverFor(input, panel.state);
  return {
    orientation: ORIENTATION,
    layout: 'hero',
    pack,
    sprites,
    status: {
      left: clockText(now),
      right: subagentText(panel.sessions),
    },
    sessions: panel.sessions.map((session) => chipFor(session, now)),
    message: messageFor(panel, pack, now),
    // **One predicate, two consequences.** The QR shows exactly when the
    // birthday has the stage — which `animationForPanel` has already decided,
    // date and state together. A second `isBirthday` call here would be a
    // second rule to keep in step with the first, and the first is the one
    // that has been argued over and tested per state.
    //
    // So the QR inherits all of it: it is gone the moment a session needs a
    // human, or is working, or has just finished, and it comes back when the
    // desk goes quiet. Nothing has to decide when to take it down.
    qr: input.animation === 'birthday' ? BIRTHDAY_QR : undefined,
    // The lid only exists in `typing`, so the mark is offered nowhere else.
    // A pack without a `logo` leaves this undefined and the placeholder square
    // baked into the animation shows through, which is what every pack that is
    // not the recipient's does.
    logo: input.animation === 'typing' ? pack.logo : undefined,
    // The pet is on the two screens the frozen spec puts it on and no others.
    // A total record rather than a `Set` or an `||` chain, deliberately: the
    // `RESTING` set in this same file accepted a planted typo through all six
    // gates, because a `Set<string>` cannot be told a member is misspelled and
    // a missing key here is a `false` the compiler will not see.
    pet:
      input.animation !== undefined && PET_APPEARS[input.animation]
        ? pack.pet
        : undefined,
    // The rare scene, which replaces everything above it on the stage rather
    // than adding to it. `midnight.ts` owns all three conditions so each can be
    // mutated on its own; here it is one call because the renderer's contract
    // is the same as for `logo` and `pet` — it draws what it is given and this
    // file decides when.
    cover: stage.cover,
    environment: {
      time: timeOfDay(now),
      extent: ENVIRONMENT_EXTENT,
      // No shadow under a cover. The shadow marks where Clawd's feet meet the
      // ground, and a scene replaces him — so a cover shorter than the stage
      // would otherwise float above a contact shadow cast by nobody. Suppressed
      // rather than drawn, because the scene carries its own ground.
      contact: stage.contact,
    },
  };
}

/**
 * The rectangle that changed, or nothing.
 *
 * A whole frame goes whenever the link owes one. `link.ts` sets `needsPrime`
 * from five places, three of them the device saying something: `afterOpen`
 * (connect), `afterClose` (the port went away) and `afterReport` (a resync, an
 * abort, or a counter that went backwards). The other two are the host deciding
 * for itself — `newLink` before the first frame, and `afterRefresh` on a
 * five-second timer,
 * which `panel.ts` runs precisely because the loss it covers is the one the
 * firmware cannot see. So a full 320x172 frame leaves here every five seconds
 * whether or not anything asked, and that is the design rather than a leak.
 *
 * Sending less than the whole screen for a prime does not satisfy it:
 * `afterWrite` refuses to clear `needsPrime` for anything smaller, so the debt
 * stays owed and the next frame primes again. (The 120-of-300-ticks figure
 * recorded in `transport.ts` and `link.ts` is a *different* mistake — priming
 * with frame 0 while the diff sequence had moved on. An earlier version of this
 * comment borrowed that number for this cause, which is not what it measured.)
 *
 * The whole rectangle is passed in rather than taken from
 * `protocol.fullScreenRect()`, which is 172x320 — the portrait panel. This
 * device is used landscape, so its framebuffer is 320x172 and the portrait
 * rectangle does not fit it: `extractRect` throws "rect 0,0 172x320 does not
 * fit a 320x172 frame", which is how this was found. `fullScreenRect` has no
 * way to know the orientation and the renderer's `panelSize` does, so the
 * caller supplies it.
 */
function changed(
  previous: Frame | undefined,
  next: Frame,
  whole: Rect,
): Rect | null {
  if (previous === undefined) return whole;
  return dirtyRect(previous, next);
}

/**
 * The panel, with its link status wired to somewhere a person will see it.
 *
 * `link.ts` composes a specific, actionable sentence for a firmware/panel
 * mismatch, and before this was passed the daemon computed it and dropped it —
 * writes stopped after the first frame, permanently, in silence, because
 * `panel.ts` never retries a refused link.
 *
 * Two things the first version of this got wrong, both measured:
 *
 * **It said nothing when the panel was not there at all** — the likeliest
 * failure of the lot, a wrong `/dev/cu.*` or a cable not seated. `onChange`
 * only fires on a *change* and `newLink` already starts at `offline`, so a
 * device that never opens never changes anything and the daemon retried once a
 * second in the dark. Hence the opening line, said before anything has
 * happened.
 *
 * **And it said far too much when the panel was there** — `needsPrime` is part
 * of the status, `panel.ts` sets it every five seconds and clears it on the
 * next write, so `onChange` fired twice a refresh: about 43,200 identical
 * `panel online` lines a day, which buries the one line worth reading.
 *
 * So `onChange` is not used at all. The paint loop already reads
 * `transport.status()` every tick and already carries state forward without a
 * mutable binding, so it carries the last line said too and reports only when
 * that changes. Polling also sees the case a change-callback cannot: a panel
 * that never arrives, and so never changes anything.
 */
function openReporting(
  options: DaemonOptions,
  size: { readonly width: number; readonly height: number },
  report: (line: string) => void,
): ReturnType<typeof openPanel> {
  report(`waiting for a panel on ${options.devicePath}`);
  return openPanel({
    path: options.devicePath,
    panel: size,
    serial: options.serial,
    refreshMs: options.refreshMs,
    retryMs: options.retryMs,
    giveUpAfter: options.giveUpAfter,
    onGiveUp: options.onGiveUp,
  });
}

/**
 * What one frame needs, narrowed to what it reads.
 *
 * `listener` was `Awaited<ReturnType<typeof startSocketServer>>` and
 * `paintOnce` calls exactly one of its methods. The whole type made the
 * function look as though it needed a running server, so the only way to
 * exercise a frame was to start one — which the `describe('the daemon
 * command')` block does, driving real frames through here via `runDaemon`.
 * Three of its five assert bytes on the wire; gutting the send fails exactly
 * those three, which is how the count was arrived at rather than asserted. The
 * other two assert a byte count is *unchanged* and that the socket is gone.
 * What none of the five can do is put this function on a chosen date, which is
 * why the birthday's own path reached the panel untested. An earlier draft said
 * "nothing ever did", which erases the block entirely.
 *
 * Structural typing means the real `SocketServer` still satisfies this, and
 * `runDaemon` passes it unchanged.
 *
 * `transport` is left as the whole `Transport` and that is worth being honest
 * about: both this and `Painting` use strict subsets of it — `status` and
 * `send` here, `status` alone there — so the narrowing argument applies and has
 * simply not been done. An earlier draft claimed `Painting` calls `close()`. It
 * does not; the one `close()` is in `runDaemon`'s `stop` closure, on its own
 * local binding.
 */
type Painter = {
  readonly transport: Transport;
  readonly listener: {
    readonly snapshot: () => ReturnType<typeof createRegistry>;
  };
  readonly pack: PackManifest;
  readonly now: () => number;
  readonly size: { readonly width: number; readonly height: number };
  readonly whole: Rect;
};

/**
 * One frame: resolve, pick Clawd's pose, render, diff, send.
 *
 * Lifted out of `runDaemon` because that function has a fifty-line budget and
 * this is the part of it worth reading on its own.
 */
export async function paintOnce(
  ctx: Painter,
  previous: Frame | undefined,
): Promise<Frame | undefined> {
  const { transport, listener, pack, now, size, whole } = ctx;

  const status = transport.status();
  if (status.phase !== 'online') return previous;
  const at = now();
  const registry = listener.snapshot();
  const panel = resolvePanel(registry, at);
  // The animation for the state, and the frame of it the clock is on.
  //
  // `framesFor` resolves an unbaked name to nothing rather than throwing, and
  // the empty check below is what that buys. Both are currently unreachable:
  // `ANIMATIONS` is a subset of `SPRITE_NAMES`, so every name this can produce
  // has data behind it. Subset and not equality: an animation can be baked
  // before it is wired, which `overheated` did on 24 Aug (art 08:58, wiring
  // 12:01), `board-game` did again on 25 Aug (art 11:07, wiring 12:23), and
  // `sweeping` did the same day at a 5h40m gap (art 16:15, wiring 21:55).
  // **The lists are equal at HEAD**, which is exactly the moment this guard
  // looks deletable and is worst to be without — an earlier version of this
  // comment said so while they were unequal, and the sentence it warned about
  // is now the state of the tree. They were unequal at the merge of the
  // `birthday` art, which baked it without wiring it; the commit after that one
  // wired it and closed the gap. (An earlier draft put the inequality one
  // commit later, at the commit that had already fixed it.)
  //
  // The count is not written down here: two previous attempts went stale within
  // a week. What replaced it must be run from the repo root —
  // `pnpm exec vitest run packages/daemon/src/animation.test.ts` — because a
  // `pnpm --filter` form resolves the config's globs against the package
  // directory and exits non-zero having run nothing, which is the trap that
  // file's own header warns about and which an earlier draft of this line fell
  // into. And it proves less than the sentence above claims: the assertion is
  // `ANIMATIONS ⊆ SPRITE_NAMES`, so a name baked and not wired leaves it green.
  // Equality is checked by nothing. They are kept because the two lists are
  // maintained in different packages by different tools — `animation.ts` by
  // hand, `sprites/index.ts` by `bake-sprites.ts` — and
  // `animation.test.ts`'s "names only animations that have been baked" is what
  // turns a drift into a red test rather than an empty stage. The counts used
  // to be spelled out here and in two other files; they were "six" and then
  // "eight" within a week, so they are not spelled out any more.
  //
  // Earlier versions of this comment said three states fall back to
  // `thinking`, then one. None do: `dizzy` was the last, and `FALLBACK` is now
  // reached only from `WORKING`, with an unmapped tool or with no tool.
  const wanted = animationForPanel(panel, pack, at);
  const frames = await framesFor(wanted);
  const showing =
    frames.length > 0
      ? frames.slice(frameAt(frames.length, at)).slice(0, 1)
      : [];
  const next = frame(
    render(
      sceneFor({
        registry,
        pack,
        now: at,
        sprites: showing,
        animation: wanted,
      }),
    ).pixels,
    size.width,
  );
  const rect = status.needsPrime ? whole : changed(previous, next, whole);
  if (rect !== null) {
    await transport.send(rect, encodeRect(extractRect(next, rect)));
  }
  return next;
}

export async function runDaemon(
  options: DaemonOptions,
): Promise<RunningDaemon> {
  const pack = parsePackManifest(options.pack);
  const now = options.now ?? Date.now;
  const size = panelSize(ORIENTATION);
  const whole: Rect = { x: 0, y: 0, width: size.width, height: size.height };

  const listener = await startSocketServer({
    path: options.socketPath,
    now,
  });
  const report =
    options.report ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const transport = openReporting(options, size, report);

  /**
   * One frame, given what the panel is already showing. Returns what it shows
   * now, which is the only state this loop carries — passed forward rather than
   * held, so nothing here needs a mutable binding and the package keeps its
   * clean sheet against `docs/CONVENTIONS.md` §"Holding mutable state".
   */
  const paint = (previous: Frame | undefined): Promise<Frame | undefined> =>
    // Quiet hours skip the render, not just the send, and hand `previous`
    // straight back. `quiet.ts` §"Carrying the frame across" has why returning
    // the old frame unchanged is correct rather than merely cheap.
    options.quiet?.(now(), listener.snapshot().lastEventAt) === true
      ? Promise.resolve(previous)
      : paintOnce({ transport, listener, pack, now, size, whole }, previous);

  const stopping = new AbortController();
  void painting({
    transport,
    report,
    frameMs: options.frameMs ?? FRAME_MS,
    aborted: () => stopping.signal.aborted,
    paint,
  });

  return {
    stop: async () => {
      stopping.abort();
      await listener.close();
      await transport.close();
    },
  };
}
