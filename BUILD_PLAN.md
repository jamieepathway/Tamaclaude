# Tamaclaude — Build Plan

**Deliver:** Wednesday 23 September 2026. Immovable — it is a birthday.
**Written:** 2026-08-18 (36 days out). Research: `.claude/research/foundations/brief.md`.

## Key dates

| Date                | Milestone                                                                               |
| ------------------- | --------------------------------------------------------------------------------------- |
| Tue 18 – Wed 19 Aug | Stage 0 — repo foundations (no hardware needed)                                         |
| **Thu 20 Aug**      | Hardware arrives. Verify flash size. Measure board, brief the 3D printer.               |
| **Mon 24 Aug**      | **Harness afternoon** — hero vs two-up, message band, strip height, judged at true size |
| **Tue 25 Aug**      | **DESIGN FREEZE** — screen list, state machine, pack format locked                      |
| Mon 31 Aug          | End-to-end pipeline alive with placeholder art                                          |
| **Sun 13 Sep**      | **FEATURE FREEZE + art complete**                                                       |
| Mon 14 – Fri 18 Sep | Soak on Alex's desk. Bug fixes only, no new features.                                   |
| Sat 19 Sep          | Assemble in case, dry-run install on a clean macOS account                              |
| Sun 20 – Tue 22 Sep | **Buffer.** Unused is the goal, not waste.                                              |
| **Wed 23 Sep**      | 🎉                                                                                      |

## The date has been overtaken

**The board was handed over on 2 Sep and now sits on the recipient's desk**, so
the 23 Sep delivery date no longer gates anything: the thing it was a deadline
for has already happened, three weeks early. What replaces it is ordinary
maintenance on a device somebody uses daily — see Stage 2's exit for the two
firmware changes that cost a reflash each.

**That is not the same as the whole schedule being void, and an earlier version
of this section said it was.** It also claimed work had "continued past the
freeze", which was simply wrong: the freeze is 13 Sep and this was written on
the 6th. What is dead is the _delivery_ date. The 13 Sep freeze and the 14–18
Sep soak were never about delivery — they were about not shipping untested
changes to somebody else's desk. That desk now has the board on it, which
changes when the risk lands rather than whether it exists: a bad change reaches
a panel somebody is using today instead of one still in a drawer.

So Stage 6's open items still stand on their own merits. The clean-account
install dry run in particular: its purpose is proving a Mac that is not this
one can build this repo, and nothing about ownership touches that.

Nothing below has been rewritten to match, deliberately: the reasoning in each
stage is worth keeping as it was written, and back-dating it would destroy the
record of what was decided under deadline and what was not.

## The always-giftable rule

Alex decided sprites are the product, not an optional layer. That decision
stands. But **every milestone from Stage 1 onward must leave a device that could
be handed over that day** — with placeholder art if necessary. This is not
scope reduction; the art still ships. It is the only thing standing between a
slipped animation and no present.

---

**Checkbox notation.** `[x]` means done. `[ ]` means not started or in
progress. `[~]` means neither — cancelled, or delivered in part with the rest
named on the line. They were all `[x]` for a while, which made the column
unreadable as progress: a cancelled item and a finished one looked identical.

## Stage 0 — Foundations (Tue 18 – Wed 19 Aug)

No hardware required.

- [x] `git init` and the GitHub remote `Pushedskydiver/Tamaclaude` — public, per Alex
- [x] pnpm workspace, Node 24, TypeScript
- [x] ESLint flat config (`typescript-eslint`, `unicorn`, `sonarjs`, `boundaries`), Prettier, husky + lint-staged, vitest, knip
- [x] CI: build / test / lint / typecheck / format:check / knip; PR title check
- [x] Gitmoji commit convention (`docs/GIT.md`)
- [x] Lean `CLAUDE.md` — trigger-phrase loading, not always-on detail
- [x] `docs/`: `CONVENTIONS.md`, `GIT.md`, `ARCHITECTURE.md`, `SELF-REVIEW.md`, `DA-REVIEW.md`
- [x] `.claude/agents/`: `spec-grill`, `da-review`, `copilot-surrogate` (ported from chief-clancy)
- [x] `CREDITS.md` — upstream clawd-tank, for both concept and animation technique
- [x] `.gitignore`: **`packs/*` except `packs/example/`**
- [x] `LICENSE` (MIT)

Package graph, enforced by `eslint-plugin-boundaries`:

```
protocol <- packs <- renderer <- daemon <- cli
protocol <- device <- daemon
protocol <- hooks
```

`A <- B` reads "B imports A". `hooks` depends on `protocol` and nothing else —
it is deliberately near-leaf, since Claude Code runs it on every hook event.

- `protocol` — wire format, RLE RGB565 encoder, dirty-rect diffing. Zero deps.
- `renderer` — virtual 172×320 screen, scene graph, sprite playback, fonts.
- `packs` — manifest schema (zod), palette, quips. Not a loader: reading a
  pack off disk is the CLI's job (`packages/cli/src/pack.ts`).
- `daemon` — session state machine, tool→state mapping, transports.
- `hooks` — the Claude Code hook handler binary.
- `device` — USB-CDC transport + the ESP-IDF firmware source.
- `cli` — `tamaclaude daemon <device>`, `tamaclaude pack`, and a bare smoke
  run. `status` and `dev` were named here from Stage 0 and never built.

## Stage 1 — Renderer + dev harness (Wed 19 – Mon 24 Aug)

The whole product, minus hardware.

- [x] Virtual screen: 172×320 RGB565 framebuffer in TS (`packages/renderer/src/framebuffer.ts`)
- [~] ~~`@napi-rs/canvas` sink~~ — **cancelled, not built.** The renderer
  produces a `Framebuffer`; `tools/blit.ts` turns those into packets, tests
  compare buffers, the harness draws to a canvas. A sink interface between
  them would be indirection for its own sake, and the dirty-rect path _is_
  the device sink. Also kept a native dependency out of the renderer, which
  the daemon imports.
- [x] Dev harness: local web page, scrub through frames, switch layout and
      orientation live (`pnpm harness`). It drew panel text in Departure Mono
      until 25 Aug; it now draws no panel text at all, because drawing text the
      renderer also draws is what made it a second panel renderer
- [ ] Dev harness: hot reload, scrub through **states**, and fake event
      injection. Event injection needs the daemon, so it lands with Stage 3.
      State scrubbing does not — it needs only the state→animation mapping,
      which the 25 Aug freeze produces, so it waits on the freeze rather than
      on Stage 3. The earlier split dropped "states" while keeping "frames",
      which are not the same thing: frames are the eight rasters of one loop,
      states are the ten catalogue entries the freeze locks.
- [x] Departure Mono vendored — `CREDITS.md`, and `tools/make-font-atlas.ts`
      turns it into the renderer's bitmap glyphs. It no longer renders _in the
      harness_: that page stopped drawing panel text on 25 Aug
- [x] Departure Mono bitmap rendering in the renderer, nearest-neighbour,
      `imageSmoothingEnabled = false`
- [x] Scene primitives: sprite, text, chips. **Badge, clock and progress are
      not primitives** — a clock is text, a badge is text on a `fillRect`, a
      progress track is a `drawBorder` with a `fillRect` inside. Nothing earned
      its own function, and `knip` would have failed on one that did.
- [~] **No tool composes a _scene_ outside `render()`** — which is most of what
  Stage 2's exit ("browser and panel show the same thing") asks for. Landed
  25 Aug by deletion, not by either option this line used to cost. Left at
  `[~]` because the second of the two things below is still open.
  Both costed options were wrong, and a grill found why. (a) "bundle the
  renderer into the page" rested on a spike I could not reproduce and whose
  figures did not agree with each other; what is verifiable is the
  mechanism, not the number — `packages/renderer/src/framebuffer.ts` and
  `band.ts` value-import `packPalette` from `packages/packs`, whose module
  scope builds zod schemas, so a browser bundle of the renderer drags a
  schema validator behind it. Measured with the repo's own bundler (vite /
  rolldown, `node_modules/.bin/vite`), zod is roughly three-quarters to
  four-fifths of that graph. (b) "pre-render whole panels" undercounted
  badly: the cross-product of the harness's nine draw-affecting controls is
  in the thousands to tens of thousands depending on which are held fixed,
  and the prose that said "roughly ten thousand" was quoting one accounting
  of several without saying which.
  And neither could have worked. `sceneFor` lives in `packages/cli`, and
  `eslint.config.ts` allows `tools` → `tools | renderer | packs | protocol`,
  so a tool must hand-build its `Scene` either way — "true by construction"
  was never reachable by making a second drawer more faithful.
  `tools/panel-mock.ts` was the worst offender, because it is the artefact
  that goes into pull requests and it hardcoded `#0d1117` and `#c9d1d9`
  hand-synced to the example pack's palette. It now composes through
  `composePanels`, and the page only unpacks RGB565 onto a canvas. It draws
  all four skies, the strip's five-plus-overflow worst case, and takes
  `--message` so a long MCP tool name can be put through the real wrapper.
  `tools/harness.ts` keeps sprite scrubbing and draws band _outlines_ from
  `panelBands()`, with no contents. No new dependency, and no bundler.
  A line count was quoted here across three revisions and was wrong in two of
  them, because the set of files it covered kept changing under it; what is
  true and stable is that the panel-drawing code shrank and the comment around
  it grew.
  **Open, and why this is `[~]`:**

  1. **Closed 25 Aug.** `contact-sheet.ts` composed its frames over a flat
     `#0d1117` — a `packs/example` palette entry copied by hand — where the
     device paints the environment edge to edge (`ENVIRONMENT_EXTENT = 'panel'`).
     It is the artefact the mandatory `animation-critic` reads, so every
     animation review since the environment landed judged art against a
     background the panel cannot display, which is the failure this plan
     already records four animations shipping through.
     It now composes each frame through `render()` and crops to the stage slot,
     so a reviewer sees the sprite on its real ground and still sees the frames
     side by side. `--sky` picks the scheme; `day` is the hard case for a
     _pale_ prop, its sand measuring 19.1 against dusk's 6.5. The harness keeps a backdrop and says so — it draws no bands
     and is for motion, and `docs/ANIMATION.md` plus the critic's own step 4
     send a reviewer to `panel-mock` for context.
     `tools/one-panel-renderer.test.ts` is the gate that was missing, and
     `contact-sheet.ts` has come off its allowlist rather than staying on it
     harmlessly.
  2. **Hero versus two-up is open, and is now answerable by looking.**
     `composePanels` hardcoded `layout: 'hero'` until 25 Aug, so nothing could
     compose a two-up _panel_ through `render()`. The comparison was not
     impossible — `tools/harness.ts` has always scrubbed two-up sprites at true
     size against real slots, with two _different_ animations, which is the one
     thing the new picture cannot do. And `panel-mock` drew two-up until PR #52
     removed it earlier the same day, so this restores a capability rather than
     adding one. `panel-mock --layout twoUp` is that picture — real
     environment, real bands, all four skies, true size and enlarged. Two-up
     draws at scale 4, so it needs frames baked there
     (`node tools/svg2frames.ts <svg> <outDir> 4`), which `composePanels` now
     says in its error rather than failing obscurely.
     The decision itself is still open. `daemon.ts`'s `layout: 'hero'` is a
     bare literal with no rationale anywhere, unlike the `landscape` beside it,
     which carries a dated record; the spec calls two-up "a genuine trade
     rather than a settled rejection". Either that literal gets a reason or
     two-up gets cut, and there is now something to decide from.
     The band heights are in better shape than an earlier version of this entry
     claimed. Landscape derives its message band as `height - (status + strip)`
     = 116px and consumes only `BAND_HEIGHTS.status` and `.strip`;
     `BAND_HEIGHTS.message` = 64 reaches `portraitBands()` alone and so ships
     nowhere. `panel-mock` shows both shipping bands, at the strip's
     five-plus-overflow worst case, and `--message` puts a long MCP name
     through the real wrapper. So the freeze's landscape inputs are judgeable
     today; what is unjudged is a portrait constant that does not ship.

- [x] Manifest schema (zod) in `packages/packs`; pack resolution in
      `packages/cli/src/pack.ts` — `TAMACLAUDE_PACK`, then
      `~/.tamaclaude/pack/`, then a hard error. **`packages/packs` is still
      not a loader**, deliberately: it validates a manifest someone else read,
      which keeps one trust boundary rather than two. This line went
      `[ ]` → `[~]` → `[x]`. The `[~]` was the 24 Aug birthday commit, after
      reviews found the loader half was a repo-relative `readFileSync` that
      broke on any install. An earlier version of this sentence said the box
      "went back to `[~]`", which no ref supports — it went forward to it.
- [~] `packs/example/` — manifest and palette done; **placeholder art still to
  come**, and Stage 1's exit depends on it
- [x] Dirty-rect differ + RLE encoder, with unit tests and a compression-ratio assertion
- [x] **SPIKE: generate one animation from base SVG to rendered frames.** The
      panel leg of this pipeline is Stage 2 and is not done. Base SVG → LLM → animated SVG →
      frames → panel. This is the single biggest untested assumption in the plan and it sits
      on the critical path. Validate it in week one, not week four.

**Exit:** the full device experience runs in a browser tab with placeholder art, and one
real animation has been generated by the pipeline.

## Stage 2 — Hardware bring-up (Thu 20 Aug onward, parallel)

- [x] Verify actual flash size — **8MB**, upstream was right (`docs/HARDWARE.md`)
- [~] ~~Flash factory demo, confirm display and WS2812 work~~ — **superseded,
  not done.** The flash question is answered on the line above. Confirming
  the board is good is done better by flashing the blitter, which exercises
  the display through the code that ships. WS2812 is never driven — see the
  RGB LED row in `docs/HARDWARE.md`.
  **The one live thing here has moved to Stage 6's gift-board flash**,
  where it is read at the moment it applies: the vendor demo is free to
  check exactly once, before flashing overwrites it.
- [ ] Measure board; send chosen STL to the printer
- [x] ESP-IDF blitter firmware: USB-CDC read loop → SPI ST7789 blit — 312 lines
      of code, running at 8fps with zero resyncs. Landscape is what ships; a
      portrait build needs portrait splash artwork and a re-bake first, and a
      `_Static_assert` refuses to compile without them rather than stretching
      the landscape picture.
      Waveshare's demo turned out not to be needed: `esp_lcd` has an ST7789
      driver, so there was no init sequence to re-derive. What was reused from
      upstream clawd-tank is the pin map and the column-offset quirk.
- [x] Embedded splash: shown when nothing has ever driven the panel — narrower
      than "whenever no host is connected", which is not observable on this
      link (`docs/HARDWARE.md`). Real art since Stage 5's entry below; the
      placeholder's border and corner marker did their job and are gone.
      **The second half of that reasoning was retired on 6 Sep.** It said the
      obvious proxy, an idle timeout, "would wipe a legitimately still frame" —
      true of a host that goes quiet when the picture stops changing, and this
      one repaints in full every `REFRESH_MS`. `IDLE_BLANK_MS` blanks the panel
      after thirty seconds of silence; the splash is exempt, so "nothing has
      ever driven this" still reads.
- [x] Host-side USB-CDC transport (`packages/device/src/panel.ts`), driven from
      a rendered frame by `tamaclaude daemon` (Stage 3). The sink swap was the
      outstanding half and it landed with that command
- [x] Measure real throughput — **562.5 KB/s**; the 700 KB/s guess was ~22%
      above it (`docs/ARCHITECTURE.md`)
- [ ] Measure sustained fps — needs the blitter firmware above

**Exit:** browser and panel show the same thing. Firmware is done and rarely
touched — and "never touched again" is a bar this plan has now failed twice,
so it is written as a bar with its exceptions rather than as a rule. The first
was the boot splash, taken in Stage 5 below on 21 Aug, sixteen days before the
stage it was scheduled in even opens. The second was `IDLE_BLANK_MS` on 6 Sep,
which the panel needed because no protocol message can reach the backlight GPIO
and a host that sleeps or crashes cannot darken a panel it is no longer
driving. Each cost a reflash and physical access to the board; that price is
the reason for the bar, and paying it twice is the reason not to call it
unconditional. The exit itself is still not
met, for the reason immediately below; the splash closed the firmware
question, not the parity one.

**Most of the way, and the remainder is named rather than hidden.** Every tool
that composes a _scene_ now does it through `render()` — see the Stage 1 entry
above, which landed 25 Aug by deleting the competing draws rather than by
bundling the renderer into a page, the fix this paragraph used to prescribe.
What is left is the harness, which paints a flat backdrop behind transparent
frames where the device paints scenery — deliberately, since it draws no bands
and exists to scrub motion, and both `docs/ANIMATION.md` and the critic's own
step 4 now send a reviewer elsewhere for context. A much smaller gap than "the
harness approximates the bands", and a chosen one.

## Stage 3 — Session pipeline (Mon 24 – Mon 31 Aug)

- [x] Hook handler binary; installer patches `~/.claude/settings.json` —
      dry-run by default, preserves foreign hooks and file mode, idempotent
- [x] Daemon: session registry, staleness eviction and multi-session
      resolution are done and pure, and something listens on the socket at last —
      the hook writes and the daemon reads. Newline-delimited JSON over many
      short-lived connections, folded into the registry and persisted beside the
      socket, so a restart mid-session does not show an empty desk. A leftover
      socket file is told from a running daemon by connecting to it rather than by
      unlinking it blind (`packages/daemon/src/socket-path.ts`).
- [x] **Verified on the real panel, 21 Aug 2026.** `tamaclaude daemon
/dev/cu.usbmodem1101` drove the flashed device end to end: the link
      reached `online` with no refusal, so the firmware's geometry agrees with
      the 320x172 landscape the host sends. Alex watched the glass through a
      four-event session and saw the clock, the session chips, and the message
      band going `Bash` -> `may I?` -> `well, that happened`. That is the first
      time anything has driven the hardware, and the first confirmation the
      picture is right rather than merely that bytes moved.
- [x] Daemon wired to a transport — `tamaclaude daemon <device>`
      (`packages/cli/src/daemon.ts`). The listener's snapshot is resolved into a
      scene, rendered to a framebuffer, diffed against the last one and sent as
      a single dirty rect at 8fps. The clock, the session chips, the subagent
      badge, the message band and the stage are all live.
- [x] **The stage.** Clawd is on it. `tools/bake-sprites.ts` reads the frames
      `tools/svg2frames.ts` rasterises into a gitignored `out/` and writes them
      as generated modules inside `packages/renderer/src/sprites/`, which the
      daemon loads on demand and indexes by the clock. All six animations, all
      360 frames, verified decoding back to the source PNGs with zero pixel and
      zero mask mismatches — and seen animating on the real panel.
      The raw art was 24,192,000 bytes of RGB565 plus the same again halved for
      the mask, and encoded it shipped as 1,128,216. **Those are the six-animation
      figures and they are the stale copy.** So was the thirteen-animation copy
      that replaced them: measured 25 Aug at fourteen animations: 936
      frames, 62,899,200 raw and 2,744,512 encoded — the thirteen-animation
      total plus `sweeping` exactly. `tools/bake-sprites.ts` and
      `packages/renderer/src/sprites/index.ts` were said to "carry the live
      numbers"; they carry the caveat and their own stale copies, at ten and
      thirteen animations. A figure that has now gone stale three times in one
      file is a figure to stop quoting: re-derive it from the `.data.ts` files
      when it is wanted. Size was never going to be what
      limited how many animations this device gets, though it was quoted as
      though it might be.
- [x] **Hook names confirmed against live documentation** — all three exist:
      `PermissionRequest`, `StopFailure`, `SubagentStart`. Checked against
      code.claude.com/docs/en/hooks.md rather than upstream's README, because a
      state machine keyed on a hook that does not fire is silent, not loud.
      Four findings from that check shape this stage, recorded in
      `packages/protocol/src/events.ts`: the session key is `session_id`;
      subagents ride the ordinary events carrying `agent_id` and `agent_type`
      rather than forming a separate stream; **Claude Code waits for a hook
      command to exit**, with a 600s default timeout — which confirms the
      existing "latency budget" framing rather than upgrading it. The generous
      timeout means events are not lost to slowness; it means every
      millisecond of `tamaclaude-notify`'s startup is paid by the user,
      synchronously, many times per turn. **Measured on 22 Aug, once hooks were
      installed on a real machine: ~42 ms an event, 38 ms of it bare Node
      startup and 3.2 ms the hook's own module graph.** At four to ten events a
      turn that is 0.2-0.4 s per turn, and essentially none of it is reachable
      by the import discipline this line was written to justify. (Note the docs also use "blocking" in
      a second sense — whether a hook can _veto_ an action via exit code 2 —
      and by that sense `PermissionRequest` and `StopFailure` do not block. The
      two senses are unrelated.) Finally, `Stop` fires on every response rather
      than at task completion and `StopFailure` ignores exit code and output
      entirely, so "the turn finished" is not observable the way Stage 4's
      payoff screen assumes. **`Stop` and `StopFailure` are alternatives, not a
      sequence** — at most one fires per turn — so a failed turn leaves `FAILED`
      standing and `dizzy` reaches the panel. Checked 24 Aug against the same live
      documentation, which says it in a verb — "Runs _instead of_ Stop when the
      turn ends due to an API error". Still unobserved: a live hook capture on
      22 Aug caught no `StopFailure` at all, which is evidence about how rare
      they are and none about ordering.

- [x] Tool → state mapping (`PreToolUse.tool_name`)
- [x] Multi-session compositing — resolution ranks by state, hero plus chips
- [x] Subagent lifecycle counted in the registry, and the badge is fed from it
      — `subagentText` in `packages/cli/src/daemon.ts` sums `subagents` across live
      sessions
- [x] `PermissionRequest` → state, quip and animation. `permission-sign` is
      built, baked and wired (`NEEDS_PERMISSION` in `packages/daemon/src/animation.ts`),
      and `WAITING` got `confused` in the same pass — both Tier A, both through
      `animation-critic`
- [x] `StopFailure` → the state, `error_type` and the quip exist, and `dizzy`
      is built, baked and wired (`FAILED` in `packages/daemon/src/animation.ts`).
      The error is stored and, since 24 Aug, read: `rate_limit` and
      `overloaded` draw `overheated`, the other eight documented values keep
      `dizzy`. The field is kept because it arrives once and cannot be
      recovered
- [~] ~~**Remote transport**~~ — **cut, 25 Aug.** TCP + shared secret, so a
  remote Claude Code agent would appear on the display.
  **This reverses a decision, and says so rather than dressing it as the
  plan's own escape clause firing.** The line carried a condition from the
  first commit that ever contained this file — "_Last item in the stage and
  explicitly cuttable_ — design the protocol for it from day one (cheap),
  but ship it only if Stage 4 is on schedule" — and a first version of this
  entry claimed that condition had fired. It has not. Stage 4 had one
  unchecked box at the time and it was a _tool_, cut on 25 Aug, so the count is
  now zero; every Tier A animation exists, twelve days before the 6 Sep gate. That version also said the catalogue was
  "hand-drawn", which contradicts `docs/ANIMATION.md` — the animations are
  LLM-authored CSS against a fixed geometry, and hand-drawing is the risk
  register's untaken fallback. Both claims were wrong and both made the cut
  look automatic when it is a judgement.
  `.claude/research/foundations/brief.md` calls remote sessions a headline
  feature and the screen spec puts `origin` in the frozen session model, so
  this overrides the brief. The reasons it is still right: - **The install is on hardware nobody here owns.** `tamaclaude-notify`
  would have to run on the other machine — second OS and arch, Node
  there, reachability — untestable before the gift. - **The shared secret is a trust-boundary redesign, not a transport.**
  `socket-server.ts` states the invariant that nothing may be kept per
  peer; per-connection auth state contradicts it directly. The socket's
  whole access model is the file mode, which no TCP port inherits. - **It would force a retune of `DEADLINE_MS`.** The hook's 150ms budget
  is justified against a local socket write, and it sits on the user's
  synchronous path — on a link nobody could test. - Being wrong costs nothing before 23 Sep, and the fallback is that the
  panel shows local sessions, which is the whole product.
  **What the cut does not undo.** The wire framing is transport-agnostic
  and stays paid: newline-delimited JSON over many short-lived connections
  (`socket-server.ts` is explicit that it is not one stream). The _secret_
  half has no design anywhere — the phrase occurs only in this line — so
  "the design half is done" is true of framing and false of authentication.
  There is also a version needing no code at all: an SSH `RemoteForward` of
  the Unix socket would deliver real remote events, since `TAMACLAUDE_SOCKET`
  is already the only agreement between hooks and daemon. Untested, and it
  would not light the hollow chip, because the daemon cannot tell where a
  line came from.
  `SessionOrigin` and the strip's hollow chip are kept: the field costs one
  word at each construction site, and the strip has few spare visual axes.
  `packages/renderer/src/strip.test.ts` pins the branch — a first version
  of this entry called it "built and tested" when nothing asserted it.
  Nothing on the _host_ produces a remote session; the panel could never
  produce any session at all. The re-entry condition is in the deferred
  table.
- [x] **The pack comes from a configured location.** `TAMACLAUDE_PACK`, else
      `~/.tamaclaude/pack/`, else refuse to start — `packages/cli/src/pack.ts`.
      The repo-relative `readFileSync` is gone, so the binary no longer depends
      on being run from a checkout. **There is no bundled default pack**, and
      that is the load-bearing decision: a fallback would turn "you forgot to
      point at your pack" into a panel that works, looks right, and carries the
      example pack's generic quips and no birthday. A spec review killed the
      fallback this design originally had, on the grounds that it _was_ the
      silent-wrong-pack failure rather than a guard against it.
- [~] **launchd agent built; `brew` tap deliberately not.** `tamaclaude
install-agent` writes `~/Library/LaunchAgents/com.tamaclaude.daemon.plist`
  — dry run by default, `--apply` to install, modelled on
  `tamaclaude-install-hooks`. It resolves the pack _before_ writing, because
  an agent installed where no pack exists would exit 2 on every start and
  `KeepAlive` cannot tell exit 2 from exit 1 (launchd sees zero versus
  non-zero only), so it would restart forever writing into a log nobody
  opens. `bootout` precedes `bootstrap` so a second install cannot leave
  the first agent running with stale arguments.
  **The plist runs `process.execPath`, not the shebang.** `#!/usr/bin/env
node` plus launchd's `PATH=/usr/bin:/bin:/usr/sbin:/sbin` fails to spawn
  on any machine using a version manager, which is this one — silently,
  every ten seconds, forever.
  **No brew tap.** A second repo, a formula, a versioned tarball and
  un-privating the package, for one Mac. `git clone && pnpm install` is not
  a one-line install either: it needs Xcode CLT, node and pnpm first.
  **The recipient runs the install himself, from `docs/INSTALL.md`** — this
  said "install it in person" until 26 Aug, which made the guide's install
  half look optional and made the clean-account dry run look like a
  formality. It is neither. What that leaves is a printed card as a
  keepsake carrying something true — the repo QR and "if it ever stops,
  open Terminal and run `tamaclaude status`". **`status`, not `pack`**, for
  the reason `packages/cli/src/index.ts` gives where it is defined: `pack`
  runs under the terminal's environment and node, so it answers cheerfully
  while the login agent is failing to spawn every thirty seconds. `status`
  asks launchd instead.
  `tamaclaude status` asks launchd whether it is actually running, and says so
  when the node it was installed with has been upgraded away — the failure a
  version-pinned `process.execPath` creates, and the one `tamaclaude pack`
  cannot see because it runs under the shell's node. `install-agent --apply`
  runs the same check rather than claiming success: `bootstrap` exiting 0 means
  _loaded_, not running, and the likeliest install-day failure is a daemon
  already running by hand, which makes the agent die on `already listening` and
  restart every thirty seconds while the installer says it worked. Reproduced
  and fixed.
  `tamaclaude uninstall-agent` stops it and deletes the plist, because an agent
  with `RunAtLoad` comes back at every login and the only way off otherwise is
  `launchctl bootout` typed correctly by someone who knows it exists — which is
  not the person this is a gift for.
  **The moved-port case is closed, and not the way this line first proposed.**
  macOS derives `/dev/cu.usbmodem1101` from the USB port, so moving the panel
  one socket along changes its path and the reconnect loop would retry the old
  one forever — glass holding its last frame, `tamaclaude pack` still correct,
  nothing red, on every desk move. The recorded fix was to thread discovery
  into `packages/device/src/panel.ts`. A review argued for a cheaper one that
  reuses what this item already installs: bound the consecutive failures,
  exit non-zero, and let `KeepAlive` restart the process, which runs discovery
  again from scratch. `openPanel` takes `giveUpAfter`; the plist passes
  `daemon --supervised`; a hand-typed daemon still retries forever, because a
  person watching a terminal does not want it exiting under them.
  **If this slips, the agreed fallback is not "add a default pack" but
  "fall back and say so on the glass"** — the message band already exists
  and `describePack` already composes the line. A review made the case:
  after 23 Sep the asymmetry inverts, since a missing birthday costs one
  day a year and a panel that will not start costs every day, and a
  crash-looping launchd agent writing to a log nobody reads is not louder
  than a fallback, only differently silent. Recorded now so the argument
  does not have to happen in the last week.

**Exit:** real Claude Code sessions drive the panel, placeholder art.

## Stage 4 — Art (Mon 24 Aug – Sun 13 Sep, overlapping)

The long pole. Runs in parallel with Stage 3 from week two.

**Every top-level box is settled as of 25 Aug** — six `[x]` and the cut
generator at `[~]`, nineteen days before the stage ends. **That is not the same
as closed**, and a first version of this paragraph said closed while two
sub-items were open. Both are settled now: item 8's wiring landed the same
evening its art did, and item 13 is cut under the Tier C licence `spec.md`
already gave it. **So the stage is closed — 25 Aug, nineteen days early.** It
has no `**Exit:**` line to close against, so what that means precisely is that
every top-level box is settled and no numbered sub-item is open.

Recorded because the opposite was asserted the same day: the remote-transport
cut was justified on "Stage 4 is not on schedule", which was false when written.
The animations are LLM-authored CSS against a fixed geometry, but "authored
through §The authoring loop" would be its own retrofit — four predate the loop
by two days, and `CLAUDE.md` records six shipping with no critic at all.

- [x] **The environment: a rock pool, through the day.** Built, and wired into
      `sceneFor` on 22 Aug — it was reachable from nothing before that, which
      is how four animations shipped with holes for eyes that only a
      non-black stage could reveal. The extent is a constant (`panel`), chosen
      in that same 22 Aug commit; the pack field that would have exposed the
      other was cut on 25 Aug — see the deferred table. Plan in
      `assets/clawd/animations/PLANS.md`. A renderer layer behind every
      animation (`docs/ANIMATION.md` §Clawd lives somewhere) — one place, with
      the sky carrying dawn/day/dusk/night as a palette swap. He is currently
      animating on black, which reads as an asset preview rather than a
      creature in a place. **Do this early.** It changes how every animation
      reads, and judging animations against a black stage is judging them in
      the wrong context.

**Budget: 8 review days across Stages 4-5, not 2 days per animation.** The
grill killed the per-animation box: generation is embarrassingly parallel — one
`PLANS.md` entry produces one SVG independently, and Alex runs concurrent
sessions — so the serial bottleneck is review at true size, not authoring.
Generate in batches, review in batches against each plan's "Not wanted" line.

**Ordered by measured frequency, not by guess.** Across 1,046 real Claude
Code transcripts and 44,954 tool calls: `Bash` is 63.9%, `Read` 17.6%,
`Edit`/`Write` 7.9%, `WebSearch`/`WebFetch` 5.5%, `Agent` 0.7%, `mcp__*` 0.3%.
So `gym` is the single most-watched working screen on the device by a factor
of three over the next one, and `typing` — the animation built first and
polished most — is seen about an eighth as often. `Grep` and `Glob` do not
appear at all in 44,954 calls, so `bouldering`'s trigger is `Read` alone.

**If Tier A is not complete by Sun 6 Sep, Tier B is abandoned in full** rather
than partially. Eight good screens beat nine plus four rough ones.

- [x] `assets/clawd/base.svg` — canonical geometry, stable element IDs (upstream's file, see `CREDITS.md`)
- [x] `PLANS.md` — prose spec per animation (action / body mechanics / eyes / effects)
- [~] ~~TS generator: base SVG + example + plan → LLM → animated SVG~~ —
  **cut, 25 Aug.** It would have automated `docs/ANIMATION.md` §The
  authoring loop, which is a documented agent procedure. That loop has
  already produced the entire catalogue, all of it
  CSS against `base.svg` under §The generation contract — so the tool would
  wrap a process that demonstrably works when invoked by hand.
  **This is not the plan's condition firing; nothing conditioned it.** It is
  a judgement that a tool automating a working loop is worth less than the
  days it costs, with 29 left. Nothing depends on it: the only reference in
  the tree was this line. Most of Stage 5's remaining art does not want it — a
  pixel scene is a drawing and the logo is a quantiser pass — and the pet
  sprite, which the spec ranks Tier A rather than set dressing, is neither.

  **This line said until 26 Aug that the pet "lands inside two existing
  animated SVGs", meaning `idle.svg` and `asleep.svg`. It cannot.** Both are
  tracked, the pet is pack content by `CLAUDE.md`'s rule, and drawing it into
  them would put a personal detail into the public repo and grow the
  grandfathered set in the same stroke. Tier A says it matters, not where it
  is drawn. It takes the logo's shape instead: a blob in the manifest and a
  painter that composites it into a slot, which is what
  `packs/example/README.md` already said it would. So the pet is not animation
  work, which leaves the easter-egg idle and the meditation idle variant in that
  category — the two this bullet already counts further down. A first
  version of this sentence said "alone" and contradicted them.

  **The three sentences that used to follow were wrong, and the measurements
  below replace them.** They ruled out an animated pack format as something
  "nothing in the shipping graph could decode" — false, and it was the clause
  carrying the argument: `packages/renderer/src/sprites/index.ts` bakes exactly
  that shape, arrays of base64 blobs and masks, and `blob.ts` decodes it
  frame-count-agnostically for the sprites and the logo both. They then offered
  a "two-pose blink" as the cheap recovery, which is the same mechanism ruled
  impossible four lines earlier _and_ is not a blink: `frameAt` is
  `Math.floor(now / FRAME_MS) % frames` with `FRAME_MS` 125, so two poses
  alternate at 4 Hz. There is no hold.

  **Drawing the pet into tracked art is still out, but not because it "cannot
  happen".** Item 6 below draws a personal-interest object into tracked
  animated art, so the absolute is refuted by this file's own item 6 below.
  The grounds that hold are narrower: `CLAUDE.md` names the pet specifically as
  ignored-file content, and unlike that object the pack _can_ supply the pet —
  the logo proved the route on 26 Aug.

  **What the stage can actually hold**, measured against the character's mask
  union across all 128 `idle` and 96 `asleep` frames, landscape hero, for a
  prop that is never occluded:

  | Prop width | Tallest clear of the character | Where            |
  | ---------- | ------------------------------ | ---------------- |
  | up to 16   | 51 rows                        | panel (149, 115) |
  | 20 to 36   | 22 rows                        | panel (0, 144)   |
  | 40 to 48   | 20 rows                        | panel (0, 146)   |
  | 52 and up  | 6 rows                         | below the feet   |

  **That table measures the wrong thing, and the rest of this bullet is the
  record of finding out.** It is the space a prop can occupy _without touching
  the character_. Keep it: it is correct, it was recomputed by a reviewer, and
  it is what a prop drawn behind him would need.

  **Settled 27 Aug, and reversed on 28 Aug.** The 27th settled "foreground
  prop, in the near corner", which stands — "background prop", this file's
  wording since 18 Aug, is retired rather than reconciled. What did not stand
  was the size that came with it: 32x22 at origin (0, 144), taken straight off
  the table above.

  **The table's bound does not apply to a prop drawn in front.** Painted after
  the character, overlapping him is what being in front _means_, so avoiding
  the overlap bought nothing and cost most of the size: the pet came out a
  quarter of his width. The recipient photographed the panel and said it was
  small and not obviously a cat, and the size was raised on that.

  **It was raised on a preference, not on a demonstrated failure, and this
  line said otherwise for a few hours.** It read "the panel showed that size
  unreadable". It did not. The recipient then showed the same photograph to
  someone who knew nothing about it, and that person said "a cat curled up
  sleeping" — species, pose and state, cold, off the 32x22. That is a better
  result than either critic managed on the same artefact: one wanted 8x
  magnification to reach 85%, the other offered fox and dog as alternatives at
  55%.

  So the record is: 32x22 was legible and looked slight; 52x36 is legible and
  has presence. The second is the better picture and the first was not a
  defect. **Recorded this way because the wrong version had already reached a
  blast-radius doc, and inventing a failure to justify a decision is the
  failure mode this file keeps finding in itself.**

  **Now 52x36 art in a 60x42 slot at stage-relative (0, 118)** — panel rows
  124 to 165, base on the stage's last row, overlapping his torso and lower
  arm. `packages/renderer/src/pet.ts` owns those numbers and says which are
  measured and which are chosen. Both are chosen; an earlier version of this
  sentence claimed 42 was derived from the row of his eye, and that pixel
  turns out to appear in one frame of 128.

  **What is still true, and worth keeping.** Nothing in the pipeline detects
  "too small to read" — no gate, no critic, no tool — and both critics judged
  from enlargements before anyone looked at glass.
  `.claude/research/foundations/brief.md` holds the principle that bears on
  it: recognition comes from silhouette rather than likeness below about 50px
  a figure. That the one artefact this nearly caught turned out to be fine
  does not make the hole smaller.

  The frozen spec's Tier A ranking survives the foreground call — it says the
  pet matters, and foreground is the reading that honours it. **It does not
  survive the budget**: the spec makes the pet one of idle's three slots, and
  a single bake is not a slot of the eight review days. That is a reversal of a
  recorded grill outcome and it is named here rather than left in a subordinate
  clause.
  What it would have bought is repeatability across a _series_, which matters
  when many are left. **Two are**, item 13's road bike having been cut since:
  the franchise-flavoured easter-egg idle (Stage 5, unchecked) and the spec's
  meditation idle variant. Two is not a series and each is one pass of the loop
  — but a first version of this line said "there are none" and called the
  easter-egg idle hypothetical when it is a scheduled box.

- [x] Playwright SVG→PNG frame renderer (`tools/svg2frames.ts`)
- [x] Palette quantise (`3be0c30`); RLE pack (the sprite bake)
- [x] Animations, in priority order — ship each as it lands:
  1. idle ✅ / asleep ✅
  2. thinking ✅
  3. typing ✅ (Edit/Write) — **lid recoloured `#30363B` → `#A91326` on
     26 Aug**, at the recipient's request, and re-baked. The only Tier-A art
     change after the freeze. Two consequences worth the line: `#30363B` left
     the palette, so one softened claw edge that used to snap cold now snaps
     to the warm `#6F4436`; and `--over` for baking a pack logo changed with
     it, which `tools/logo2pixel.ts` documents.
  4. bouldering ✅ (Read)
  5. gym ✅ (Bash)
  6. **The payoff screen** ✅ — a vehicle parked at his left, overlapping, and
     a claw laid on it once per loop. Named by role rather than by make and
     colour: this repo is public, the vehicle is on the interests list in the
     gitignored brief, and `CLAUDE.md` says tracked docs name personal content
     by role, never by content. It read as the make and colour in ten places
     across five tracked files until 24 Aug.
     **Parked, not pulling up** — this line said "pulls up" until the art
     landed, and `frameAt` is wall-clock modulo, so a state never starts at
     frame 0 and an arrival would re-arrive every loop at a random phase.
     **And the pack cannot supply it.** Sprites bake fixed pixels;
     `packPalette` recolours bands only. Whatever the SVG draws is what every
     install shows, so "from the recipient's pack" was never achievable as
     written — recognition comes from shape and context, and the tracked art
     carries no mark identifying a specific vehicle.

     **That sentence and `PLANS.md`'s read as a contradiction and are not
     one**, which cost a review a finding on 26 Aug, so here is the check
     rather than the assertion. `PLANS.md` says the art "names a colour"; this
     says it carries no identifying mark. Both are true: the art has no badge,
     no model name and no silhouette detail, and its red is `#B22222` — the
     standard CSS `firebrick`, which `tools/contrast.ts` carries as its worked
     example. It is a palette red, not a manufacturer's. No make is named
     anywhere in the tree; grepped.

     **A first version of this added "which `birthday.svg` also uses", and it
     does not.** That file mentions the colour once, in a comment recording
     that the hat _stopped_ being it. The commit asserting this said "checked
     rather than asserted", and the check was a grep for the string rather
     than a read of the line it matched — which is the failure mode the whole
     paragraph is about.
     What `CLAUDE.md` forbade was the _link_ — the since-deleted sentence
     tying the prop to the recipient while the art was coloured — not the
     colour standing alone, which cannot be removed from a drawing of a car.
     The fallback this line used to name is moot: the trigger shipped seven hours
     before the art — same day, `9fd31c3` at 11:22 and `6540a86` at 18:33 — and
     `DONE` borrowed `idle` in between, so the risk it was written against
     never arrived. An earlier version said a fortnight, which `main`'s history
     does not contain: it starts on 18 Aug. Item 12 already made this exact
     correction for `overheated`.

  7. Permission sign, and confused ✅ — Tier A per the screen spec; both were
     missing from every tier in its first draft despite being the two screens
     the whole design principle exists to serve. A `spec-grill` found both
     plans unbuildable before any code moved: the sign wanted a rotated claw to
     reach above the head, which the geometry forbids, and `confused` wanted a
     6deg body tilt against a 2.5deg one already recorded as reading like a
     corrupted sprite
  8. sweeping ✅ (PreCompact) — **art 25 Aug, wiring the same day.** The
     wiring was held back so the art could land on its own — five merges and
     5h40m apart, not the one commit a first version of this line claimed.
     `COMPACTING` is in `SESSION_STATES` at rank 5, `PreCompact` is registered
     in `hook-settings.ts`, and `sweeping` is in `ANIMATIONS`.
     It cost what `assets/clawd/animations/PLANS.md` §Sweeping said it would —
     cross-package and atomic. Adding the state made `tsc` fail in **four**
     exhaustive tables across two packages: `STATE_RANK`, `STATE_ANIMATIONS`,
     `TONE` and `TOOL_STATES`, which is the number §Sweeping predicted and
     named. A first version of this line said three and dropped
     `STATE_ANIMATIONS` — the table holding `COMPACTING: 'sweeping'`, and so
     the point of the change.
     The window needed no timer: a capture measured `PreCompact` to
     `SessionStart(source=compact)` at 97s with nothing inside it that can take
     the hero, and `SessionStart` already cleared to `IDLE`, so the exit was
     wired before the entry was. `source` never reaches the daemon —
     `HookEvent` does not carry it — so the window closes on _any_
     `SessionStart`. Broader than the compact case, and the safe direction.
     **The screen never covers a question, and did not achieve that by
     ranking.** The demotion out of tier 1 was argued on exactly this, but a
     rank only decides between sessions and the transition overwrote the state
     of the one it landed on: `NEEDS_PERMISSION`, `FAILED` and a promotable
     `WAITING` all became `COMPACTING`, measured. `applyEvent` now drops the
     event when the effective state is asking for a human.
     **Two limits accepted rather than fixed.** A compaction whose
     `SessionStart` never arrives sweeps until eviction at ten minutes, because
     `effectiveState` freezes every non-`IDLE` state — §Sweeping proposed a
     two-bound window sized off the current maximum, and that is deferred. And
     a question asked within the last `WAITING_AFTER_MS` has not promoted yet,
     so a compaction starting in that minute does take the stage.
     The rank is the departure from the frozen spec, and `spec.md` §4 carries
     it along with the one thing the amendment left open — where it sits
     relative to `WORKING`, `THINKING` and `DONE`.
  9. dizzy ✅ (StopFailure) — **taken out of order, ahead of 6 and 8.** It is
     the last state that was on the fallback, so building it is Stage 3
     correctness (the `[x]` in Stage 3) rather than Stage 4 art, and the 6 Sep
     Tier A gate above governs what gets cut, not what gets pulled forward. Recorded here
     because this list is what the 6 Sep decision is read off, and a plan that
     calls a shipped item deferred will mislead exactly that decision
  10. ✅ wizard (WebSearch/WebFetch) — 5.5% of real tool calls. Built 24 Aug;
      the `TOOL_ANIMATIONS` wiring landed with the art rather than after it,
      against the "art first, wiring last" note below
  11. ✅ board game (`Agent`) — 0.7%, the least-seen of the screens that
      have a measured tool-call frequency. Nine of the catalogued screens fire on
      hook events or timers and have no tool-call frequency at all, so this is
      not a claim about the whole catalogue — and not about triggers either:
      `overheated`'s is measured too, at ~0.1% of sessions, which item 12 says
      leaves "no 'rarest catalogued' to be rarer than". An earlier version of
      this line said six, which no enumeration of the catalogue produces. Art landed 25 Aug at 11:07 and the
      `TOOL_ANIMATIONS` entry at 12:23 — one hour sixteen, the tightest of the
      three art-then-wiring gaps against `overheated`'s three hours and the
      payoff's seven. That is this list's own "art first, wiring last" rule
      followed rather than broken. The trigger was
      `Agent`/subagents until 25 Aug, when a live capture settled it as `Agent`
      alone at a two second loop: keyed on `subagents > 0` it would have been on
      for 53% of the panel's waking life
  12. ✅ **overheated (`StopFailure` with `error_type` `rate_limit` or `overloaded`)** — proposed
      on 22 Aug, not part of the original catalogue, and therefore a change to
      this plan rather than work under it. It is the cheapest screen left:
      the error has been stored since Stage 3, so the trigger needed no new
      event, no settings change and no protocol field — only for `animationFor`
      to refine `FAILED` by it the way it already refines `WORKING` by `tool`.
      Wired 24 Aug, and the wire field turned out to be `error` rather than the
      `error_type` assumed since Stage 3, so nothing had ever reached it. Tier B, behind the 6 Sep gate with
      the rest, and the first thing to cut if that gate is at risk: `dizzy`
      drew every `StopFailure` before this, so cutting it loses a distinction
      rather than leaving a state blank. **Art first, wiring last** — the
      wiring lands in `packages/daemon`, which Stage 3 marks done, so building
      it first means either reverting shipped code at the gate or leaving a
      dead branch behind. Art landed at 08:58 and wiring at 12:01, both on 24 Aug — the order held,
      which is the part that matters, but they were hours apart rather than
      days. Through `spec-grill` once; the first plan was found
      unbuildable and rewritten around a sploot pose, which is upstream's scene
      and which `docs/ANIMATION.md` §The generation contract names as its own
      example. Plan in `PLANS.md`. Measured after the first
      draft of this entry went in without one: across 1,030 local transcripts
      outside this project a usage limit was hit in **one session**, ~0.1% of
      sessions. That does not divide against item 11's 0.7%, which is of _tool
      calls_ — and item 11 says in as many words that its figure is "not a claim
      about the whole catalogue", so there is no "rarest catalogued" to be
      rarer than. What can be said is that this is the only entry whose trigger
      was counted in sessions at all, and one in a thousand is rare by any
      reading. Salience rather than frequency is its case, as with item 7
  13. ~~road bike (long runs)~~ — **cut, 25 Aug.** `spec.md` §5 files it under
      "Tier C — stretch (2): road bike, beacon. Cut without regret", and this
      is that cut being taken rather than a new judgement.
      It is the most expensive item in the catalogue: the first prop that would
      carry Clawd, and no animation in the corpus has a seated pose — every
      one of them stands, climbs or lies. And it has no trigger. `spec.md` specifies
      one ("any tool, same session >90s") but nothing implements it:
      `Refinement` in `animation.ts` is `{ tool?, errorType? }`, so no elapsed
      time reaches the mapping. So the work is a pose the corpus does not have,
      a prop nothing else needs, and a measurement that does not exist.
      Nothing in the tree references it — no SVG, no `SPRITE_NAMES` entry, no
      `ANIMATIONS` entry — so unlike `sweeping`'s wiring this cut reverts
      nothing and costs nothing. If it is ever wanted, the cheap wiring is an
      elapsed field on `Refinement`, branching inside the `WORKING` arm, rather
      than a new state in `effectiveState`.
      `beacon`, the other Tier C item, was never a plan item of its own and
      needs no separate cut.

**`Stop` does not mean "the turn finished".** Confirmed against live docs in
Stage 3: it fires on every response. So the payoff screen above cannot be
keyed on it as written. **It has a different trigger now, and this is no longer
speculation:** a quiet period after the last event, which the daemon can see and
a hook cannot — `DONE_AFTER_MS` and `DONE_SHOWN_MS` in `effectiveState`, landed
24 Aug with the `DONE` state.

## Stage 5 — Personalisation (Sun 6 – Sun 13 Sep)

- [~] The recipient's pack (gitignored): palette, quips, `birthday`, logo, pet
  sprite. **Four of the five are in, 26 Aug** — a palette chosen for the two
  entries that actually reach the glass, quips mapped per state plus an idle
  rotation, `birthday: 09-23`, and a 14x17 mark on the laptop lid. The pet
  sprite was the remainder, and it needed art **and** a field — a first
  version of this line said "art rather than a field", contradicting the pet
  bullet in this same file and `packs/example/README.md`. Both landed 28 Aug,
  so the pack is five of five.
  It is no longer gitignored-and-nowhere: it is a private repo, cloned to
  `~/.tamaclaude/pack/` on the author's machine and installed by step 3 of
  `docs/INSTALL.md`. Goes at `~/.tamaclaude/pack/` or wherever `TAMACLAUDE_PACK`
  points; `tamaclaude pack` confirms which, and prints the countdown.
  **It is placed by hand and nothing ships it.** Being gitignored is the
  point — it holds material that should not be on the public internet — but
  the consequence is that a fresh clone does not contain it, so it travels
  out of band during the in-person install and exists in exactly one place
  afterwards. A wiped Mac, a deleted folder or a re-clone loses it, and the
  daemon then refuses to start with `no pack configured`.
  **The channel is decided: its own private repository**, created 26 Aug,
  with the recipient as a collaborator. `docs/INSTALL.md` step 3 clones it
  straight into `~/.tamaclaude/pack` — `resolvePack` only reads
  `manifest.json` from the directory and never enumerates it, so the `.git`
  inside is invisible to the loader.
  That was the alternative to closing the project, which would have solved
  the same problem by making the public history a one-way door. It also
  answers three things at once: delivery, backup (the repository _is_ the
  copy), and updates, since a quip added later is a `git pull` rather than
  a hand-off. **The address stays out of this repo** — the guide says "the
  address you were given", the same way it treats the main one.
  The remaining risk is his GitHub auth on a new machine, so hand over a
  copy on whatever ships with the panel as well; the guide takes either.
  **What the palette reaches today, measured 25 Aug.** `packages/cli`
  composes with `extent: 'panel'`, so `withEnvironment` paints the
  environment across the whole framebuffer and replaces the painter's ink
  with `environmentInk(time)`. Swapping a pack for one that agrees on
  nothing — magenta background, yellow ink — changes: - **zero** pixels with an empty strip, which is the modal case: `isLive`
  keeps a session ten minutes, and overnight or any longer gap renders
  the empty desk; - **zero** for a `resting` chip, because `TONE_ROLE` maps it to `ink`,
  which has already been substituted — and `DONE`, `IDLE` and `ASLEEP`
  are all resting; - 240 for an `active` or `attention` chip, capped at five by `MAX_CHIPS`.
  So `palette[0]` never reaches a shipping pixel, and `palette[1]` only via
  `sceneColours`' fallback on a pack carrying fewer than four entries.
  **Both halves are true of the chrome and the pet sprite falsified them on
  28 Aug**, which was flagged in advance because the same chrome-versus-art
  confusion had already been corrected once, in `pixel-art-critic`'s own
  description. A blob decodes to literal RGB565 words: the drawn sprite is 793
  pixels of `palette[0]`, 152 of `palette[1]` and 48 of a fifth entry added for
  it, written straight into the framebuffer with nothing substituting anything.
  This line told itself to be corrected "in the commit that lands the field,
  not after", and the commit that landed the field did not touch it. A
  self-imposed exit condition naming its own commit is worth no more than the
  habit of reading it.
  **That is a consequence of a decision already taken, not a defect.**
  `environment.ts` argues the ink substitution: a pack's ink is chosen
  against its own background, and white on a midday sky is nearly
  invisible, so whatever the text sits on should decide its colour. `panel`
  extent was picked on 22 Aug, in the commit that wired the scenery on,
  with the trade priced in both directions.
  **The palette is still load-bearing** — the logo item below quantises to
  it and the pet sprite is drawn in it — so what needs correcting is this
  line's implied promise that a recipient will _see_ their palette in the
  chrome. They will see it in quips, the birthday quip, their logo, their
  pet, and a 240px chip while a session is working.
  `packages/renderer/src/pack-swap.test.ts` holds the measurement;
  `panel-mock --pack <dir>` renders any pack, which no tool could do
  before — though `blit.ts` still cannot, so nothing yet puts a pack on
  glass.
- [x] **Watch the birthday on the panel.** Done 26 Aug, four weeks early and
      without touching the clock: a copy of the real pack dated that day, the
      daemon pointed at it with `TAMACLAUDE_PACK`, and the panel watched
      through the states. The party hat and the QR both appeared, and **the QR
      scanned off the glass** — which was the one thing no test could reach,
      the module being 0.41 mm at 247 PPI. It exercised resolution, schema, the
      message band, the stage and the camera in one action.
      Copying the pack beat moving the clock: no system state changed, and the
      real pack kept its own date throughout.
- [x] Pet sprite, drawn from photos — on idle/asleep, not the mascot. Done
      28 Aug. **A foreground prop, 52x36 art in a 60x42 slot at
      stage-relative (0, 118)**, hand-drawn as an SVG and baked with
      `logo2pixel --format pack`; nothing in the tree turns a photograph into
      pixel art, so the drawing was the work. It was 32x22 at (0, 144) until
      the same day, when it was raised for presence rather than for
      legibility — the Stage 4 generator bullet carries the measurement and
      the reversal.
      **What was checked, and on which version, because these are not the
      same artefact**: the _32x22_ went on the panel, was photographed there,
      and a reader who knew nothing about it called it "a cat curled up
      sleeping" off that photograph — species, pose and state, better than
      either critic managed. That is what retired the "unreadable" claim
      above. The shipped _52x36_ has been composed through `panel-mock` on
      all four grounds and is running on the panel, but has not been
      photographed on glass and has had no cold read. A first version of this
      line claimed the cold read for it.
      **Photographed on glass 28 Aug, on the night ground, and it is the
      weakest of the four**: the coat is 1.26:1 against night sand, so the
      silhouette barely separates and the rim over the ears reads as a pale
      squiggle rather than as ears. On dawn, day and dusk the notch between
      the ears reads and it is plainly a curled animal. Landed as a
      background prop at that standard rather than redrawn again, with 16
      days to the freeze
- [x] Pet sprite: schema field, bounds mirrored from the slot, painter, and the
      daemon line that selects it — the logo's sibling item, which the pet had
      no equivalent of. Landed 28 Aug; the mirror is pinned by a test in
      `packages/renderer/src/pet.test.ts` and the tool's copy by one in
      `tools/logo2pixel.test.ts`
- [x] **Company logo → pixel** — the tool is built and the lid draws its output.
      `tools/logo2pixel.ts` rasterises, snaps to a pack's palette plus the ground
      the mark sits on, and emits a PNG to look at, SVG rects to paste, or — since
      26 Aug — `--format pack`, which is the only one the renderer can consume.
      **No `sharp`, and none was needed** — though the branch that finished this
      did add `@xmldom/xmldom`, build-time only, to gate the animation SVGs as XML.
      The plan named a dependency the
      repo already had both halves of. Playwright rasterises the SVG the way
      `tools/svg2frames.ts` does, and `snapToPalette` was already
      nearest-neighbour against a palette it is handed; it was written to snap
      frames to an SVG's own colours, and the palette is a parameter.
      **It warns when a palette merges two of a logo's colours**, which is the
      failure that is otherwise silent: a small palette cannot represent an
      arbitrary logo, and the mark that loses is simply absent from the output.
      The warning reads six-digit hex only, wherever the word `fill` precedes it,
      so it also picks up CSS declarations. What passes it silently is `#fff`
      shorthand, stroke-only artwork, `rgb()` notation and — the one that matters
      for a company mark — **gradients**, which name no colour at all, so a
      gradient logo gets no warning while the quantiser flattens the whole ramp.
      **The delivery landed on 26 Aug.** `--format pack` emits RGB565 through
      `encodeRect` plus a bit-mask, the schema takes a `logo` field, and
      `packages/renderer/src/logo.ts` draws it. The private re-bake of animation
      frames is not needed and never was the plan.
      **One thing the merge warning cannot see, found by rendering a real mark.**
      The check looks for two declared fills colliding in a small palette. A logo
      with _one_ colour passes it and still comes out wrong: the browser
      antialiases the edges, and `snapToPalette` resolves each mid-tone to whichever
      entry is nearest, so a white mark arrived speckled with the pack's attention
      amber and active teal — three colours from one. `--format pack` renders with
      `shape-rendering:crispEdges` for that reason, which on the mark that ships
      also cuts the payload by 6.6% at `--width 14` and 19.3% at 16, because a
      two-colour image run-length-encodes better. This said "about 30%" until
      27 Aug — the fourth survivor of a phrase corrected everywhere else in the
      same commit, and inside the file that commit was editing.
      The logo itself is pack content and is not in this repo.
- [x] **A pack `logo` field, and something that draws it.** Built 26 Aug.
      The mark is fixed to the lid, which is safe because the lid does not move:
      measured across all sixteen frames of `typing`, it is identical pixel for
      pixel, the only thing changing inside it is the pulsing square, and
      nothing occludes it. A test re-checks that against the baked sprite.
      **The pulsing square stays and is cleared underneath the mark.** It
      showed through the mark's transparent parts — through the counter of the
      letter — and removing it would kill the lit-screen effect for every pack
      without a logo, which the SVG calls load-bearing. The lid colour it is
      cleared to is _sampled from the framebuffer_ rather than written down: the
      sprite is drawn by then, and a constant would be a second copy of a value
      that lives in the artwork.
      **Where it goes: the laptop lid, not the splash — and this overrules the
      freeze rather than filling a gap.** The screen spec's easter-egg table
      routes the logo to the boot splash, and that spec is the _later_
      document: `PLANS.md` §Typing argued for the lid on 18 Aug, the splash
      shipped without a logo on 21 Aug, and the 25 Aug freeze still said
      splash. The lid wins for a reason the freeze did not have in view — the
      splash is drawn by the firmware (`draw_splash()` runs unconditionally in
      `app_main`, so it is on at every power-on until the daemon paints over
      it), and firmware is flashed rather than configured, so a splash logo
      cannot be a pack field at all. The manifest freeze at the same spec names
      `logo`, so the field itself is in scope.
      **Size it against the codec that exists, not against a decoder.** The
      renderer's runtime dependencies are `@tamaclaude/packs` and
      `@tamaclaude/protocol` and nothing else — there is no image decoder in
      the shipping graph, and Playwright is a build-time dependency that never
      reaches the recipient. So the pack cannot ship a PNG or an SVG. What it
      can ship is what the sprites already are: an RGB565 payload through
      `encodeRect`/`decodeRect` in `@tamaclaude/protocol`, which
      `packages/renderer/src/sprites/index.ts` already turns back into pixels.
      That makes this a schema entry, a loader, a blit at a known slot, and a
      third output format on `tools/logo2pixel.ts` — which today emits a PNG to
      look at and SVG rects to paste, **neither of which the renderer could
      consume** — `--format pack` is the third, added 26 Aug, and is the one it
      can. Smaller than it first looked, and the tool is the part that
      needs the change.
      **Seen on the panel, 26 Aug**, which is the standard the birthday item
      four boxes up was held to and the one that matters: the recipient's own
      pack, the launchd daemon, the device on the desk, and a human looking at
      it. The mark reads at 14x17 on the red lid. That is why this is `[x]`.
      A review was right that the _tooling_ claim was the weaker one, and that
      the plan said so itself at §Stage 2: `blit.ts` hardcoded `packs/example`,
      which has no logo, so nothing in this repo could put a triggering pack on
      the device. Both halves are fixed — `panel-mock --pack <dir>` and
      `blit.ts <frames> [port] [orientation] [sky] [pack]` — and the wiring in
      `blit-scene.ts` is now gated by `compose-extent.test.ts`, because a
      mutant that keyed the mark on `thinking` left all six gates green. It was not met by the commit that built the
      feature — that one verified with a private render nobody else could
      repeat, which is the shape this paragraph rejects — and wiring the logo
      into `blit-scene.ts` was three lines.
      The original wording, kept because the reasoning is what mattered: if
      `panel-mock` cannot draw a pack-supplied mark by **10 Sep**, stop: a
      trigger that fires when someone opens a file is a rubber stamp, which is
      the objection `PLANS.md` already makes to a gate of that shape. Note the
      input landed on 26 Aug: the recipient's `logo.svg` is in the pack repo,
      cropped to its artwork and baked to a 14x17 mark. It is a single flat
      colour, so the gradient hazard above did not arise — though it would have
      passed the merge warning in silence if it had.
      **Resolved 26 Aug; kept as the reasoning, not as a live option.** The
      fallback does not deliver, and that is why it was not one. A
      private re-bake writes the mark into `packages/renderer/src/sprites/`,
      which is tracked; the recipient installs from a clone of a public repo
      — the recipient clones onto his own machine — so an uncommitted change
      on this Mac reaches nobody, and committing it puts a company mark in
      public history permanently. If the field does not land, **no logo ships**
      — the placeholder stays and the panel is still a gift. Two paragraphs
      above promise the recipient will see "their logo"; if this is cut, that
      promise goes with it, and the deferred table takes a row.
- [x] Quips mapped to states, never randomised — `messageFor` looks up
      `quips.mapped[state]` and only falls to the `idle` rotation when a
      resting state has no mapped line. Built well before this was ticked; the
      box was simply missed.
- [~] Rare easter eggs: a franchise-flavoured idle, plus idle quips from the
  pack. **The quip half is built** — `messageFor` rotates `quips.idle` by
  the minute on `IDLE`. The franchise-flavoured animation is not.
- [~] ~~Pixel scene of the two of them coding~~ — **cut 31 Aug, by the owner,
  on the licence the spec gave it.** The frozen screen spec files it Tier C,
  "cut without regret", and that is what happened: it was a nice-to-have, the
  art needed rounds of the owner's judgement that the remaining days are
  better spent on the board and the install, and nothing else depends on it.

  **The mechanism stays, and it is a capability rather than dead code.** A pack
  _may_ carry a `scene`; none does, which is the status `birthday` had before a
  pack carried a date. `packages/cli/src/midnight.ts` holds the trigger and the
  states it may cover, `packages/renderer/src/cover.ts` paints it, and a pack
  without one renders exactly as it did before any of it — `packs/example` has
  no scene and never should. Removing it was considered and rejected on the
  date: it is merged, tested and inert, and a removal thirteen days from
  feature freeze buys tidiness at the cost of another review round on code that
  currently cannot misbehave.

  Three things its construction left behind that are worth keeping, none of
  which depend on the scene ever existing: `logo2pixel` now knows the slot it
  bakes for rather than misdirecting an author to two fields that do not fit;
  its ground warning names opacity, which is the condition that actually
  deletes pixels; and `--full-colour` exists for any future art that replaces
  the stage rather than sitting inside it.

  The art got as far as a third draft that reads correctly — the kneeling chair
  carries the recognition, which is what a photograph of the desk made
  obvious. It is untracked in the private pack if it is ever wanted; adding it
  is one key in a manifest, decidable on 22 Sep with the panel in hand.

- [x] Birthday screen, date-triggered 23 Sep. **Trigger, art, stage and QR are
      built, and the screen has been seen on the panel.** It went `[~]` earlier on
      26 Aug for the right reason — every check was a unit test against a synthetic
      pack, `packs/example` has no `birthday` key and `blit.ts` hardcodes it, so
      nothing in this repo could put a triggering pack on glass. That is what the
      live run settled: real pack, real daemon, real panel, and a phone that read
      the code. No _tracked_ pack carries a date and none should; the recipient's
      private pack repo carries it. `packs` takes an
      optional `birthday: { date, quip }` keyed `MM-DD` so it recurs, and
      `isBirthday` compares in local time because the day the panel should
      celebrate is the one the person beside it is having. `02-29` falls back
      to the 28th in a common year, and a day that exists in no month is
      refused — both because accepting a date that can never fire is a failure
      nobody can notice until the day has passed.
      The quip beats the resting and working lines and loses to any state
      asking for a human. **That is not the rule `DONE` is ranked by**, and
      two earlier versions of this line said it was: `DONE` ranks below
      `WORKING` because "a payoff belongs on a quiet desk", and this covers
      both. They share only the attention half. The reason to differ is that
      rank decides the stage, where a resting Clawd over a running tool would
      be a lie, while this decides the message band and the animation still
      shows the work. Two reviews caught the claim independently.
      **The art is built.** `assets/clawd/animations/birthday.svg` — a jump, both
      claws up, a hat, confetti — baked, and on the panel at 8fps and 12,138 B/s
      against the 40,000 B/s bar. It doubles as the hero of the webpage the QR
      points at. Two findings worth keeping: a claw cannot reach above the head by
      rotation alone, so both extend the way `gym` and `permission-sign` do; and
      the hat was red until the render was counted, at which point 46 pixels of
      the raised claws' edges were snapping to it rather than to black, because
      #B22222 sits on the peach-to-background ramp. Purple does not. §Palette
      snapping asks what edge a new colour sits between, and counting the frame is
      how you answer it.
      **The stage is wired, and to a stricter rule than this item predicted.**
      The prediction — deleted from this paragraph, so it is quoted rather than
      pointed at — was that wiring the stage wants the quip's rule: beats resting
      and working, loses to anything asking for a human. (The line four
      paragraphs up saying the same of the _quip_ is correct and is not what was
      wrong.) `animationForPanel` covers `IDLE` and `ASLEEP` only.
      The reason is not the one the ranking paragraph above gives, and an earlier
      draft of this line claimed it was. The band can celebrate over `WORKING`
      because the work stays legible from the animation and the strip chip —
      though not from the band itself, which shows one string and gives it to the
      quip for the day. The stage has one picture, so celebrating over a running
      tool means _replacing_ it. That is a judgement about what a once-a-year
      screen is worth, not a consequence of `STATE_RANK`, which ranks _sessions_
      and never sees a birthday. It is written down here because it was chosen.
      `DONE` keeps `payoff`: a real event with its own picture, on a window that
      expires 15s later — into `IDLE` usually, but into `WAITING` when the
      session has a notification, because `DONE_AFTER_MS + DONE_SHOWN_MS` is
      exactly `WAITING_AFTER_MS` and `effectiveState` checks `WAITING` first.
      There the birthday does not follow at all; it waits for the human, which is
      the point.
      **The QR is built, and it costs the strip and the message band.** On the
      birthday, and only on the states the birthday already covers, the right
      column shows a QR instead. One predicate — `sceneFor` sets it when
      `animationForPanel` chose `birthday` — so it is gone the moment a session
      needs a human and back when the desk goes quiet, with nothing to decide when
      to take it down. The symbol is a module matrix in a tracked file, encoded
      offline by `tools/bake-qr.ts` with `qrcode` as a root devDependency; the
      renderer keeps zero third-party runtime deps. EC L rather than Q: both give a
      4px module, and L's 25 modules leave 16px of slack where Q's 29 fill the band
      to the pixel and would drop to a 3px module on any layout change.
      **What it costs is the pack's birthday quip on those two states**, measured
      rather than estimated: 148px of band, 132 taken by the symbol at the smallest
      module worth drawing, and a line of text needs 19. The quip still shows on
      every state the QR does not take. **The URL it points at is live** —
      checked 30 Aug, the URL in `qr.data.ts` returns 200 by way of two
      redirects, to the `www.` host and then a trailing slash. This line said the URL "serves nothing yet — that is the open
      item, not the code" until then. It was true when written and stopped
      being true without anyone editing it, which is the failure mode a plan
      read for sequencing cannot afford.

  **The known cost is flicker.** On a working birthday the stage alternates
  between the party hat and the work picture at every turn boundary, all day.
  Nothing measures how that reads, and the only thing that can is the clock
  test below.
  The rule lives in a total `Record<SessionState, boolean>`, not a `Set`.
  That is what makes a tenth state fail to compile until someone decides; it
  is **not** what kills a wrong row, since a `Record` takes `WAITING: true`
  as happily as a `Set` took `'WAITING'`. What kills it is a test row per
  state, added after a review planted exactly that and watched all six gates
  stay green.
  Selection itself is built — `TAMACLAUDE_PACK`, else
  `~/.tamaclaude/pack/` — so the trigger is reachable as soon as a pack names
  a date. What is not built is anything that _sets_ the variable on boot; that
  is the launchd item in Stage 3. This paragraph said the mechanism was
  missing and cited the Stage 1 line for it, in the same stage whose first item
  already said where the pack goes; the commit that built the resolver left the
  contradiction standing and a review caught it. An earlier version of this
  sentence put the two five lines apart, which is wrong by about thirty.

- [x] **The boot splash — design it together, then bake it into the firmware.**
      Clawd waving beside the wordmark, landscape, chosen by Alex from four
      rendered candidates on 21 Aug. The far claw is tucked because at its
      base position it sits mid-body on the opposite side and reads as a
      snout — which only became visible once a pose raised the other one.
      **It was the last firmware change until 6 Sep**, and it is flashed —
      built clean and confirmed on the panel. That sentence read "the last
      firmware change" for four days; `IDLE_BLANK_MS` falsified it. See the
      Stage 2 exit above, which now records the bar and both exceptions rather
      than claiming there are none.
      The predicted route was "compose it in the renderer, dump the
      framebuffer, vendor the bytes". What shipped reuses the _asset_ pipeline
      instead of the renderer: `assets/clawd/splash.svg` is posed off
      `base.svg` with transforms like every animation, and
      `tools/bake-splash.ts` rasterises it, snaps it to the declared palette
      and RLE-encodes it with `encodeRect` — the same codec `decode_rle()`
      already consumes, so `draw_splash()` is a loop over the `fill()` that was
      already there and no new wire format exists to be wrong. 2,892 bytes of
      `.rodata`, 38.1:1.
      The wordmark is drawn from the renderer's own glyph table rather than
      set as `<text>`. Chromium antialiases glyph outlines at every size, and
      review found the soft edges snapping to Clawd's body salmon — 120 pixels,
      11% of the wordmark's ink, in a stripe along the top of "tama". Inside
      the palette, so no palette check could see it.
      `tools/bake-splash.test.ts` is the gate, because the firmware is in none
      of the six and almost nothing else can be. It asserts where each colour
      lands, and a hash of the artwork, so neither an upside-down table nor a
      header left stale after an edit can pass — both of which an earlier
      version of it did.

- [~] ~~**Environment extent as a pack field**~~ — **cut, 25 Aug.** One
  optional field defaulting to `panel`, about an hour's work.
  **What it would buy is the recipient re-opening a decision taken on
  22 Aug.** `panel` was picked in the commit that wired the scenery on, not
  at the 25 Aug freeze — the freeze record covers the screen list, the
  state machine and the pack format, and says nothing about extent. Both
  extents are built and `scene.ts` prices the trade both ways: `stage`
  keeps the pack's ink legible but "makes the panel look like a picture
  bolted to a terminal".
  **The rejected side is renderable**, which is what makes this a cut rather
  than a deferral — the judgement can be re-checked by looking instead of by
  reading this. `tools/panel-mock.ts --extent stage` draws it: the scenery stops where the landscape stage ends and the
  rest of the panel is flat pack background, against `panel`'s sky running
  edge to edge with the resting chip taking environment ink. A pack field's
  only effect is selecting that rejected side — 28,160 px against 0 with an
  empty strip, measured in `pack-swap.test.ts`.
  **This declines a request rather than tidying an oversight**, and
  `daemon.ts` records the request: a switch was asked for so the owner or
  the recipient could change it later. The reason to decline is precedent
  as much as the date: the screen spec's timings table already refused this
  shape of field — schema, validation and tests for knobs nobody will ever
  turn — and this is an hour of code and a schema entry for a lever with
  one useful setting. If it is wanted after 23 Sep the deferred table
  carries it.
  Schemes were the other half and stay deferred separately. A pack-supplied
  scheme would not restore the pack's own `palette[0]` and `palette[1]` to
  the panel — the environment still covers the background and still
  substitutes the ink — but it would hand the pack the scheme's colours
  instead, which is more of the panel than extent buys rather than less.
  It would also invalidate the sixteen colours in `tools/contrast.ts`'s
  `AGAINST` table, transcribed there from `environment.ts`, and every
  animation carrying a contrast figure would need it re-run. No count is given
  because the obvious grep undercounts: `overheated.svg` writes its figures as
  `7.76 dawn` rather than `7.76:1`, so a search for the ratio form misses it,
  and `PLANS.md` carries figures for animations whose SVGs do not.
- [ ] `packs/alex/` — proves the pack swap works

### After the date — maintenance, 6 Sep onward

- [x] **The panel stops being a lamp.** Two halves, because neither works
      alone. `IDLE_BLANK_MS` in the blitter drops the backlight after thirty
      seconds of silence — the only half that can, since no protocol message
      reaches that GPIO and a host that sleeps or crashes cannot darken a panel
      it has stopped driving. `TAMACLAUDE_QUIET` in the daemon stops it sending
      overnight, which is the half that matters when the Mac stays awake all
      night. Dark is now three things, not a fault: never driven (splash, and
      exempt), host gone, or host deliberately quiet. `docs/INSTALL.md` leads
      its troubleshooting with it, because a black panel at midnight is the
      most alarming thing this device does and is usually correct.
      Cost a reflash — Stage 2's exit records the bar it broke.

## Stage 6 — Hardening + gift prep (Mon 14 – Sat 19 Sep)

- [ ] Run it on Alex's desk all week. Fix what irritates. No new features.
- [ ] Assemble board in printed case
- [~] Dry-run the full install on a clean macOS user account, **following
  `docs/INSTALL.md` and fixing whatever it gets wrong** — the guide is the
  artefact under test, not just the software.
  **Exit criterion, written so it can fail:** somebody who is not the author,
  on an account that is not the author's, gets from a bare machine to a
  reacting panel using only the guide and no verbal help. Fixing the guide
  as it fails is the point — the criterion is that a _second_ pass needs no
  fixes and no talking. One run that needed edits is a pass for the item and
  a fail for the guide, which is the distinction worth keeping. Note this made the item bigger
  while leaving it on 19 Sep, behind a buffer meant to absorb something else.
  **Bring this
  forward — it is the highest-information hour left in the plan.** The
  untested assumption under everything else is that a Mac which is not this
  one can build and run the repo at all: Xcode CLT, node 24.16.0, pnpm, a
  full `tsc -b`. Finding out on 19 Sep leaves four days, and the recovery
  for "no toolchain" is a packaging project rather than a bug fix.
  **Half of it is done, and it earns its billing.** A fresh `git clone` of
  the repo into an empty directory installs, builds and passes all six
  gates — 49 files, 585 tests, no local state. What that cannot see is
  anything cached per-_user_ rather than per-checkout, which is where the
  real risk lives: the Playwright browser is the known one, and pointing
  `PLAYWRIGHT_BROWSERS_PATH` at an empty directory stands in for the clean
  account. Doing that has now caught two separate suites failing with no
  mention of Playwright — `frame-palette` on 25 Aug and `logo2pixel` on
  26 Aug, the second with five assertions reading `expected 1 to be +0`.
  Both now name the install command instead.
  **What is left needs a real account**: Xcode CLT, whether node and pnpm
  exist at all, the launchd agent, and the device. Run the clone-and-gate
  check after any change to tooling — it is two minutes and it is the part
  that does not need one.
- [ ] Printed card: repo QR, and "if it ever stops, open Terminal and run
      `tamaclaude status`" — `status` rather than `pack`, per Stage 3 above
      and the comment where it is defined.
      **The form is decided: `pnpm tamaclaude …`, from the project folder.**
      A bare `tamaclaude` would need `pnpm setup` and a global link, and that
      was rejected — it makes the binary's own printed remedies wrong for
      whichever reader did the opposite, and it puts something on `PATH` that
      goes stale when the folder moves. The CLI's `USAGE` block and `agent.ts`'s
      upgraded-node remedy print the `pnpm` form to match.
      **So the card needs two lines, not one**, because a Terminal opens in the
      home folder and `pnpm` needs the project folder: `cd` to it, then
      `pnpm tamaclaude status`.
      **Not a one-line install** — Stage 3 decided against
      one and gave the reason: `git clone && pnpm install` needs Xcode CLT,
      node and pnpm first, and a brew tap is a second repo and a formula for
      one Mac. This line said "one-line install" until 26 Aug, which would
      have had someone building a thing the plan had already ruled out.
- [x] Flash the board with the splash. **Done 2 Sep**,
      the day it was handed over rather than on 19 Sep, because the gift moved.
      Verified by reading the app header back off the board: project `blitter`,
      version `46ea9e2`. Before flashing it read `arduino-lib-builder` — the
      Waveshare factory image — which is the one-line proof that an unflashed
      board would have shown a vendor demo forever, whatever was set up on the
      recipient's Mac.
      **The rebuild was real, and it is what the risk row priced at a day.**
      `blitter.bin` predated `splash-data.h`, so this was a first build in this
      checkout, and the toolchain had rotted. `docs/HARDWARE.md` §Rebuilding
      records the four failures and their fixes; without them this is an hour
      of guessing at somebody else's Python environment.
- Semantics of the three unmapped idle quips — needed to decide whether any of
  them deserves a state rather than the random pool
- Confirmation that personal packs stay out of the public repo
