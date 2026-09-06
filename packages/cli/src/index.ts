#!/usr/bin/env node
/**
 * `tamaclaude` — the command line surface.
 *
 * There is deliberately no menu bar app: one would need a native shim or
 * Electron, which reintroduces a signed `.app` and Gatekeeper for a gift that
 * has to work on someone else's Mac on the day. The panel is its own UI, and
 * the CLI covers the rest. See BUILD_PLAN §Deliberately not scheduled.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  animationFor,
  createDaemon,
  createRegistry,
  defaultSocketPath,
  observe,
  resolvePanel,
} from '@tamaclaude/daemon';
import { findPanels, nodeUsb } from '@tamaclaude/device';
import { isBirthday } from '@tamaclaude/packs';

import {
  AGENT_LABEL,
  agentCondition,
  agentEnvironment,
  agentListing,
  agentPlist,
  agentPlistPath,
  describeAgentInstall,
  describeAgentStatus,
  describeInstallOutcome,
  parseAgentStatus,
} from './agent.js';
import { runDaemon } from './daemon.js';
import { chooseDevice, refusalReport } from './device.js';
import { capDaemonLog, daemonLogPath } from './log.js';
import { describePack, resolvePack } from './pack.js';
import { quietGate, quietSpecIn } from './quiet.js';
import { status } from './status.js';

/**
 * The search window for the next birthday: long enough to contain every date.
 *
 * 366 rather than 365 so a 29 February pack is reachable from any starting
 * day. The index is never `-1` for a manifest that parsed: the schema refuses
 * a date that occurs in no month, and `isBirthday` falls 29 February back to
 * the 28th in a common year, so every valid date occurs exactly once in any
 * 366-day window — checked exhaustively over four timezones.
 *
 * This constant previously carried a docstring describing a helper returning
 * `number | undefined`, which had been inlined away. The comment outlived its
 * function, which is the class `tools/detached-docs.test.ts` exists for and
 * which it cannot see, because a line comment is not a bound doc block.
 */
const YEAR_AND_A_DAY = 366;

/**
 * `tamaclaude pack` — say which pack is loaded, and when it celebrates.
 *
 * **This is the answer to the failure no schema can catch.** A pack that is
 * valid but *wrong* — the example pack where the recipient's should be — loads
 * cleanly, renders beautifully, and has no birthday in it. Zod cannot see that
 * and neither can a person looking at the panel. So the surface that can see
 * it has to exist and has to be trivial to run.
 *
 * The countdown is computed by asking `isBirthday` about each of the next 366
 * days rather than by doing calendar arithmetic here. That is deliberate: it
 * cannot disagree with the function that actually drives the panel, including
 * about 29 February, which falls back to the 28th in a common year.
 */
function pack(): void {
  const resolved = resolvePack();
  const manifest = resolved.parsed;
  process.stdout.write(`pack ${describePack(resolved)}\n`);
  if (manifest.birthday === undefined) {
    process.stdout.write('birthday: none in this pack\n');
    return;
  }
  const now = Date.now();
  const days = Array.from({ length: YEAR_AND_A_DAY }, (_unused, offset) =>
    isBirthday(
      manifest,
      new Date(now).setHours(12, 0, 0, 0) + offset * 86_400_000,
    ),
  ).indexOf(true);
  const when =
    days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${String(days)} days`;
  process.stdout.write(
    `birthday: ${manifest.birthday.date} — fires ${when}, saying ` +
      `"${manifest.birthday.quip}"\n`,
  );
}

/**
 * `tamaclaude install-agent` — start the daemon at login, and keep it started.
 *
 * **Dry run by default**, exactly like `tamaclaude-install-hooks`, and for the
 * same reason: it writes into somebody's `~/Library/LaunchAgents` and loads
 * something that will run without them watching.
 *
 * `--apply` resolves the pack *before* writing anything. That ordering is the
 * point rather than tidiness: an agent installed on a Mac with no pack exits 2
 * on every start, and `KeepAlive` cannot tell exit 2 from exit 1 — launchd
 * only sees zero versus non-zero — so it would restart forever, writing `no
 * pack configured` into a log nobody opens while the panel showed whatever it
 * last showed. Refusing to install is the only place that loop can be stopped.
 *
 * `bootout` before `bootstrap`, always. A plist already loaded keeps running
 * with its old arguments no matter what is written to disk, so a second
 * `--apply` would look like it succeeded while the first agent carried on —
 * and the second `--apply` is exactly what happens on the day somebody fixes
 * a path.
 */
async function installAgent(argv: readonly string[]): Promise<void> {
  requireDarwin('install-agent');
  const apply = argv.includes('--apply');
  const home = homedir();
  const plistPath = agentPlistPath(home);
  // Resolved first, so `--apply` cannot install an agent that cannot start.
  // The error is `pack.ts`'s, which names the path and the reason.
  const resolved = resolvePack();
  const options = {
    node: process.execPath,
    script: fileURLToPath(import.meta.url),
    pack: resolved.directory,
    socket: defaultSocketPath(),
    log: daemonLogPath(home),
    /*
     * Carried forward, not set here. This command rewrites the plist whole, so
     * before it learned to read the existing window, `--apply` deleted quiet
     * hours — silently, and on the command `docs/INSTALL.md` prescribes
     * whenever node moves. There is no flag to set it because there is nowhere
     * better for it to live than the job's own environment; what there has to
     * be is a guarantee that reinstalling does not throw it away.
     */
    quiet: quietSpecIn({
      running: agentEnvironment(),
      plist: existsSync(plistPath)
        ? readFileSync(plistPath, 'utf8')
        : undefined,
      env: process.env['TAMACLAUDE_QUIET'],
    }),
  };
  process.stdout.write(
    describeAgentInstall(options, plistPath, existsSync(plistPath)),
  );

  const panels = await findPanels(nodeUsb());
  process.stdout.write(
    `panel      ${panels[0]?.path ?? 'none found right now — the agent will look again each start'}\n`,
  );

  if (!apply) {
    process.stdout.write(
      'Dry run: nothing was written. Re-run with --apply to install.\n',
    );
    return;
  }
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(join(home, '.tamaclaude'), { recursive: true });
  writeFileSync(plistPath, agentPlist(options));
  const domain = launchdDomain();
  // Unloading something that is not loaded is not an error worth stopping for,
  // so its failure is ignored and `bootstrap`'s is not.
  bootOut(domain, 'install');
  await waitUntilUnloaded(domain);
  execFileSync('launchctl', ['bootstrap', domain, plistPath], {
    stdio: 'inherit',
  });
  // **Bootstrap exiting 0 means loaded, not running.** Checked rather than
  // claimed, after a pause long enough for a start failure to have happened —
  // the likeliest one being a `tamaclaude daemon` already running by hand,
  // which makes the agent exit 1 on `already listening` and restart forever
  // while the install says it worked.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const started = parseAgentStatus(agentListing());
  // One classification, rendered twice. The verdict line and the closing line
  // used to be decided separately — `describeAgentStatus` from the exit code,
  // this one from `pid === undefined` alone — so an absent panel printed
  // "waiting for a panel, it starts itself" and then "It is not running. The
  // log is at …". Same fact, two moods, and the second one is the sentence
  // PR #70 removed from `status` for this exact condition.
  const nodeExists = existsSync(options.node);
  process.stdout.write(`${describeAgentStatus(started, nodeExists)}\n`);
  process.stdout.write(
    describeInstallOutcome(agentCondition(started, nodeExists), options.log),
  );
}

/**
 * Refuse the agent commands anywhere launchd does not exist.
 *
 * **CI found this, which is the point of having it.** On Linux `launchctl` is
 * simply absent, so `execFileSync` throws with no exit status and the
 * uninstall command reported `could not unload … (launchctl exit -1)` — a
 * sentence about a failure, for a platform where the whole idea is
 * meaningless. Before the errors were surfaced at all it "passed" there by
 * swallowing them, which a review had already called out as passing by
 * accident.
 *
 * Saying so plainly is better than either. The panel is a Mac accessory and
 * `serial.ts` is macOS-only too; this is the first place that is worth a
 * sentence rather than a stack.
 */
function requireDarwin(command: string): void {
  if (process.platform !== 'darwin') {
    throw new Error(
      `tamaclaude ${command} needs launchd, which is macOS only (this is ${process.platform})`,
    );
  }
}

/**
 * The launchd domain this user's agents live in.
 *
 * `getuid` is always present on Darwin, so the missing case is unreachable —
 * but `gui/0` is not a domain that exists, and this repo's habit is that "I
 * cannot tell" refuses rather than picks. A default of 0 produced a wrong
 * answer where a stop belonged.
 */
function launchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('cannot determine the launchd domain: no uid on this host');
  }
  return `gui/${String(uid)}`;
}

/**
 * Unload the agent, telling "was not loaded" apart from "could not unload".
 *
 * **Measured exit codes on this Mac**: `launchctl bootout` on a label that is
 * not loaded exits 3; `launchctl print` on one exits 113; `print` against a
 * domain that does not exist exits 112.
 *
 * The first version caught every failure and called it "not loaded", so a real
 * problem — a teardown still in progress, a job in another domain, a
 * permissions error — was discarded, and the only symptom arrived ten seconds
 * later from `waitUntilUnloaded` telling the user to run by hand the exact
 * command that had already failed in silence.
 *
 * Returns whether it was running, because `uninstall-agent` says so out loud.
 */
function bootOut(domain: string, when: 'install' | 'uninstall'): boolean {
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${AGENT_LABEL}`], {
      stdio: 'pipe',
    });
    return true;
  } catch (cause) {
    const status = (cause as { readonly status?: number }).status;
    // 3 is launchd's "no such service", which is the ordinary case on a first
    // install and on a second uninstall. Anything else is a real failure and
    // saying so now beats a misleading timeout later.
    if (status === 3) return false;
    throw new Error(
      `could not unload ${AGENT_LABEL} (launchctl exit ${String(status ?? -1)}) while trying to ${when}`,
      { cause },
    );
  }
}

/**
 * Wait for a booted-out agent to actually be gone.
 *
 * **`launchctl bootout` returns 0 while the service is still there.** Measured
 * on this machine: exit 0 immediately, and the label kept answering
 * `launchctl print` for about 800ms afterwards. Bootstrapping inside that
 * window fails with `Bootstrap failed: 5: Input/output error`, which is
 * launchd's way of saying the label is already taken.
 *
 * That is a real second-install failure and only a round trip on real hardware
 * found it: the plist is rewritten, the old agent is gone, the new one never
 * starts, and the panel keeps showing the last frame it was sent. Everything
 * looks like it worked except the thing that matters.
 *
 * Polling rather than a fixed sleep, because 800ms is one measurement on one
 * Mac and the number that matters is "gone", not "long enough".
 */
async function waitUntilUnloaded(domain: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      execFileSync('launchctl', ['print', `${domain}/${AGENT_LABEL}`], {
        stdio: 'ignore',
      });
    } catch {
      return; // `print` failing is the label being free, which is what we want.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${AGENT_LABEL} did not unload within 10s; run \`launchctl bootout gui/$(id -u)/${AGENT_LABEL}\` and try again`,
  );
}

/**
 * `tamaclaude uninstall-agent` — stop it, and stop it coming back.
 *
 * **An install with no uninstall is half a feature, and this one especially.**
 * The agent has `RunAtLoad`, so it starts at every login, and `KeepAlive`, so
 * it restarts whenever it exits non-zero. A `SIGTERM` stops it until the next
 * login and no further. Without this command the only way off is `launchctl
 * bootout` and `rm`, typed correctly, by someone who knows both — which is not
 * the person this is a gift for.
 *
 * Not a dry run, unlike installing. Removal is the reversible direction: the
 * worst case is re-running `install-agent --apply`, whereas the worst case of
 * installing by accident is a process that starts itself forever on somebody
 * else's Mac.
 *
 * The plist is deleted as well as booted out. Leaving the file would mean the
 * agent returns at the next login having apparently been removed, which is the
 * kind of not-quite-gone that costs an evening.
 */
function uninstallAgent(): void {
  requireDarwin('uninstall-agent');
  const plistPath = agentPlistPath(homedir());
  const domain = launchdDomain();
  process.stdout.write(
    bootOut(domain, 'uninstall')
      ? `Stopped ${AGENT_LABEL}\n`
      : `${AGENT_LABEL} was not running\n`,
  );
  if (existsSync(plistPath)) {
    rmSync(plistPath);
    process.stdout.write(`Removed ${plistPath}\n`);
  } else {
    process.stdout.write(`No plist at ${plistPath}\n`);
  }
  process.stdout.write(
    'The pack, the socket and the log are left alone; nothing else was touched.\n',
  );
}

/**
 * Failed opens before a supervised daemon exits to be restarted.
 *
 * Sixty, at the one-second retry, so a minute of a genuinely absent panel.
 * Long enough that unplugging to move a monitor does not churn the process,
 * short enough that a moved port is answered while somebody is still at the
 * desk to notice.
 */
const GIVE_UP_AFTER = 60;

/**
 * What to type — printed for a missing device, an unknown command, and
 * anything help-shaped.
 *
 * In the form that works from a fresh clone.
 * `pnpm tamaclaude …` rather than a bare `tamaclaude`, because the CLI is a
 * workspace bin: `pnpm install` links nothing into `node_modules/.bin`, so the
 * bare form is `command not found` until somebody has run `pnpm setup` and
 * `pnpm link`. Printing a command the reader cannot run is worst exactly where
 * this text appears — a typo, a missing device, or the upgraded-node remedy in
 * `agent.ts`, none of which happen with `docs/INSTALL.md` open.
 */
const USAGE =
  'usage: pnpm tamaclaude daemon [device]\n' +
  '       pnpm tamaclaude pack\n' +
  '  with no device, the panel is found by its USB descriptor\n' +
  '  e.g. pnpm tamaclaude daemon /dev/cu.usbmodem1101\n' +
  '  the pack comes from $TAMACLAUDE_PACK, else ~/.tamaclaude/pack/\n' +
  '  `pnpm tamaclaude pack` says which one, and when its birthday fires\n' +
  '  with no command, prints one line of smoke-test output\n' +
  '       pnpm tamaclaude install-agent [--apply]\n' +
  '  starts the daemon at login; dry run unless --apply\n' +
  '       pnpm tamaclaude uninstall-agent\n' +
  '  stops it and stops it coming back\n' +
  '       pnpm tamaclaude status\n' +
  '  asks launchd whether it is actually running\n';

async function devicePathFor(
  argv: readonly string[],
  supervised: boolean,
): Promise<string> {
  // **Discovery runs only when nothing was named.** It used to run first and
  // unconditionally, so `tamaclaude daemon /dev/cu.usbmodem1101` — the escape
  // hatch, and what gets typed during the soak week — still shelled to `ioreg`
  // and `plutil` and died if either did. An override whose whole value is
  // working when discovery does not must not be built on discovery.
  const given = argv[0];
  const chosen = chooseDevice(
    given,
    given === undefined ? await findPanels(nodeUsb()) : [],
  );
  if ('refusal' in chosen) {
    // No usage block: see `refusalReport`. An unplugged cable is a runtime
    // condition, and printing the command line's own documentation for it sent
    // the reader to check an argument list that was already correct.
    const { text, code } = refusalReport(chosen, supervised);
    process.stderr.write(text);
    process.exit(code);
  }
  return chosen.path;
}

/**
 * `tamaclaude daemon` — listen, render, and drive the panel until killed.
 */
async function daemon(argv: readonly string[]): Promise<void> {
  // **Before `devicePathFor`, which is where this exits.** The growth being
  // bounded is driven by the no-panel restart loop, and that loop never gets
  // past device discovery — so a rotation placed after it would run only on
  // the starts that were never the problem. It is a no-op in a terminal:
  // `rotateDaemonLog` refuses any stdout that is not the log file itself.
  process.stdout.write(capDaemonLog(homedir()));
  // **Flags are not device paths.** Adding `--supervised` to the plist made
  // `argv[0]` a flag, which `chooseDevice` cheerfully accepted as the device
  // to open — so the agent would have spent forever retrying a port called
  // `--supervised` while discovery, right there, was never consulted. Caught
  // before it shipped, and it is the same shape as the finding a review made
  // one commit earlier about discovery running when a device was named.
  const supervised = argv.includes('--supervised');
  const devicePath = await devicePathFor(
    argv.filter((argument) => !argument.startsWith('--')),
    supervised,
  );
  // Resolved before the socket is opened, so a bad pack fails without leaving
  // a listener behind.
  const resolved = resolvePack();
  // **`--supervised` is how the daemon learns it will be restarted.**
  //
  // Without it the reconnect loop retries the same path forever, which is
  // right for a person watching a terminal and wrong under an agent: macOS
  // derives `/dev/cu.usbmodem1101` from the USB *port*, so moving the panel to
  // the socket next to it changes the path, and the daemon would retry the old
  // one until the machine was rebooted while the glass held its last frame.
  // Nothing red, `tamaclaude pack` still correct, and it recurs on every desk
  // move.
  //
  // With it, the loop gives up after a minute and this process exits non-zero.
  // `KeepAlive` starts it again, `chooseDevice` runs discovery afresh, and the
  // panel is found wherever it now is. The supervisor this branch installs is
  // the rediscovery mechanism; teaching `panel.ts` to rediscover would mean
  // the device package choosing its own port, which is the caller's job.
  /*
   * Quiet hours come from the environment, not the pack and not a flag.
   *
   * The pack is the recipient's *content*; the hours somebody sleeps are a
   * property of their desk, and putting them in a manifest would mean a schema
   * change for a setting one machine has. A flag would mean the launchd plist
   * carrying it anyway, which is where it ends up either way — beside
   * `TAMACLAUDE_PACK`, off this public repo, and absent by default so nothing
   * changes for anybody who has not set it.
   *
   * Unreadable is off, deliberately: see `quiet.ts` §WINDOW. A window this
   * misread would be a dark panel at the wrong time with nothing saying why.
   */
  const running = await runDaemon({
    socketPath: defaultSocketPath(),
    devicePath,
    pack: resolved.manifest,
    quiet: quietGate(process.env['TAMACLAUDE_QUIET']),
    giveUpAfter: supervised ? GIVE_UP_AFTER : undefined,
    onGiveUp: supervised
      ? (): void => {
          process.stderr.write(
            `no panel at ${devicePath} after ${String(GIVE_UP_AFTER)} tries; exiting so the agent can look again\n`,
          );
          process.exit(1);
        }
      : undefined,
  });
  // The pack is named on the startup line, not just the socket. The failure
  // this whole file is arranged against is a *valid* pack that is the wrong
  // one, which no schema can catch — so the cheapest possible check is putting
  // the answer in the terminal every time the daemon starts.
  process.stdout.write(
    `listening on ${defaultSocketPath()}\n` +
      `pack ${describePack(resolved)}\n`,
  );
  // Stopped on a signal rather than left to the process teardown, so the
  // socket file goes with it — `socket-server.ts` only removes a path it can
  // still prove is its own, and it cannot prove that after the process is gone.
  const stop = (): void => {
    void running.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/**
 * The default command: load the real pack, push one event through the real
 * session pipeline, print what the panel would show.
 *
 * It exists because five of the six gates can be green while this binary
 * throws on its first line — which is exactly what happened when the pack
 * schema tightened underneath it. One event is enough to prove the whole path
 * is wired; the daemon's own tests prove the path is right.
 *
 * It was called `main` and its documentation ended up above `daemon` when that
 * was added — the stranded-doc class `tools/detached-docs.test.ts` exists for,
 * caught by that gate on the first run.
 */
function smoke(): void {
  const state = createDaemon(resolvePack().manifest, []);
  const now = Date.now();
  const sessions = observe(
    createRegistry(now),
    { sessionId: 'placeholder', kind: 'PreToolUse', tool: 'Bash' },
    now,
  );
  const panel = resolvePanel(sessions, now);
  process.stdout.write(
    `pack=${state.pack.name} state=${panel.state} ` +
      `animation=${animationFor(panel.state, { tool: panel.tool })}\n`,
  );
}

/**
 * The failures this CLI composes a sentence for, printed without their stack.
 *
 * Everything else keeps the stack: a `TypeError` from a real bug arriving as
 * one context-free line is an hour lost on a day that cannot move.
 *
 * **The pack clauses were missing and every pack failure printed a stack** —
 * which is the one class of error whose whole value is the sentence, since it
 * names the path you got wrong. Found by a spec review before the resolver
 * shipped, so no version of this ever ran that way.
 */
const KNOWN =
  /already listening|not a socket|over the .*-byte limit|no pack configured|could not read the pack|is not a valid pack|TAMACLAUDE_PACK is set but empty|needs launchd/;

/** The subset of `KNOWN` meaning "not usable as typed" rather than "it failed". */
const MISCONFIGURED = /no pack configured|TAMACLAUDE_PACK is set but empty/;

const [, , command, ...rest] = process.argv;
// **One try/catch around every command, not just `daemon`.** `smoke()` used to
// sit outside it, so the one command that exists to prove the binary starts was
// also the one whose failure arrived as a raw stack. Now that both commands
// load a pack, that gap would have been the first thing a person hit.
try {
  if (command === 'daemon') {
    await daemon(rest);
  } else if (command === 'pack') {
    pack();
  } else if (command === 'install-agent') {
    await installAgent(rest);
  } else if (command === 'uninstall-agent') {
    uninstallAgent();
  } else if (command === 'status') {
    status();
  } else if (command === undefined) {
    smoke();
  } else {
    // Not the smoke test. `tamaclaude frobnicate` used to print a cheerful
    // `pack=example state=WORKING` and exit 0, so a typo of `daemon` looked
    // like a successful run of something. With the usage, because the two most
    // likely things typed here are a typo of `daemon` and something
    // help-shaped.
    process.stderr.write(`${USAGE}unknown command: ${command}\n`);
    process.exit(2);
  }
} catch (cause) {
  const line =
    cause instanceof Error
      ? KNOWN.test(cause.message)
        ? cause.message
        : (cause.stack ?? cause.message)
      : String(cause);
  process.stderr.write(`${line}\n`);
  // 2 rather than 1 for a pack that was never configured, and for one named
  // by an empty variable: the command was not usable as typed, rather than
  // something failing while it ran. (This used to say "the same class as a
  // missing device path, which already exits 2". A missing device path is
  // exactly the opposite class — it is a runtime condition, and since 29 Aug
  // it exits `EXIT_NO_PANEL`. The conclusion for a bad pack stands; the
  // comparison it rested on does not.) The distinction is not cosmetic, because
  // the launchd agent in `BUILD_PLAN.md` Stage 3 is what will meet these
  // failures, and a wrapper that retries a crash should not retry a typo.
  process.exit(MISCONFIGURED.test(line) ? 2 : 1);
}
