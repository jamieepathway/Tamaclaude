/**
 * The `status` command, and the pack line inside it.
 *
 * **Its own module for the reason `midnight.ts` and `loop.ts` give**: quiet
 * hours added a line to this command and put `index.ts` over `max-lines`, and
 * "a file with no room for a thing is telling you where the thing goes".
 * Status is a clean thing to lift — it reads launchd, the filesystem and the
 * environment, and writes sentences. It decides nothing the rest of the CLI
 * needs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';

import {
  agentListing,
  agentPlistPath,
  describeAgentStatus,
  parseAgentStatus,
} from './agent.js';
import { daemonLogPath } from './log.js';
import { describePack, resolvePack } from './pack.js';
import { quietSpecIn, quietStatusLine } from './quiet.js';

/**
 * The pack line, including when there is no pack.
 *
 * **A report that dies on the thing it is reporting is not a report.**
 * `resolvePack` throws for every ordinary pack problem — not cloned yet, a
 * clone refused for access, the folder moved, `TAMACLAUDE_PACK` pointing at
 * nothing — and `status` used to let it. It printed the agent line, exited 2,
 * and never reached the log path. So the one command the printed card names
 * told somebody *with* a pack problem strictly less than it tells somebody
 * with no problem at all, and withheld the log path exactly when it was the
 * next thing to look at.
 *
 * Reported as a line and exit 0, for the reason the agent half already works
 * that way: `not installed` is a status, not a failure of the status command.
 * Found by running the built CLI under a home with no pack — the 19 Sep dry
 * run in miniature, done early because a guide is the artefact under test.
 */
function packStatus(): string {
  try {
    return describePack(resolvePack());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * `tamaclaude status` — is it actually working?
 *
 * **The command the printed card should name.** `tamaclaude pack` answers
 * "which pack", which is the question a schema cannot answer — but it runs in
 * the terminal's environment and under the terminal's node, so it answers
 * cheerfully while a launchd agent is failing to spawn every thirty seconds.
 * This asks launchd instead.
 */
export function status(): void {
  const listing = agentListing();
  const parsed = parseAgentStatus(listing);
  const node =
    /"ProgramArguments"\s*=\s*\(\s*"([^"]+)"/u.exec(listing ?? '')?.[1] ??
    process.execPath;
  process.stdout.write(`${describeAgentStatus(parsed, existsSync(node))}\n`);
  process.stdout.write(`pack      ${packStatus()}\n`);
  process.stdout.write(
    quietStatusLine(
      quietSpecIn(
        readIfPresent(agentPlistPath(homedir())),
        process.env['TAMACLAUDE_QUIET'],
      ),
    ),
  );
  process.stdout.write(`log       ${daemonLogPath(homedir())}\n`);
}

/** The plist, or nothing when the agent was never installed. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
