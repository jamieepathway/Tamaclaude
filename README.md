<h1 align="center">Tamaclaude</h1>

<p align="center">A tiny desk display for your Claude Code sessions.</p>

Tamaclaude puts an animated pixel crab on a 172×320 panel on your desk. He
reacts to what Claude Code is doing — boulders while it searches your codebase,
types while it writes, hits the gym while it runs your build, and goes to sleep
when you do.

Inspired by [clawd-tank](https://github.com/marciogranzotto/clawd-tank). See
[CREDITS.md](CREDITS.md).

## How it works

```
Claude Code hooks -> tamaclaude-notify -> daemon -> USB-CDC -> ESP32-C6 panel
                                               \-> canvas  -> browser (dev)
```

Unlike upstream, **all rendering happens on your Mac in TypeScript**. The
device receives dirty rectangles of RLE-compressed RGB565 and blits them to the
display. It's flashed rarely — twice so far — and every screen, animation and theme
change is a host-side code change.

That also means the whole thing runs without hardware: the renderer draws to a
browser canvas in development.

## Status

In development. See [BUILD_PLAN.md](BUILD_PLAN.md).

## Hardware

- [Waveshare ESP32-C6-LCD-1.47](https://www.waveshare.com/wiki/ESP32-C6-LCD-1.47)
  — 172×320 ST7789, USB-C, **8MB flash** measured on the board. Waveshare's
  wiki says 4MB for this SKU and is wrong; upstream clawd-tank's README was
  right. See [docs/HARDWARE.md](docs/HARDWARE.md).
- A printed case (see [docs/HARDWARE.md](docs/HARDWARE.md))

## Packs

A _pack_ is a palette, a quip table, an optional birthday and an optional
logo; props
are planned. The character is **not** part of it — Clawd is shared across every
pack, so there is one base geometry and one animation set to maintain. His
colours are baked into the sprites and no pack changes them.

`packs/example/` is the reference and the only pack in version control.
Everything else under `packs/` is gitignored, so personal packs sit in your
working tree without reaching the public repo. Point `TAMACLAUDE_PACK` at one,
or put it in `~/.tamaclaude/pack/`, and the panel picks it up without a
rebuild. How much changes is measured rather than promised — see
`packages/renderer/src/pack-swap.test.ts`; today it is the session chips, and
the logo quantises to it (Stage 5, built), and the pet sprite that will is
still Stage 5.

There is no bundled default: with no pack configured the daemon refuses to
start rather than falling back to the example, because a fallback would turn
"you forgot to point at your pack" into a panel that looks entirely correct.
`pnpm tamaclaude pack` says which one is loaded and when its birthday fires.

## Setting it up

**[docs/INSTALL.md](docs/INSTALL.md)** is the guide for getting a panel
running: what to install, in what order, and what to do when it stops. Written
for somebody who was handed one rather than somebody working on it — the
section below is the other audience.

## Development

```bash
pnpm install
pnpm exec playwright install --only-shell chromium
pnpm build && pnpm test && pnpm lint && pnpm typecheck && pnpm format:check && pnpm knip
```

The browser is not optional and `pnpm install` does not fetch it. **Playwright
publishes no install script** — it has had none since 1.38 — so a browser
arrives only when the `playwright install` CLI is run explicitly. (It is not
pnpm 10 declining to run dependency scripts, which is a real thing that happens
to `unrs-resolver` here and would send you to `pnpm approve-builds`, where no
amount of approving produces a browser.)

`tools/svg2frames.ts` rasterises every animation frame in headless Chromium and
`tools/frame-palette.test.ts` drives it end to end, so **`pnpm test` fails
without this line** — with an error naming `svg2frames.ts` and never mentioning
Playwright. CI has run it since 21 Aug, three days after Playwright entered the
tree; the documented steps here never did.

CI adds `--with-deps`, which installs Linux system libraries and does nothing
useful on macOS. Node is pinned by `mise.toml` at 24.16.0 rather than by
`engines.node`, which is a floor of `>=24.0.0` that nothing enforces;
`packageManager` is an exact pin and pnpm enforces it.

Nothing in the dependency tree compiles on install — verified by observation, a
clean clone building with no compiler invoked, rather than by the absence of a
`binding.gyp`, which is not a sound test: `fsevents` publishes
`"install": "node-gyp rebuild"` and ships a prebuilt binary instead. That is
narrower than "no Xcode CLT needed", which `BUILD_PLAN.md` Stage 6 still lists
as untested and which remains untested — `git` itself is usually CLT-provided
on macOS, so building and _getting started_ are different claims.

`pnpm dev` builds the panel harness and tells you where to open it — an
interactive page that animates at 8fps and switches orientation, layout and
animation live, with no hardware needed. It is driven by rendered frames rather
than by live Claude Code sessions. Stage 3 has landed for the daemon and the
panel; the harness's own event injection is a separate unchecked Stage 1 line.

To render an animation to frames and review it at true panel size:

```bash
node tools/svg2frames.ts assets/clawd/animations/typing.svg out/typing
node tools/contact-sheet.ts out/typing out/typing-sheet.png
```

## Licence

MIT — see [LICENSE](LICENSE).
