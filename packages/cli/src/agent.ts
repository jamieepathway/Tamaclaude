/**
 * The launchd agent: what starts the daemon when nobody is watching.
 *
 * Everything the pack resolver assumes rests on this file. `pack.ts` refuses
 * to start without a pack, on the grounds that failing loudly beats rendering
 * the wrong one — and a spec review pointed out that loud is only loud if
 * somebody is listening. Under an agent, nobody is. So this writes the log
 * path into the plist, and refuses to install at all if the pack it would use
 * cannot be loaded.
 *
 * ## Three ways a plist fails silently, and what stops each
 *
 * | Risk | What stops it |
 * | ---- | ------------- |
 * | Fails to spawn: `PATH` has no node | `ProgramArguments[0]` is `process.execPath`, never the shebang |
 * | Crash-loops on a Mac with no pack | `--apply` resolves the pack first and refuses |
 * | Second install leaves the old agent running | `bootout` before `bootstrap`, always |
 *
 * The first is not hypothetical. `index.ts` begins `#!/usr/bin/env node`, and
 * launchd hands an agent `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Node is in none
 * of those on a machine using a version manager, which is this one. A plist
 * naming the script would fail to exec every ten seconds forever, with the
 * panel showing whatever it last showed. `packages/hooks/src/install.ts`
 * already writes `process.execPath` for the same reason.
 *
 * ## What the plist deliberately does not carry
 *
 * **A device path.** The panel is found by its USB descriptor, so hardcoding
 * `/dev/cu.usbmodem1101` would break the first time it moved USB port —
 * macOS derives that number from the port, not the board.
 *
 * ## What it deliberately does carry
 *
 * **Both environment variables, named explicitly.** The obvious choice is to
 * set none, since the pack has a default location and the socket has one too.
 * But a launchd agent does not inherit a login shell's environment while the
 * hook, spawned by Claude Code, generally does. If either variable is set in a
 * profile the two bind to different values, the hook's failure is swallowed by
 * the `2>/dev/null || true` that `hook-settings.ts` appends, and `tamaclaude
 * pack` in a terminal answers for a process that is not the agent — the
 * silent-wrong-pack failure arriving through the tool built to detect it.
 * Naming them also makes `launchctl print` ground truth rather than a guess.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { EXIT_NO_PANEL } from './device.js';

/** The agent's launchd label, and the basename of its plist. */
export const AGENT_LABEL = 'com.tamaclaude.daemon';

export type AgentOptions = {
  /** The real node binary, not a shim and not the shebang. */
  readonly node: string;
  /** Absolute path to the CLI's built entry point. */
  readonly script: string;
  readonly pack: string;
  readonly socket: string;
  readonly log: string;
  /**
   * Quiet hours, carried through a reinstall rather than invented here.
   *
   * Optional because it is the one setting with no default: absent means the
   * panel behaves as it always did. `index.ts` reads the existing window off
   * the running job before rewriting the plist, so `install-agent --apply`
   * preserves it. It used to delete it — silently, on the command
   * `docs/INSTALL.md` prescribes whenever node moves, which is the worst
   * possible place to lose a setting.
   */
  readonly quiet?: string;
};

/**
 * Escape a string for XML character data.
 *
 * A plist is XML, which JSON was not, so `install-hooks` never had this
 * problem and its defences do not cover it. A home directory or a checkout
 * containing `&` or `<` is ordinary and would produce a file launchd silently
 * refuses to load.
 */
function xml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Where the plist belongs. */
export function agentPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

/**
 * The plist, as text.
 *
 * A pure function so the shape can be tested without writing to anyone's
 * `LaunchAgents`, and so `plutil -lint` — the same parse launchd performs —
 * can be run over the result in a test rather than discovered on 19 September.
 *
 * `ThrottleInterval` is 30 rather than the default 10, and the reason is that
 * **one restart loop is deliberate**.
 *
 * The table above says this file makes loops unreachable, and that is true of
 * the ones that mean something is wrong — a missing pack, a node that will not
 * spawn. It is not true of an unplugged panel: the daemon exits
 * `EXIT_NO_PANEL` when discovery finds none, `KeepAlive` restarts, and
 * discovery runs again. That restart *is* the hotplug mechanism. (It said
 * `chooseDevice` exits 2 until 29 Aug, wrong on both halves — `chooseDevice`
 * returns rather than exits, and an absent panel has had its own code since
 * that message stopped being a usage error.) A review pointed out the file claimed otherwise
 * while relying on it, which is worse than either choice on its own.
 *
 * So the interval is a pace rather than a fix. Thirty seconds is slow enough
 * that a genuine fault reads as a fault, and fast enough that plugging the
 * panel back in is answered within half a minute. It also matters that a loop
 * which got as far as opening the port resets the board on every respawn: at
 * the default ten the panel would flash its boot splash continually.
 */
export function agentPlist(options: AgentOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.node)}</string>
    <string>${xml(options.script)}</string>
    <string>daemon</string>
    <string>--supervised</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TAMACLAUDE_PACK</key>
    <string>${xml(options.pack)}</string>
    <key>TAMACLAUDE_SOCKET</key>
    <string>${xml(options.socket)}</string>${
      options.quiet === undefined
        ? ''
        : `
    <key>TAMACLAUDE_QUIET</key>
    <string>${xml(options.quiet)}</string>`
    }
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(options.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.log)}</string>
</dict>
</plist>
`;
}

/**
 * What `install-agent` would do, as text a person can check before it happens.
 *
 * Everything that matters is a path resolved at install time and invisible
 * afterwards — which node, which script, which pack, where the log goes. A
 * review's standing question is whether this survives being handed on, and the
 * honest answer was no: it all lived in the installer's head. So the dry run
 * prints all of it, and prints it again on `--apply`.
 */
export function describeAgentInstall(
  options: AgentOptions,
  plistPath: string,
  alreadyInstalled: boolean,
): string {
  return (
    `agent      ${AGENT_LABEL}\n` +
    `plist      ${plistPath}${alreadyInstalled ? ' (replacing the one already there)' : ''}\n` +
    `node       ${options.node}\n` +
    `script     ${options.script}\n` +
    `pack       ${options.pack}\n` +
    `socket     ${options.socket}\n` +
    `log        ${options.log}\n`
  );
}

export type AgentStatus = {
  readonly loaded: boolean;
  readonly pid?: number;
  readonly lastExit?: number;
};

/**
 * What `launchctl list <label>` says, as something to reason about.
 *
 * **A job can be loaded and still not be running.** `launchctl bootstrap`
 * exits 0 once the job is *loaded*, which says nothing about whether it stayed
 * up — so `install-agent` printing "Installed and started" was a claim it had
 * not checked. The most likely install-day sequence is precisely the one it
 * would have hidden: a `tamaclaude daemon` already running by hand from the
 * soak week, the agent starting, `socket-path.ts` finding a live listener,
 * `already listening`, exit 1, and a restart every thirty seconds forever
 * while stdout said it was fine.
 *
 * A pure function over the text so the parse is testable without launchd. The
 * shape is `launchctl list`'s dictionary: `"PID" = 1234;` while running, and
 * `"LastExitStatus" = 256;` for the previous run.
 */
export function parseAgentStatus(text: string | undefined): AgentStatus {
  if (text === undefined) return { loaded: false };
  const pid = /"PID"\s*=\s*(\d+);/u.exec(text)?.[1];
  const exit = /"LastExitStatus"\s*=\s*(-?\d+);/u.exec(text)?.[1];
  return {
    loaded: true,
    pid: pid === undefined ? undefined : Number(pid),
    lastExit: exit === undefined ? undefined : Number(exit),
  };
}

/**
 * What the agent is actually doing, as something other than a sentence.
 *
 * **Two commands ask the same question and used to answer it separately.**
 * `status` rendered a line; `install-agent --apply` re-derived "is it running"
 * from `pid === undefined` alone. So the install could print "waiting for a
 * panel — plug it in and it starts itself" and, on the next line, "It is not
 * running. The log is at …" — the same fact in two moods, and a pointer at the
 * log for precisely the condition PR #70 stopped pointing at the log for.
 *
 * A kind rather than a string, for the reason `device.ts` gives at length: a
 * caller that re-reads the rendered text couples itself to the wording, and an
 * ordinary edit to the wording reverts the behaviour with every gate green.
 * That is not hypothetical here either — it is the exact mutant a review
 * planted in `refusalReport`.
 */
export type AgentCondition =
  | 'not-installed'
  | 'node-gone'
  | 'running'
  /** Loaded, not running, and the last run ended cleanly or never happened. */
  | 'idle'
  | 'waiting-for-panel'
  | 'failed';

/**
 * Classify a status, so two callers cannot reach different verdicts about it.
 *
 * The single place a condition is *decided*. `describeAgentStatus` takes the
 * raw number apart again in its `failed` branch, but only to render the digits
 * — no branch of this function is re-run there, which is what stops the two
 * drifting.
 *
 * `LastExitStatus` is a raw `wait(2)` status, not an exit code: exit 1 comes
 * back as 256, and a signalled death puts the signal in the low seven bits.
 */
export function agentCondition(
  status: AgentStatus,
  nodeExists: boolean,
): AgentCondition {
  if (!status.loaded) return 'not-installed';
  if (!nodeExists) return 'node-gone';
  if (status.pid !== undefined) return 'running';
  const exit = status.lastExit;
  if (exit === undefined || exit === 0) return 'idle';
  const signal = exit & 0x7f;
  // **An absent panel is not a fault, and it used to read as one.** The daemon
  // exits `EXIT_NO_PANEL` when discovery finds nothing, which is what happens
  // every time the cable comes out. Sending that to the log made the ordinary
  // case look like the broken one — and the log is where the genuinely
  // ambiguous failures live.
  if (signal === 0 && exit >> 8 === EXIT_NO_PANEL) return 'waiting-for-panel';
  return 'failed';
}

/**
 * One line a person can act on, given a status and whether node still exists.
 *
 * The `nodeExists` half is the one nobody would think to check.
 * `ProgramArguments[0]` is `process.execPath`, which on every version manager
 * — mise, nvm, asdf, Homebrew — contains the version number. The day node is
 * upgraded and the old version pruned, launchd fails to spawn, retries
 * forever, and the panel holds the last frame it was sent. `tamaclaude pack`
 * run from a terminal answers perfectly, because it runs under the *shell's*
 * node. This is the only thing that would say otherwise.
 */
export function describeAgentStatus(
  status: AgentStatus,
  nodeExists: boolean,
): string {
  switch (agentCondition(status, nodeExists)) {
    case 'not-installed':
      return 'agent     not installed';
    case 'node-gone':
      return (
        'agent     loaded, but the node it was installed with is gone\n' +
        '          re-run `pnpm tamaclaude install-agent --apply` to point it at the current one'
      );
    case 'running':
      return `agent     running (pid ${String(status.pid)})`;
    case 'idle':
      return 'agent     loaded, not running';
    case 'waiting-for-panel':
      return (
        'agent     loaded, waiting for a panel — plug it in and it starts itself\n' +
        '          (`pnpm tamaclaude install-agent` prints the device it would use)'
      );
    case 'failed': {
      // Printing the wait status undecoded made the one number a person needs
      // into a number they would have to look up. The `?? 0` is unreachable —
      // an undefined `lastExit` classifies as `idle` — and is here because the
      // compiler cannot see that from the switch.
      const exit = status.lastExit ?? 0;
      const signal = exit & 0x7f;
      const detail =
        signal === 0 ? `exit ${String(exit >> 8)}` : `signal ${String(signal)}`;
      return `agent     loaded but not running; last ${detail} — see the log`;
    }
  }
}

/**
 * The last line of `install-agent --apply`: what was installed, and whether
 * there is anything left to do.
 *
 * Takes the condition rather than the status so it cannot disagree with the
 * line printed immediately above it — which is the whole defect this exists to
 * fix. Only three outcomes matter here: it is running, it is waiting for
 * hardware nobody has plugged in yet, or something needs diagnosing and the
 * log is where that happens.
 */
export function describeInstallOutcome(
  condition: AgentCondition,
  log: string,
): string {
  if (condition === 'running') {
    return `Installed and running. Logs go to ${log}\n`;
  }
  if (condition === 'waiting-for-panel') {
    return 'Installed. Plug the panel in and it starts itself within thirty seconds; there is nothing else to run.\n';
  }
  return `Installed, but it is not running. The log is at ${log}\n`;
}

/** What `launchctl list` says about our label, or undefined if it says nothing. */
export function agentListing(): string | undefined {
  try {
    return execFileSync('launchctl', ['list', AGENT_LABEL], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined; // Not loaded.
  }
}

/**
 * The running job's own environment, via `launchctl print`.
 *
 * **`agentListing` cannot answer this and it is not obvious why.** `launchctl
 * list` prints `ProgramArguments`, `Program`, `PID` and the exit status, and
 * omits `EnvironmentVariables` entirely — measured against a job whose plist
 * carries three of them. `launchctl print` prints an `environment` block with
 * the values the process was actually given, which is the difference between
 * what is configured and what is in force.
 *
 * Both are kept because they answer different questions: `list` is the cheap
 * "is it loaded and what did it exit with", this is "and what does it think it
 * is doing".
 */
export function agentEnvironment(): string | undefined {
  try {
    return execFileSync(
      'launchctl',
      ['print', `gui/${String(process.getuid?.() ?? 0)}/${AGENT_LABEL}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return undefined; // Not loaded.
  }
}
