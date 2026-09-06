import { describe, expect, it } from 'vitest';

import {
  describeQuietHours,
  isQuiet,
  parseQuietHours,
  QUIET_WAKE_MS,
  quietSpecIn,
} from './quiet.js';

/** A local-time moment, because the window is local. See `quiet.ts`. */
function at(hour: number, minute = 0): number {
  const when = new Date();
  when.setHours(hour, minute, 0, 0);
  return when.getTime();
}

describe('reading the window', () => {
  it('reads a window that crosses midnight', () => {
    expect(parseQuietHours('23:00-07:00')).toEqual({
      from: 23 * 60,
      to: 7 * 60,
    });
  });

  it('reads one that does not', () => {
    expect(parseQuietHours('09:30-17:45')).toEqual({
      from: 9 * 60 + 30,
      to: 17 * 60 + 45,
    });
  });

  it('is off when unset, which is the default everywhere but one plist', () => {
    expect(parseQuietHours(undefined)).toBeUndefined();
    expect(parseQuietHours('')).toBeUndefined();
  });

  it('refuses anything it cannot read rather than guessing', () => {
    // A misread window is a panel that is dark at the wrong time, with nothing
    // to say why. Off is the safe failure: the panel behaves as it always has.
    for (const bad of [
      '23:00',
      '23-07',
      '25:00-07:00',
      '23:60-07:00',
      'nope',
    ]) {
      expect(parseQuietHours(bad), bad).toBeUndefined();
    }
  });
});

describe('deciding whether to go quiet', () => {
  const night = { from: 23 * 60, to: 7 * 60 };

  it('is not quiet when no window is configured', () => {
    expect(isQuiet(undefined, at(3), undefined)).toBe(false);
  });

  it('is quiet inside a window that crosses midnight', () => {
    expect(isQuiet(night, at(23, 30), at(23, 30) - QUIET_WAKE_MS)).toBe(true);
    expect(isQuiet(night, at(3), at(3) - QUIET_WAKE_MS)).toBe(true);
  });

  it('is not quiet outside it', () => {
    expect(isQuiet(night, at(12), at(12) - QUIET_WAKE_MS)).toBe(false);
    expect(isQuiet(night, at(22, 59), at(22, 59) - QUIET_WAKE_MS)).toBe(false);
    expect(isQuiet(night, at(7), at(7) - QUIET_WAKE_MS)).toBe(false);
  });

  it('wakes for somebody still working, which is the whole point', () => {
    // Measured against the person, not the clock. A window that blanked the
    // panel mid-session would be a worse bug than the lamp it replaced.
    expect(isQuiet(night, at(1, 40), at(1, 40) - 1000)).toBe(false);
  });

  it('goes back to quiet once they stop', () => {
    expect(isQuiet(night, at(1, 40), at(1, 40) - QUIET_WAKE_MS - 1)).toBe(true);
  });

  it('is quiet when nothing has ever happened', () => {
    expect(isQuiet(night, at(3), undefined)).toBe(true);
  });

  it('handles a window that does not cross midnight', () => {
    const day = { from: 9 * 60, to: 17 * 60 };
    expect(isQuiet(day, at(12), undefined)).toBe(true);
    expect(isQuiet(day, at(20), undefined)).toBe(false);
    expect(isQuiet(day, at(3), undefined)).toBe(false);
  });
});

describe('saying so in `status`', () => {
  const night = { from: 23 * 60, to: 7 * 60 };

  it('says nothing when the feature is off', () => {
    // `status` stays terse for the people who never set this. There is no dark
    // panel to explain if nothing can darken it.
    expect(describeQuietHours(undefined, at(3))).toBeUndefined();
  });

  it('names the window, and says the panel is meant to be dark', () => {
    // The whole reason this line exists: a black panel at midnight should
    // never be a mystery, and `main.c` no longer lets "dark" mean "fault".
    const line = describeQuietHours(night, at(1));
    expect(line).toContain('23:00-07:00');
    expect(line).toMatch(/dark now/);
    expect(line).toContain('07:00');
  });

  it('names the window without alarm when it is not in force', () => {
    const line = describeQuietHours(night, at(12));
    expect(line).toContain('23:00-07:00');
    expect(line).not.toMatch(/dark now/);
  });
});

describe('finding the window the daemon is actually using', () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TAMACLAUDE_PACK</key>
    <string>/Users/someone/.tamaclaude/pack</string>
    <key>TAMACLAUDE_QUIET</key>
    <string>23:00-07:00</string>
  </dict>
</dict></plist>`;

  const running = `\tenvironment = {
\t\tTAMACLAUDE_SOCKET => /Users/someone/.tamaclaude/daemon.sock
\t\tTAMACLAUDE_PACK => /Users/someone/.tamaclaude/pack
\t\tTAMACLAUDE_QUIET => 22:00-08:00
\t}`;

  it('prefers the running job over the file on disk', () => {
    // These disagree exactly when somebody edited the plist and did not
    // reload, which — before `install-agent` learned to carry the window — was
    // the only way to set it at all. Reporting the file would describe a
    // window the daemon has never heard of.
    expect(quietSpecIn({ running, plist })).toBe('22:00-08:00');
  });

  it('falls back to the file when the job is not loaded', () => {
    expect(quietSpecIn({ plist })).toBe('23:00-07:00');
  });

  it('falls back to the environment for a daemon run by hand', () => {
    expect(quietSpecIn({ env: '09:00-17:00' })).toBe('09:00-17:00');
  });

  it('does not confuse it with the pack sitting next to it', () => {
    expect(quietSpecIn({ plist })).not.toContain('pack');
    expect(quietSpecIn({ running })).not.toContain('daemon.sock');
  });

  it('is nothing when no source has it', () => {
    expect(quietSpecIn({})).toBeUndefined();
    expect(quietSpecIn({ plist: '<plist><dict/></plist>' })).toBeUndefined();
  });

  it('says so when the file and the running job disagree', () => {
    // The whole point of preferring the running job is that a person can be
    // looking at a lit panel while the plist promises darkness. Saying which
    // is in force, and that a reload would close the gap, is cheaper than
    // letting them work it out.
    const line = describeQuietHours(
      parseQuietHours(quietSpecIn({ running, plist })),
      at(23, 30),
      { stale: true },
    );
    expect(line).toMatch(/reload|install-agent/i);
  });
});
