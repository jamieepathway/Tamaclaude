/**
 * Where the pack comes from.
 *
 * ## There is no bundled default, deliberately
 *
 * The obvious design has a fallback: try what the user configured, and if
 * nothing is there, load a copy of the example pack that ships with the
 * binary. A spec review killed it, and the argument is the whole reason this
 * file exists.
 *
 * **A fallback turns the most likely mistake into an invisible one.** Nothing
 * sets `TAMACLAUDE_PACK` in production today — `BUILD_PLAN.md` still has the
 * launchd agent and the `brew` formula unstarted, and `packages/hooks` says in
 * as many words that it does not install a launchd agent. So the likeliest way
 * this daemon starts on 23 September is a person typing the command they have
 * typed a hundred times, without the variable. With a fallback that hands back
 * a panel which works, looks right, and carries the example pack's generic
 * quips and no `birthday` at all. Nothing is red. Nobody finds out until the
 * day after.
 *
 * Without one it is `no pack configured` on stderr, exit 2, fixed in fifteen
 * seconds.
 *
 * **What the glass shows meanwhile, stated carefully, because two reviews
 * disagreed about it and both earlier versions of this paragraph were wrong.**
 * The splash is not a "no host" screen — `main.c` draws it once at boot and
 * never redraws it, because no-host is not observable on this link. And
 * "never redrawn" holds only within one firmware boot: `serial.ts` records,
 * from a real run rather than from theory, that *opening the port resets the
 * board*, so every connect reboots it and repaints the splash.
 *
 * None of which applies to this failure, for a reason about call order rather
 * than firmware: `resolvePack` runs before `runDaemon` opens the port, so
 * refusing to start never touches the device at all. The panel keeps whatever
 * it had — the splash if nothing has driven it, the last painted frame
 * otherwise, which reads as working-but-frozen.
 *
 * ## The counter-argument, which is good, and the third option
 *
 * A later review made a case worth writing down rather than winning against.
 * **The cost asymmetry inverts after 23 September.** A missing birthday costs
 * one day a year; a panel that will not start costs every day. And "loud" is
 * only loud if somebody is listening: once a launchd agent owns the daemon it
 * respawns on a throttle forever, and unless the plist sets
 * `StandardErrorPath` the sentence goes to a log nobody reads. That is not
 * silence-free, it is differently silent.
 *
 * There is a third option that dominates both, and the binary above hides it:
 * **fall back, and say so on the glass.** The message band exists,
 * `describePack` already composes the sentence, and the panel is the one
 * surface guaranteed to be in front of a person. Then the mistake is neither
 * invisible nor fatal.
 *
 * It is not built, because feature freeze is 13 September and this is not the
 * thing to spend that budget on. It is written here so that if the launchd
 * item slips, the fallback position is already agreed rather than argued
 * about in the last week.
 *
 * ## Explicit and implicit, not absent and invalid
 *
 * The first draft said "absent falls through, invalid is fatal". That cut is
 * unimplementable: a directory someone created but left empty, and a dangling
 * symlink into a moved checkout, both arrive as `ENOENT` — and both are
 * mistakes, not absences. The distinction that survives contact is whether the
 * path was *named*:
 *
 * | Source                     | Missing means                                  |
 * | -------------------------- | ---------------------------------------------- |
 * | `TAMACLAUDE_PACK` set      | you named a path and it is not there — fatal   |
 * | `TAMACLAUDE_PACK` empty    | you meant to name one and did not — fatal      |
 * | `~/.tamaclaude/pack/` bare | nothing configured — fatal, with instructions  |
 *
 * Every end is fatal, so there is no fall-through to get wrong; the only
 * difference is which sentence prints. The middle row was missing from both
 * this table and the code, while the sentence below it claimed no
 * fall-through existed — an empty variable resolved to the default and looked
 * entirely normal.
 *
 * ## Not a config file, and that reopens a decision
 *
 * `.claude/research/foundations/brief.md` §Packs says "`config.json` picks
 * one". This is not that, and the departure is deliberate rather than an
 * oversight: a JSON file holding a single string is a second schema, a second
 * trust boundary and a second set of tests, to do what one environment
 * variable already does — and the launchd plist that will set it in production
 * is a config file already. If a pack ever needs more than one knob, that is
 * the moment to revisit this, not before.
 *
 * ## A pack is a directory
 *
 * Not a manifest file. `BUILD_PLAN.md` puts a logo and a pet sprite in the
 * pack, so the directory is the unit and `manifest.json` is a file inside it.
 * Resolving to the file now would leave the sibling-asset question to be
 * answered ad hoc later.
 */
import type { PackManifest } from '@tamaclaude/packs';

import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { parsePackManifest } from '@tamaclaude/packs';

/** Where a resolved pack came from, so `tamaclaude pack` can say. */
type PackSource = 'TAMACLAUDE_PACK' | 'default';

export type ResolvedPack = {
  /** The pack directory. */
  readonly directory: string;
  /**
   * The manifest as read, unparsed, for handing to the daemon.
   *
   * The daemon validates it again. That is not redundancy to be tidied away:
   * `packages/daemon` is the trust boundary and its guarantee must not depend
   * on its caller having been careful. What the CLI's own parse buys is a
   * *sentence* — a zod error reaching the terminal raw is a JSON array of
   * issue objects, which is the least useful thing a hand-edited manifest
   * could be answered with.
   */
  readonly manifest: unknown;
  /** The same manifest, validated here so failures can be explained. */
  readonly parsed: PackManifest;
  readonly source: PackSource;
};

type Lookup = {
  readonly env?: Readonly<Partial<Record<string, string>>>;
  readonly home?: string;
};

/**
 * The default pack directory, under the same `~/.tamaclaude/` as the socket.
 *
 * `socket-path.ts` puts `daemon.sock` there. `install.ts` supplies the
 * environment-variable idiom but writes to `~/.claude/`, so it is a precedent
 * for the override and not for the location. The directory is not guaranteed
 * to exist when this runs — resolution happens before the socket is prepared,
 * so on a fresh machine nothing has created it, which is exactly the
 * `no pack configured` case.
 *
 * It earns its place over the environment variable for a plainer reason than
 * the one first written here: a fixed location means the pack can be installed
 * without configuring anything, which is one less step to get wrong on
 * somebody else's Mac.
 *
 * The original justification — that a plist's environment cannot be read back
 * out of a running agent — is false, and a review disproved it by running
 * `launchctl print gui/<uid>/<label>`, which prints the job's environment
 * block. The plist is a readable file besides.
 */
function defaultDirectory(home: string): string {
  return join(home, '.tamaclaude', 'pack');
}

/**
 * Whether anything at all occupies this path.
 *
 * `lstat`, not `existsSync`, and that is the whole point: `existsSync` follows
 * symlinks, so a dangling one — the shape a moved checkout leaves behind —
 * reads as "nothing here" and would produce `no pack configured` for a path
 * somebody deliberately created. `lstat` sees the link itself.
 *
 * `socket-path.ts` also reaches for `lstat` and shares the habit of refusing
 * to let "I cannot tell" choose an answer — but its reason is about connect
 * errnos, not symlinks, and it never mentions `existsSync`. The habit is the
 * borrowed part, not the argument.
 *
 * So an empty directory, a dangling link and a regular file all count as
 * *something*, and all of them go on to fail with a message naming the path
 * rather than falling through.
 */
function somethingIsThere(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    // **Only `ENOENT` means nothing is here.** A bare `catch` returning false
    // treated `EACCES` on `~/.tamaclaude/` and `ENOTDIR` — a regular file
    // where the directory should be — as absence, and printed "put a pack
    // here" for a path that is already occupied and cannot be created without
    // deleting something. That is the same uselessness this file rejects for
    // the empty-directory case, applied to one error class and not the other.
    // Measured: both produced the wrong sentence before this.
    //
    // Anything else counts as present, so it falls on to `readManifest`, which
    // names the file and the underlying reason.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Read and JSON-parse a manifest, or say which file and why not. */
function readManifest(directory: string, source: PackSource): unknown {
  const manifest = join(directory, 'manifest.json');
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
  } catch (cause) {
    // Named rather than left as a bare ENOENT or a JSON syntax error, both of
    // which point at Node's internals instead of at the file — the same reason
    // `index.ts` gives for wrapping its own read.
    const how =
      source === 'TAMACLAUDE_PACK'
        ? 'TAMACLAUDE_PACK names this directory'
        : 'this is the default pack directory';
    throw new Error(`could not read the pack at ${manifest} (${how})`, {
      cause,
    });
  }
}

/**
 * Validate a manifest, turning a zod failure into something readable.
 *
 * A `ZodError` stringifies to a JSON array of issue objects. Printed at a
 * terminal that is worse than useless — it buries which file and which field
 * under punctuation. A hand-edited manifest failing validation is at least as
 * likely as a missing one, and `docs/CONVENTIONS.md` says a pack is a genuine
 * trust boundary for exactly that reason.
 */
function validate(manifest: unknown, directory: string): PackManifest {
  try {
    return parsePackManifest(manifest);
  } catch (cause) {
    throw new Error(
      `the pack at ${join(directory, 'manifest.json')} is not a valid pack — ${explain(cause)}`,
      { cause },
    );
  }
}

/**
 * Escape a string for a one-line terminal message.
 *
 * **Field names come out of the manifest, which is untrusted input** — the
 * repo's own named example of it. Interpolated raw, a key containing a newline
 * turns the "one sentence" this CLI promises into several, and a key
 * containing an ESC byte writes raw ANSI to somebody's terminal. Both measured
 * through the built binary.
 *
 * This was a regression rather than an oversight: the zod dump it replaced was
 * `JSON.stringify` output, so it escaped exactly these characters. Being more
 * readable cost the escaping, and a review caught it. `JSON.stringify` minus
 * its quotes restores it, which is the same mechanism zod was relying on.
 */
function printable(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/**
 * Turn whatever `parsePackManifest` threw into a readable clause.
 *
 * A `ZodError` stringifies to a JSON array of issue objects. At a terminal
 * that is worse than useless — it buries which field failed under punctuation.
 *
 * **The JSON parse is guarded, and the guard is the point.** Every input this
 * sees today is a `JSON.parse` result and every rejection is a `ZodError`
 * whose message is a JSON array — swept `{}`, `null`, `[]`, a string, a
 * number, and every invalid manifest shape. But this runs *inside* a catch
 * block, and an unguarded `JSON.parse` there converts any future non-zod throw
 * into a `SyntaxError` from the error handler, discarding the original and the
 * pack path with it. That is the exact failure this function exists to remove,
 * produced by the code removing it. The day it goes live is the day
 * `packManifestSchema` grows a `.transform` that can throw.
 */
function explain(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const issues: unknown = ((): unknown => {
    try {
      return JSON.parse(message);
    } catch {
      return undefined;
    }
  })();
  if (!Array.isArray(issues)) return printable(message);
  return issues
    .map((issue: { path?: readonly (string | number)[]; message?: string }) => {
      const path = (issue.path ?? []).join('.');
      return `${printable(path === '' ? '(root)' : path)}: ${printable(issue.message ?? 'invalid')}`;
    })
    .join('; ');
}

/**
 * Find the pack, or throw a sentence a person can act on.
 *
 * `env` and `home` are injectable so a test can point the whole resolution at
 * a temporary directory rather than at whoever is running the suite — the same
 * reason `TAMACLAUDE_SOCKET` exists.
 */
export function resolvePack(lookup: Lookup = {}): ResolvedPack {
  const env = lookup.env ?? process.env;
  const home = lookup.home ?? homedir();

  const named = env.TAMACLAUDE_PACK;
  if (named === '') {
    // **Set but empty is a mistake, not an absence.** This used to fall
    // through to the default, which is the one behaviour this whole file
    // exists to prevent: `<string></string>` in a plist, or
    // `TAMACLAUDE_PACK=$TYPO`, and the operator believes they named a pack
    // while a different one loads and everything looks fine. Two reviews found
    // it, and the module doc above claimed "no fall-through" while this was
    // here.
    throw new Error(
      'TAMACLAUDE_PACK is set but empty: name a pack directory, or unset it ' +
        'to use the default',
    );
  }
  if (named !== undefined) {
    const manifest = readManifest(named, 'TAMACLAUDE_PACK');
    return {
      directory: named,
      manifest,
      parsed: validate(manifest, named),
      source: 'TAMACLAUDE_PACK',
    };
  }

  const fallback = defaultDirectory(home);
  if (!somethingIsThere(fallback)) {
    throw new Error(
      `no pack configured: set TAMACLAUDE_PACK, or put a pack at ${fallback}`,
    );
  }
  const manifest = readManifest(fallback, 'default');
  return {
    directory: fallback,
    manifest,
    parsed: validate(manifest, fallback),
    source: 'default',
  };
}

/** One line naming the loaded pack and where it came from. */
export function describePack(resolved: ResolvedPack): string {
  const how = resolved.source === 'default' ? 'default' : '$TAMACLAUDE_PACK';
  return `${resolved.parsed.name} at ${resolved.directory} (${how})`;
}
