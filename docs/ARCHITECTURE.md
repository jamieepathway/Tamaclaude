# Architecture

## The one decision everything follows from

**The Mac renders. The device blits.**

Every frame is composed in TypeScript on the host. The ESP32-C6 receives dirty
rectangles as RLE-compressed RGB565 over USB-CDC and pushes them to the ST7789
over SPI. It contains no scene graph, no sprites, no state machine, and no
knowledge of Claude Code. It is flashed once and never again.

Upstream clawd-tank does the opposite: sprites live in device flash, the host
sends state, and an LVGL UI in C renders on-device. That is the better design
for a standalone product. It is the worse design here, for three reasons:

1. Every screen change would be a C change and a reflash. The whole point is
   that Alex can change screens in TypeScript.
2. It forces a second program — upstream maintains an SDL2 simulator in C that
   duplicates the firmware so it can be developed without hardware. Under
   host-rendering, the "simulator" is the same renderer with a canvas sink.
   There is nothing to keep in sync.
3. The recipient's device would need reflashing to receive a fix.

### Why it fits down the wire — measured

**The link carries 562.5 KB/s.** Measured on the board with
`tools/usb-throughput.ts` against the firmware in
`packages/device/firmware/throughput`, which reads USB-CDC and discards. A
real run, wrapped to this file's width:

```
per-second: 562.5 KB/s, 562.6 KB/s, 562.7 KB/s, 562.7 KB/s, 562.6 KB/s,
            562.7 KB/s, 562.5 KB/s, 562.5 KB/s, 562.5 KB/s, 562.6 KB/s

host and device agree to within 230 B/s — nothing is queueing between them, so
this rate is real rather than a buffer draining. It is what this firmware
sustains, not proof the link is saturated.
```

Two properties make that a dependable floor. The host's own write rate and the
device's received count agree to 0.04%, so nothing is queueing between them and
the figure is real rather than a buffer draining. And it holds flat from
256-byte writes to 64 KB ones — a 256x range, reproducible with
`pnpm throughput:sweep` — so there is no write size the daemon could choose
that would do better.

**It is not, however, the wire's limit.** USB full-speed bulk tops out at 19
transactions of 64 bytes per 1 ms frame, or 1,216,000 B/s; 562.5 KB/s is 47% of
that. A link running at half its ceiling is the signature of a device-side
constraint — the `usb_serial_jtag` driver's copy path, the 4 KB rx ring, or the
single-threaded read loop — rather than a saturated bus. So this is what _this
firmware_ sustains. Treat it as a conservative floor to design against, and as
a number the real blitter might beat rather than one it must fit under.

This section previously assumed 700 KB/s, described as a conservative reading
of what USB 2.0 full-speed gives CDC after overhead. The guess was about 22%
above the measurement, so every percentage published against it was that much
too flattering. (`tools/measure-compression.ts` actually divided by 700,000 —
decimal — which is 683.6 KB/s, so its own figures were 21.5% too generous. Both
units are binary now.) Reproduce with `pnpm throughput`.

| Payload                         | Bytes/frame | At 8fps  |  vs link |
| ------------------------------- | ----------: | -------- | -------: |
| Full screen 172x320 RGB565      |     110,080 | 860 KB/s | **153%** |
| Stage band only 168x200 RGB565  |      67,200 | 525 KB/s |      93% |
| Dirty-rect, 96x96 sprite region |      18,432 | 144 KB/s |      26% |

**Uncompressed does not fit, and the margin is thinner than it looks.** A full
screen needs half as much again as the link has. Even the stage band alone —
just the sprite, not the status or message bands — would eat 93% of it, which
is not a budget so much as a coincidence. Dirty rectangles and RLE are load
bearing here, not an optimisation.

### What it actually costs — measured

`tools/measure-compression.ts` runs the real codec over the real frames of
every animation in the repo, at 8fps, including the 16-byte rect header defined
in `packages/protocol/src/packet.ts`. Reproduce with `pnpm measure` — the
frames are regenerated each time, since `out/` is gitignored.

**The ratio column is against a 67,200-byte stage frame**, not the
110,080-byte full screen above. Animations are authored and rendered at
168x200, which is the stage band, and that is what a sprite update covers.

| Animation         | Mean on the wire | Worst frame |   At 8fps | Ratio | % of link |
| ----------------- | ---------------: | ----------: | --------: | ----: | --------: |
| `permission-sign` |            331 B |       692 B |  2.6 KB/s | 203:1 |     0.46% |
| `confused`        |            415 B |       780 B |  3.2 KB/s | 162:1 |     0.58% |
| `idle`            |            451 B |       988 B |  3.5 KB/s | 149:1 |     0.63% |
| `thinking`        |            488 B |     1,228 B |  3.8 KB/s | 138:1 |     0.68% |
| `dizzy`           |            730 B |       940 B |  5.7 KB/s |  92:1 |     1.01% |
| `overheated`      |            770 B |       948 B |  6.0 KB/s |  87:1 |     1.07% |
| `asleep`          |            792 B |     1,208 B |  6.2 KB/s |  85:1 |     1.10% |
| `payoff`          |            819 B |     1,680 B |  6.4 KB/s |  82:1 |     1.14% |
| `typing`          |          1,246 B |     1,324 B |  9.7 KB/s |  54:1 |     1.73% |
| `gym`             |          1,818 B |     2,052 B | 14.2 KB/s |  37:1 |     2.53% |
| `bouldering`      |          2,821 B |     3,008 B | 22.0 KB/s |  24:1 |     3.92% |

**The busiest uses 3.92% of the measured link — 26x headroom.** `bouldering`
scrolls its entire background every frame — the worst shape in the catalogue
now that `road bike`, which would have scrolled horizontally, is cut — and
costs the most both on average and by worst single frame, which is the number a
real-time link has to survive.

That margin is the answer to the obvious worry about host-rendering: it is not
close. Even if every animation were four times more expensive than the worst
one here, and the panel ran at twice the frame rate, it would still fit.

An earlier version of this section quoted ~14:1, which is upstream's figure for
their whole on-flash sprite corpus and was never a measurement of anything
here. Real pixel art on a dirty rect does far better, because a dirty rect is
mostly flat background.

The codec falls back to raw whenever RLE would be larger, so a future
photographic asset cannot quietly double a frame.

### What that measurement does not cover

**One band of four.** Those frames are the 168×200 stage in isolation. The
panel also carries a status bar, a session strip and a message band, and the
differ returns a single bounding box — so the moment a second region changes
independently, the box spans both and drags every unchanged pixel between them
onto the wire.

A clock ticking in the message band is exactly that case, and it is the one
place where the corrected link figure makes the picture worse rather than
better.

**This paragraph previously quoted a composite worst frame of roughly 24,000 B
and called it 8% of the floor. Both numbers are now unsupportable.** It was
anchored to a `bouldering` worst frame of 1,680 B, which is 3,008 B after the
animation rebuild; the floor it was a percentage of has been retired; and
nothing in the tree composites a sprite into a full panel with a ticking cell,
so the 24,000 B itself had no reproducer.

`tools/blit-scene.ts` now composites a sprite into a full panel, and its clock
ticks, so the two-band case has a driver at last — measured on `idle` in
landscape it costs mean 452 B and worst 956 B, identical to the stage-only row
above, because only the sprite changes between panels. That is not the case
this paragraph is about: it will diverge the moment the bands carry content
that changes independently of the sprite, which is what the daemon brings. A review caught all three at once.

What survives is the mechanism, which is real and unchanged: one bounding box
spanning two bands drags every unchanged pixel between them onto the wire, and
the cost of that is set by the distance between the changed regions rather than
by the sprite. It does not scale with the per-animation figures above and
cannot be derived from them.

**Measure it when the daemon first composites two bands**, and put the
reproducer in the tree at the same time. Until then this is a known unknown
rather than a budgeted cost — the stage-only figures above are sound, and they
are not the whole panel.

If it ever bites, the fix is per-band diffing or a list of rects rather than
one box. Not now: one box keeps the firmware blitter trivial and the budget is
nowhere near.

### The cost, and its mitigation

A dumb device with no host software connected shows a black screen. Firmware
therefore embeds one static RLE splash, drawn once at boot and left up until
the host paints over it. Not "whenever no host is connected": that is not
observable on this link — a Mac that has enumerated the device looks identical
whether anything is running. This is the only asset stored on the device.

That sentence used to end "and the obvious proxy for it would wipe a
legitimately still frame", which stopped being true on 6 Sep. The proxy is a
timeout on _silence_, and the _daemon_ is never silent while online — `panel.ts`
§REFRESH_MS owes a whole frame every five seconds and `daemon.ts` §paintOnce
pays it. So the panel now blanks after thirty seconds without a packet, and the
splash is exempt from it. `packages/device/src/panel.test.ts` gates the two
constants against each other, because they live in different languages.

## Package graph

```
protocol <- packs <- renderer <- daemon <- cli
protocol <- device <- daemon
protocol <- hooks
```

| Package    | Owns                                                        | May import                                |
| ---------- | ----------------------------------------------------------- | ----------------------------------------- |
| `protocol` | Wire format, RLE RGB565 codec, dirty-rect diffing           | —                                         |
| `packs`    | Pack manifest schema, palettes, quips (not a loader)        | `protocol`                                |
| `renderer` | Virtual 172×320 screen, scene graph, sprite playback, fonts | `packs`, `protocol`                       |
| `device`   | USB-CDC transport; firmware source lives here               | `protocol`                                |
| `daemon`   | Session state machine, tool→state mapping, transports       | `renderer`, `packs`, `device`, `protocol` |
| `hooks`    | The binary Claude Code executes on hook events              | `protocol`                                |
| `cli`      | `daemon <device>`, `pack`, and a bare smoke run             | everything                                |

Enforced by `eslint-plugin-boundaries`. Adding an edge means editing
`eslint.config.ts` deliberately, which is the point.

**`hooks` is deliberately near-leaf.** Claude Code runs it on every single hook
event, many times per turn. Its import graph is a latency budget. It forwards
an event over a Unix socket and exits; it does not render, does not load packs,
and does not reason about sessions.

## Transports

| Transport | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USB-CDC   | Primary     | One cable = power + data. No pairing, no Wi-Fi provisioning. Truly plug-and-play.                                                                                                                                                                                                                                                                                                                          |
| Canvas    | Development | Same renderer, browser sink. No hardware required.                                                                                                                                                                                                                                                                                                                                                         |
| TCP       | Cut, 25 Aug | Would have let a remote host push session events. Cut against the 23 Sep date — `BUILD_PLAN.md` §Stage 3 has the reasons, including that it overrides the brief. The wire framing keeps: newline-delimited JSON over many short-lived connections, transport-agnostic. The authentication does not — this socket's access model is its file mode, and the shared secret the plan named was never designed. |
| BLE       | Not planned | Upstream uses it. USB is simpler and we are tethered anyway.                                                                                                                                                                                                                                                                                                                                               |

The device sleeps when the Mac sleeps. Accepted as correct behaviour, not a
defect.

## Packs

A pack is the customisation surface: a palette, a quip table and an optional
birthday, and an optional logo. Props are planned and are not fields.

**Selection is an environment variable, then a fixed path.**
`TAMACLAUDE_PACK` names a pack directory; failing that, `~/.tamaclaude/pack/`.
Both are resolved by `packages/cli/src/pack.ts` — `packages/packs` still has no
loader and still only validates a manifest someone else read, which keeps the
trust boundary in one place.

**There is deliberately no bundled default pack.** A fallback would make the
likeliest mistake invisible: nothing sets the variable in production yet, so
forgetting it would produce a working panel carrying the example pack's generic
quips and no birthday, with nothing red anywhere. Instead every dead end is
fatal, and `tamaclaude pack` exists to answer the question no schema can — not
"is this pack valid" but "is this the right pack", which it does by printing
the resolved path, the source, and the date the birthday fires.

**The character is not per-pack.** Clawd is shared — one base geometry, one
animation set, baked to fixed RGB565 sprites that no pack alters. Making the
character swappable would double the art surface, and the calendar has no room
for a second character. `assets/clawd/base.svg` and `docs/ANIMATION.md` own the
character; a pack owns the palette, the quips, the birthday and the logo. The
logo is drawn on the laptop lid in `typing`; props are planned and not built,
so "dressed per pack" is only partly true of anything today.

`packs/example/` is committed and documents the format. Real packs are gitignored — one per person, named for
whoever the panel belongs to — because the repo is public and the personal
content is not.

Quips have two tiers: **mapped** (fired on a specific state — a failure, a
permission request) and **random idle** (surfaced rarely when nothing is
happening). Mapped quips land because the timing is the joke; randomising them
would waste them.
