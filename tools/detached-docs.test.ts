import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { inBuildOutput } from './scan-scope.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Declarations carrying more than one TSDoc block.
 *
 * **What actually happens**, measured rather than assumed, because the first
 * version of this file got it wrong: TypeScript *binds* every block to the
 * declaration, and `tsc` emits all of them into the `.d.ts`. What takes only
 * the last one is the checker's documentation comment — which is what hover
 * shows, and what every tool reading `getDocumentationComment` sees. So a doc
 * written for one symbol and stranded above another does not vanish from the
 * file or the types; it vanishes from the place people read it.
 *
 * Three versions of this paragraph have tried to tally how often the class has
 * bitten, and all three got the count or the commits wrong. It is not tallied
 * here any more. What is stable is the shapes, each of which was found in this
 * repo by a review rather than by a gate:
 *
 * - A priming rule written for `Transport.send` bound to `status()`, and
 *   `observe`'s documentation taken by a constant inserted above it. Both in
 *   `d7ad4b9`, one commit.
 * - `render` — the renderer's public entry point — emitted with no doc at all,
 *   because its block sat above `withEnvironment`; and `hook-settings.ts`
 *   carrying two blocks for one constant. Both predate this branch, in
 *   `cc6bd38`.
 * - `svg2frames.ts`'s panel-width rationale outliving the `PANEL_WIDTH` it
 *   described and coming to rest on `STAGE_HEIGHT`, from `8d72d08`. Older than
 *   any of the others, and certified as deliberate by the audit built to catch
 *   exactly this — twice, before a review took it off the list.
 * - `withoutQuietest`'s doc bound to a one-line `type` alias sitting between it
 *   and its function, in `630d15d` — the commit that fixed the first two, in
 *   the same hunk as its `observe` fix. This gate cannot see that one; see
 *   below.
 *
 * There are two ways in, and it is worth knowing which is which rather than
 * counting. Most arrived as a side effect of editing something *else* nearby —
 * a constant deleted (`svg2frames.ts`), a constant inserted (`registry.ts`), a
 * function inserted (`scene.ts`) — which is why nobody noticed. The other three
 * were authored that way from the start: `hook-settings.ts` was a new file
 * written whole in `cc6bd38`, two blocks where one was meant; `transport.ts`'s
 * priming rule was written fresh in `d7ad4b9`; and `withoutQuietest`'s doc,
 * alias and function went in as one contiguous block in `630d15d`. Nothing had
 * to move for those. It is three and three, so neither route is "most" — an
 * earlier version of this paragraph said side effects were, having filed
 * `registry.ts` under a deletion that the bullet above calls an insertion.
 *
 * The sharpest case is the last in the list: `630d15d` was the commit fixing
 * the first two, and the same hunk that re-attached `observe`'s doc inserted
 * the alias that stranded `withoutQuietest`'s — in the shape this gate cannot
 * see.
 *
 * **What this does not catch.** Only *adjacent* blocks are visible here. The
 * `withoutQuietest` case above put a one-line `type` alias between the doc and
 * its function, which binds the doc to the alias and leaves the function bare —
 * and no regular shape distinguishes that from a type that is simply well
 * documented. (This sentence used to say "the third instance", pointing into a
 * tally that the paragraph above no longer keeps. An ordinal outliving its list
 * is the same defect as a doc outliving its symbol.)
 *
 * A review caught that one, and a review is what will catch the next. The
 * surface is wider than one shape — anything that puts a declaration between a
 * doc and its subject does it — and no count of it belongs here: the last two
 * numbers this file carried came from a review's scratch work with no artefact
 * behind them, which is the same thing as not having measured it.
 */
function multiDocNodes(files: readonly string[]): readonly string[] {
  const program = ts.createProgram([...files], {
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  });
  return files.flatMap((file) => {
    const source = program.getSourceFile(file);
    if (source === undefined) {
      // Loudly. A file that globbed but did not resolve is a file this gate
      // does not cover, and the count below is of globbed files, so it would
      // not notice. Silently returning nothing here is the gate failing open
      // in the one place it exists to fail closed.
      throw new Error(`globbed but did not resolve into the program: ${file}`);
    }
    const found: string[] = [];
    // Every node, not just the top level. Members of a `type` literal carry
    // doc blocks too, and the first instance of this bug was one of them — a
    // top-level-only walk missed it, which a probe caught before this shipped.
    const visit = (node: ts.Node): void => {
      // `jsDoc` is internal but stable, and is what shows two blocks *bound*
      // where one was meant — `getLeadingCommentRanges`, which the sibling gate
      // uses, enumerates comments but not what they attached to. A regex over
      // the text cannot tell a real block from one inside a template literal,
      // and did report a false positive in `make-font-atlas.ts` for that
      // reason.
      const blocks = (node as { jsDoc?: readonly unknown[] }).jsDoc;
      if (blocks !== undefined && blocks.length > 1) {
        found.push(file.slice(ROOT.length));
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return found;
  });
}

/**
 * Files whose stacked blocks are deliberate, with how many each may have.
 *
 * A file header sits directly above the first documented declaration, and
 * TypeScript binding both is what the author wanted. Those are the entries
 * here. A section header written the same way is the other legitimate case.
 *
 * So this ratchets rather than forbids: a new pair in a listed file fails until
 * someone bumps the number, and one in an unlisted file fails until someone
 * adds it. The cost is a line and a moment deciding which kind it is — which is
 * the moment that was missing every time.
 *
 * Recording a count instead of deciding is the failure this list invites, and
 * the two revisions that wrote entries both did it. Measured from `git log -p`:
 *
 * - `630d15d` wrote the list with fifteen entries. Three of them were the bug
 *   and not a header — `scene.ts` and `hook-settings.ts`, each recorded as `2`
 *   when the surplus block was the bug: in `scene.ts` `render`'s stranded doc,
 *   which was the *first* of the two bound to `withEnvironment`, and in
 *   `hook-settings` a second block of distinct prose that belonged in the
 *   first; and
 *   `svg2frames.ts`. A fourth, `make-font-atlas.ts`, was a regex false
 *   positive that no longer exists once the walk went through the AST.
 * - `f3cc11f` decremented `scene.ts` and `hook-settings.ts` to `1` by fixing
 *   their real second block, and deleted `make-font-atlas.ts`. It re-certified
 *   `svg2frames.ts` rather than reading it.
 * - `4bea4d7` deleted `svg2frames.ts` after a fourth review read it. Two
 *   entries have therefore ever been deleted outright; the other two were
 *   decremented and are still here.
 * - `f941169` changed no entry at all — only the prose, in this block and in
 *   the one above `multiDocNodes`. It said `4bea4d7`'s deletion was its own.
 *   Getting the provenance of the list wrong is the same failure as getting an
 *   entry wrong, one level up.
 *
 * Every entry left has since been read against its file, twice and
 * independently, and every one is a header. That is a statement about an audit
 * on a particular day, not a property of the list — which is why the entries
 * are counts a person has to justify rather than a switch someone can flip.
 */
const DELIBERATE: Readonly<Record<string, number>> = {
  // Two, both headers, both read against the file on 6 Sep. The module header
  // sits above the doc on `QuietHours` — the first explains why the daemon
  // stops sending at all, the second what a window is. The second is the
  // "meets the environment" header above `quietGate`, marking the boundary
  // between the pure half this file tests against fixed clocks and the two
  // thin wrappers that read `TAMACLAUDE_QUIET`. Neither belongs inside the
  // doc beneath it.
  'packages/cli/src/quiet.ts': 2,
  'packages/daemon/src/state.ts': 2,
  'packages/device/src/report.ts': 1,
  'packages/hooks/src/hook-settings.ts': 1,
  'packages/protocol/src/rle.ts': 1,
  'packages/renderer/src/band.ts': 1,
  'packages/renderer/src/draw.ts': 1,
  'packages/renderer/src/font-data.ts': 1,
  'packages/renderer/src/framebuffer.ts': 1,
  'packages/renderer/src/layout.ts': 1,
  'packages/renderer/src/scene.ts': 1,
  'packages/renderer/src/strip.ts': 1,
  'packages/renderer/src/text.ts': 1,
  'tools/frame-palette.ts': 1,
};

function sourceFiles(): readonly string[] {
  return globSync(['packages/*/src/**/*.ts', 'tools/**/*.ts'], {
    cwd: ROOT,
    exclude: (path) => inBuildOutput(path),
  }).map((file) => ROOT + file);
}

describe('TSDoc blocks are where their author put them', () => {
  it('finds source files to check at all', () => {
    // Without this, a bad glob turns the gate below into a green no-op — and a
    // lone lower bound does not give it. Measured: a `> 30` threshold let 57 of
    // the 88 real files vanish with both tests green, because the half that
    // remained cleared the bar on its own. Asserting the two halves
    // was still not enough — `cli` and `packs` carry no `DELIBERATE` entry, so
    // both could leave the glob for free and the ratchet would not notice
    // either. Every package by name, then, the way the budget gate does it.
    //
    // Relative, not absolute. `sourceFiles()` returns `ROOT + name`, so a
    // checkout whose own path contained `/tools/` would have made the old
    // `includes` filters match everything: the canary becoming precisely the
    // no-op it exists to prevent.
    const files = sourceFiles().map((file) => file.slice(ROOT.length));
    const packages = files
      .filter((file) => file.startsWith('packages/'))
      .map((file) => file.split('/')[1]);
    expect([...new Set(packages)].sort()).toEqual([
      'cli',
      'daemon',
      'device',
      'hooks',
      'packs',
      'protocol',
      'renderer',
    ]);
    expect(
      files.filter((file) => file.startsWith('tools/')).length,
    ).toBeGreaterThan(18);
  });

  it('has no stacked doc blocks beyond the recorded ones', () => {
    const counted: Record<string, number> = {};
    for (const file of multiDocNodes(sourceFiles())) {
      counted[file] = (counted[file] ?? 0) + 1;
    }
    expect(counted).toEqual(DELIBERATE);
  });
});
