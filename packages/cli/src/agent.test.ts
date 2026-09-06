import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_LABEL,
  agentPlist,
  describeAgentStatus,
  describeInstallOutcome,
  parseAgentStatus,
} from './agent.js';
import { EXIT_NO_PANEL } from './device.js';

/**
 * The value element following a `<key>` in the generated plist.
 *
 * A regex rather than a parser, and text rather than `plutil`, because **CI
 * runs `ubuntu-latest` and `plutil` is macOS-only** — a review found this file
 * would have turned CI red the moment it was pushed. The document is generated
 * by a template in this repo, so its shape is known; parsing it properly to
 * assert on a string we wrote would be ceremony.
 */
function plistValue(xml: string, key: string): string {
  const match = new RegExp(
    `<key>${key}</key>\\s*(<[a-z]+/>|<[a-z]+>[^<]*</[a-z]+>)`,
    'u',
  ).exec(xml);
  return match?.[1] ?? '(missing)';
}

describe('agentPlist', () => {
  const made: string[] = [];
  afterEach(() => {
    made.splice(0).forEach((dir) => {
      rmSync(dir, { recursive: true, force: true });
    });
  });

  const options = {
    node: '/opt/node/bin/node',
    script: '/opt/tamaclaude/dist/index.js',
    pack: '/Users/someone/.tamaclaude/pack',
    socket: '/Users/someone/.tamaclaude/daemon.sock',
    log: '/Users/someone/.tamaclaude/daemon.log',
  };

  it('runs node directly rather than trusting the shebang', () => {
    // **The bug this exists to prevent.** `index.ts` starts
    // `#!/usr/bin/env node`, and launchd gives an agent
    // `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Node is not there — on this
    // machine it is under a version manager in the user's home — so a plist
    // naming the script would fail to spawn, every ten seconds, forever, with
    // nothing on the glass to say why. `install-hooks` already solved this by
    // writing `process.execPath` into the command it registers.
    const xml = agentPlist(options);
    expect(xml).toContain('<string>/opt/node/bin/node</string>');
    expect(xml).toContain('<string>/opt/tamaclaude/dist/index.js</string>');
    // And `daemon --supervised` with no device: the panel is found by
    // descriptor, so a hardcoded path would break the moment it moved USB
    // port — and `--supervised` is what tells the daemon something will
    // restart it, so giving up on a dead path is rediscovery rather than
    // surrender.
    expect(xml).toContain('<string>daemon</string>');
    expect(xml).toContain('<string>--supervised</string>');
    expect(xml).not.toContain('/dev/cu.');
  });

  // `plutil` is macOS-only and CI is `ubuntu-latest`, so this one is skipped
  // there — **and skipped means not gated, not "fine"**. The escaping itself is
  // asserted on the text above, which runs everywhere; what only Darwin can
  // check is that launchd's own parser accepts the result, which is the part
  // no amount of string comparison substitutes for.
  it.skipIf(process.platform !== 'darwin')(
    'escapes a path that would otherwise corrupt the XML',
    () => {
      // A home directory or a repo checkout containing `&` or `<` is ordinary,
      // and JSON did not have this problem so `install-hooks` never met it.
      const dir = mkdtempSync(join(tmpdir(), 'tamaclaude-agent-'));
      made.push(dir);
      const xml = agentPlist({
        ...options,
        pack: "/Users/a & b/<pack>/it's here",
      });
      expect(xml).toContain('&amp;');
      expect(xml).not.toContain('& b');
      // Proven by the parser rather than by inspection: `plutil -lint` is the
      // same check launchd applies, and it is free.
      const file = join(dir, 'test.plist');
      writeFileSync(file, xml);
      expect(() => execFileSync('plutil', ['-lint', file])).not.toThrow();
      // And it round-trips: the value comes back exactly as it went in.
      const back = execFileSync(
        'plutil',
        ['-convert', 'json', '-o', '-', file],
        {
          encoding: 'utf8',
        },
      );
      expect(
        (
          JSON.parse(back) as {
            EnvironmentVariables: { TAMACLAUDE_PACK: string };
          }
        ).EnvironmentVariables.TAMACLAUDE_PACK,
      ).toBe("/Users/a & b/<pack>/it's here");
    },
  );

  it('escapes a path that would otherwise corrupt the XML, on any platform', () => {
    // The text half of the escaping check, which CI can actually run. The
    // `plutil` half below proves launchd's parser agrees, and only on a Mac.
    const xml = agentPlist({
      ...options,
      pack: "/Users/a & b/<pack>/it's here",
    });
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;pack&gt;');
    expect(xml).not.toContain('& b');
    expect(xml).not.toContain('<pack>');
  });

  it('carries every key that makes it an agent rather than a file', () => {
    // **Each of these survived deletion until a review planted them.** The
    // suite asserted three strings and the escaping, so removing `RunAtLoad`
    // — the one thing the plist exists for — left it green, as did dropping
    // the log paths, flipping `SuccessfulExit`, swapping node for the script,
    // and emptying the socket. The round trip on real hardware proved the file
    // works today; it does not stop the next edit breaking it.
    const xml = agentPlist(options);
    expect(plistValue(xml, 'RunAtLoad')).toBe('<true/>');
    // False, so launchd restarts it on a non-zero exit and leaves a clean one
    // alone. `man 5 launchd.plist`: "restarted in the inverse condition".
    expect(plistValue(xml, 'SuccessfulExit')).toBe('<false/>');
    expect(plistValue(xml, 'ThrottleInterval')).toBe('<integer>30</integer>');
    expect(plistValue(xml, 'StandardOutPath')).toBe(
      `<string>${options.log}</string>`,
    );
    expect(plistValue(xml, 'StandardErrorPath')).toBe(
      `<string>${options.log}</string>`,
    );
    expect(plistValue(xml, 'TAMACLAUDE_PACK')).toBe(
      `<string>${options.pack}</string>`,
    );
    expect(plistValue(xml, 'TAMACLAUDE_SOCKET')).toBe(
      `<string>${options.socket}</string>`,
    );
    // Order matters: node runs the script, not the other way round.
    expect(xml.indexOf(options.node)).toBeLessThan(xml.indexOf(options.script));
  });

  it('names the pack and the socket, so the agent and a terminal agree', () => {
    // A launchd agent does not inherit a login shell's environment. If either
    // variable is set in a profile, `tamaclaude pack` in a terminal answers
    // for a different process than the one driving the panel — which is the
    // silent-wrong-pack failure arriving through the tool built to detect it.
    // Naming them here also makes `launchctl print` ground truth.
    const xml = agentPlist(options);
    expect(xml).toContain('TAMACLAUDE_PACK');
    expect(xml).toContain('TAMACLAUDE_SOCKET');
    expect(xml).toContain(AGENT_LABEL);
  });
});

describe('parseAgentStatus', () => {
  // Real `launchctl list com.tamaclaude.daemon` output, trimmed.
  const running = `{
	"StandardOutPath" = "/Users/someone/.tamaclaude/daemon.log";
	"Label" = "com.tamaclaude.daemon";
	"LastExitStatus" = 0;
	"PID" = 29979;
}`;
  const crashed = `{
	"Label" = "com.tamaclaude.daemon";
	"LastExitStatus" = 256;
}`;

  it('reads a running agent', () => {
    expect(parseAgentStatus(running)).toEqual({
      loaded: true,
      pid: 29979,
      lastExit: 0,
    });
    expect(describeAgentStatus(parseAgentStatus(running), true)).toContain(
      'running (pid 29979)',
    );
  });

  it('says nothing is installed when launchctl said nothing', () => {
    expect(parseAgentStatus(undefined)).toEqual({ loaded: false });
    expect(describeAgentStatus({ loaded: false }, true)).toContain(
      'not installed',
    );
  });

  it('decodes the wait status, because 256 is not an exit code', () => {
    // **The case this whole pair exists for.** `bootstrap` exits 0 once the
    // job is loaded, which says nothing about whether it stayed up — and the
    // likeliest install-day failure is a `tamaclaude daemon` already running
    // by hand, so the agent dies on `already listening` and restarts every
    // thirty seconds while the installer says it worked. Reproduced on real
    // hardware: `LastExitStatus = 256`.
    //
    // 256 is a raw `wait(2)` status. The exit code is 1.
    expect(describeAgentStatus(parseAgentStatus(crashed), true)).toContain(
      'last exit 1',
    );
    // A signalled death reads as a signal rather than a nonsense exit code.
    expect(describeAgentStatus({ loaded: true, lastExit: 9 }, true)).toContain(
      'signal 9',
    );
  });

  it('notices the node it was installed with has gone', () => {
    // `ProgramArguments[0]` is `process.execPath`, which every version manager
    // stamps with a version number. Upgrade node, prune the old one, and
    // launchd fails to spawn forever — while `tamaclaude pack` in a terminal
    // answers perfectly, because it runs under the shell's node.
    const said = describeAgentStatus({ loaded: true, pid: 1 }, false);
    expect(said).toContain('node it was installed with is gone');
    // The invocation form, not just the subcommand: `install-agent --apply`
    // is a substring of the bare form too, so asserting it left the decision
    // this remedy exists to carry entirely unpinned.
    expect(said).toContain('pnpm tamaclaude install-agent --apply');
  });
});

describe('describeAgentStatus', () => {
  const loaded = (lastExit: number) => ({ loaded: true, lastExit });

  it('names an absent panel instead of sending the reader to the log', () => {
    // `LastExitStatus` is a raw wait(2) status, so exit N arrives as N << 8.
    // The recipient will unplug the panel whenever the desk moves, and until
    // 29 Aug that read as `last exit 2 — see the log`, indistinguishable from
    // a broken install.
    const text = describeAgentStatus(loaded(EXIT_NO_PANEL << 8), true);
    expect(text).toContain('panel');
    expect(text).not.toContain('see the log');
  });

  it('still sends other failures to the log', () => {
    expect(describeAgentStatus(loaded(2 << 8), true)).toContain('see the log');
  });
});

describe('describeInstallOutcome', () => {
  it('does not send the reader to the log when a panel is merely absent', () => {
    // **The defect: the same fact in two moods.** `install-agent --apply`
    // printed `describeAgentStatus` — which since PR #70 says "waiting for a
    // panel" — and then, unconditionally on `pid === undefined`, "It is not
    // running. The log is at …". So the install reassured and alarmed in
    // consecutive lines, and pointed at the log for exactly the condition #70
    // stopped pointing at the log for.
    const text = describeInstallOutcome('waiting-for-panel', '/tmp/daemon.log');
    expect(text).not.toContain('/tmp/daemon.log');
    expect(text).not.toContain('not running');
    expect(text).toContain('panel');
  });

  it('does not tell a running install that it is not running', () => {
    // A review found the success path untested: an implementation that routed
    // `running` into the "Installed, but it is not running" branch passed the
    // whole suite, and would have sent somebody with a working panel to the
    // log to find out why it was broken.
    const text = describeInstallOutcome('running', '/tmp/daemon.log');
    expect(text).toContain('running');
    expect(text).not.toContain('not running');
  });

  it('still names the log for a failure a person has to diagnose', () => {
    expect(describeInstallOutcome('failed', '/tmp/daemon.log')).toContain(
      '/tmp/daemon.log',
    );
  });
});

describe('quiet hours survive a reinstall', () => {
  const options = {
    node: '/opt/node/bin/node',
    script: '/opt/tamaclaude/dist/index.js',
    pack: '/home/someone/.tamaclaude/pack',
    socket: '/home/someone/.tamaclaude/daemon.sock',
    log: '/home/someone/.tamaclaude/daemon.log',
  };

  it('carries a window into the plist when there is one', () => {
    // The bug: `install-agent --apply` rewrites the plist whole, and
    // `docs/INSTALL.md` tells people to run it whenever node moves. A window
    // that only ever got there by hand was deleted by the documented repair,
    // silently — no error, no log line, the panel just stops going dark.
    const xml = agentPlist({ ...options, quiet: '23:00-07:00' });
    expect(xml).toContain('<key>TAMACLAUDE_QUIET</key>');
    expect(xml).toContain('<string>23:00-07:00</string>');
  });

  it('writes no key at all when there is none', () => {
    // An empty string would parse as unreadable and mean "off", which is the
    // same behaviour — but it would also make every plist claim a setting
    // nobody chose, and `status` would have to special-case it.
    expect(agentPlist(options)).not.toContain('TAMACLAUDE_QUIET');
  });

  it('escapes it like every other value', () => {
    const xml = agentPlist({ ...options, quiet: '2<3' });
    expect(xml).toContain('2&lt;3');
    expect(xml).not.toContain('<string>2<3</string>');
  });
});
