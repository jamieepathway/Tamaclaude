# Hardware

## Board

**Waveshare ESP32-C6-LCD-1.47**
([wiki](https://www.waveshare.com/wiki/ESP32-C6-LCD-1.47))

| Spec    | Value                                              |
| ------- | -------------------------------------------------- |
| Display | ST7789, 172×320, 262K colour, SPI                  |
| Flash   | **8MB** (measured — see below)                     |
| RAM     | 512KB HP SRAM + 16KB LP SRAM, no PSRAM             |
| USB     | USB-C, USB 2.0 full-speed (12 Mbps ceiling)        |
| RGB LED | WS2812 on GPIO8 — present, never driven (see note) |
| Storage | microSD (TF) slot — unused, we render on the host  |
| Radio   | Wi-Fi 6 + BLE 5 — unused                           |

**The RGB LED is never driven, and the evidence is here rather than a hop
away.** `packages/device/firmware/blitter/main/main.c` declares six pins —
MOSI 6, SCLK 7, CS 14, DC 15, RST 21, BL 22 — and GPIO8 is not among them.
Neither firmware requests `driver/rmt` or an LED-strip component, and there is
no `idf_component.yml` in the tree, so nothing is pulled in as a managed
component either. It is on the board and it will ship dark.

A previous version of this line said only "see below" and put nothing below,
while the commit that wrote it claimed the evidence had been moved here. It had
not been; half of it had been deleted.

> ⚠️ **Upstream's README disagreed with Waveshare, and upstream was right.**
> clawd-tank's README claimed ESP32-C6FH8 with 8MB; the Waveshare wiki for this
> SKU says 4MB. Measured on the actual board: 8MB. The wiki is wrong, at least
> for the unit that arrived. It matters little either way — we store only the
> splash on-device — but the doubled headroom removes any question about it.

**Verified flash size: 8MB.** Measured 20 Aug 2026 on the board itself:

```
Chip is ESP32-C6FH8 (QFN32) (revision v0.2)
Features: Wi-Fi 6, BT 5 (LE), IEEE802.15.4, Single Core + LP Core, 160MHz,
          Embedded Flash 8MB
Crystal is 40MHz
USB mode: USB-Serial/JTAG
Manufacturer: 20  Device: 4017  Detected flash size: 8MB
```

Reproduce with the board plugged in and ESP-IDF sourced:

```bash
esptool.py --port /dev/cu.usbmodem1101 flash_id
```

**`USB mode: USB-Serial/JTAG` is the line that matters most.** It confirms the
chip's native USB peripheral is what enumerates, rather than a separate
USB-to-UART bridge. `docs/ARCHITECTURE.md` rests the whole host-renders design
on USB-CDC at full speed; a bridge chip would have capped us at a UART baud
rate instead, and that would have been found out at Stage 2 rather than now.

## Bring-up checklist

1. ~~Flash Waveshare's factory demo.~~ **Do not.** It was written to answer
   the flash question and confirm the board — the first is answered above, and
   flashing the blitter confirms the board through the code that ships. Its
   other half exercised the WS2812, which nothing in either firmware drives:
   `blitter/main/main.c` declares six pins and GPIO8 is not among them. See
   §Firmware below, which has said "we did not need Waveshare's demo after
   all" since 21 Aug while this step went on instructing it.
   **A board that has never been flashed is a different case**, and there the
   demo it arrives with is worth one minute before you overwrite it — that is
   a precondition of Stage 6's gift-board flash, not a step here.
2. ~~Record the measured flash size above.~~ Done: 8MB, 20 Aug.
3. Measure the board's physical dimensions before ordering a print. **Mostly
   answered without a ruler**, and what is left is one number — see
   §Dimensions below.

## Firmware

Lives in `packages/device/firmware/`. ESP-IDF, C.

Two of them:

- `throughput/` — 83 lines that read USB-CDC and discard, written to measure
  the link and nothing else (`docs/ARCHITECTURE.md` §Why it fits down the wire).
- `blitter/` — the real one. It does exactly four things:
  1. Read framed commands from USB-CDC
  2. Decode RLE RGB565 and blit the rectangle to SPI
  3. Show an embedded splash when nothing has ever driven the panel
  4. Drop the backlight after `IDLE_BLANK_MS` of silence, and raise it on the
     next blitted rect

"Three" until 6 Sep, when the fourth landed. The rule below is why the count is
worth keeping honest: each addition is a thing that cannot be changed without
physical access to the board.

It is flashed once. If a change to it seems necessary, that is a strong signal
the change belongs on the host instead — and the idle blank was weighed against
that test rather than waved past it. The host half (stop sending) is easy; the
half only firmware can do is the backlight GPIO, which no protocol message
reaches, so a host that crashes rather than exits cleanly cannot darken the
panel by itself.

**We did not need Waveshare's demo after all.** This section used to insist on
starting from it, so as not to re-derive the ST7789 init sequence by hand — the
classic place to lose a day. ESP-IDF's own `esp_lcd` component has an ST7789
driver, so there is no init sequence to derive. What was actually needed from
upstream clawd-tank was the pin map, which is six numbers, and one insight
about the column offset (below). The factory image is backed up regardless.

### Orientation

`PANEL_LANDSCAPE` in `blitter/main/main.c` is a build-time constant, because
the firmware is flashed once and which way up the device sits is a physical
fact. **The host must agree** — `tools/blit.ts` takes a matching argument, and
there is no handshake, so a mismatch is silent: the sprite lands in the wrong
band and nothing warns you. Both default to landscape.

Landscape is not a rotated portrait layout. The bands are rearranged — Clawd on
the left at 168x160, the text stacked down the right — because 200px of stage
does not fit in 172px of height. The host crops the sprite to the safe area,
which is what the top 5 units of prop headroom in `docs/ANIMATION.md` exist for.

**The 34-pixel offset is the expensive thing to get wrong.** The 172-wide
window sits centred in the controller's 240-pixel RAM, so 34 columns of its
memory are dead. Which axis they land on depends on `swap_xy`: with it on,
CASET addresses rows and the offset belongs on `y_gap`; with it off, on
`x_gap`. Upstream's landscape code says exactly this in a comment, and it is
inverted for portrait. Getting it wrong gives a display that looks almost right
and is shifted.

### Colours

The blitter byte-swaps every pixel on the way to the panel, because the ST7789
latches big-endian under `esp_lcd`'s default RAMCTRL, and `invert_color(true)`
is required or every colour comes out as its complement. **Both are verified**
with `tools/colour-bars.ts`, which paints six known values across the panel.

That tool exists because a wrong byte order and a wrong invert and a wrong
element order all look like "the colours are off", and each maps that set of
six somewhere distinguishable — so one look identifies which is in play. Reach
for it before theorising. Photographs are not evidence here: a warm-lit room
makes a camera white-balance a neutral panel to blue, which cost an evening of
chasing a colour bug that did not exist.

## Enclosure

Community STLs exist for this exact SKU — no modelling required:

- [Printables — ESP32-C6 1.47inch Display Enclosure](https://www.printables.com/model/1365867-esp32-c6-147inch-display-enclosure)
  — snap-on lid, needs supports for the USB-C hole
- [Cults3D — Enclosure (edge) SDLw01 28563](https://cults3d.com/en/3d-model/gadget/enclosure-edge-for-waveshare-esp32-c6-1-47-rectangle-lcd-sdlw01-28563)
  — claims physically-verified 0.3mm tolerance, M2 screws

**Chosen model:** _TBD — record the model and its licence here once picked, for
`CREDITS.md`._

**Overdue while `BUILD_PLAN.md`'s "Measure board; send chosen STL to the
printer" is still `[ ]`.** Bound to that box and to a date together, because
overdue needs both: the box gives "open", the passed date gives "overdue". The
date is that item's own mitigation, "brief the printer Thu 20 Aug".

`[ ]` rather than "unchecked", deliberately. The likeliest end for this item is
the one the next paragraph argues for — take the bare board — and a cancelled
item goes to `[~]`, which is also unchecked. Bound to "unchecked" this file
would go on calling the case overdue after the project had decided not to have
one.

What makes it different from the other open items is narrower than it first
looks, and the plan is worth reading before this is escalated. It is **not** the
project's largest risk: the same risk row accepts a bare board as the fallback,
and the always-giftable rule means a present is handed over either way — though
that rule is written about art slippage, "with placeholder art if necessary",
so an enclosure is its general clause rather than its subject. Nor is
it the only item with an unbounded tail — the clean-account dry run's bad
branch is "a packaging project rather than a bug fix" in the plan's own words,
and the gift-board flash is a rebuild against a toolchain last exercised in
August.

**Nor is it the only item depending on somebody else's calendar, and this
paragraph said it was for a day.** That claim was falsified by the item named
in the sentence above it: the clean-account dry run's exit criterion is
"somebody who is not the author, on an account that is not the author's" and a
_second_ pass with no fixes and no talking — two appointments with a person who
is not the author. The board the flash needs is a supplier's calendar as well.
A correction that reproduces the error it corrects, one step narrower, is the
thing this file has now done twice; it is recorded rather than quietly fixed
because the next one will look just as reasonable.

What is left is smaller and still worth acting on: this item has a **fallback
that has to be chosen rather than arrived at.** Assembly is scheduled for Sat
19 Sep, so the go/no-go on the bare board belongs meaningfully earlier than
that — and unlike a slipped build, nobody finds out it was needed by working
harder the week before.

## Dimensions

**36.37 x 20.32 mm, not including the USB port.** Quoted verbatim from
[CNX Software's write-up of the board][cnx], checked 1 Sep 2026 against the
article itself rather than a search summary. Waveshare's own wiki and docs
platform both publish the figure only as an image, and both refuse automated
fetching, so this is the best sourced number available without measuring.

[cnx]: https://www.cnx-software.com/2024/09/24/esp32-c6-wifi-6-and-bluetooth-5-0-usb-c-development-board-integrates-1-47-inch-tft-lcd-display/

**The two the spec does not give were measured on 1 Sep**, by the owner, with a
ruler rather than calipers — so they are approximate and stated as such:

- **Thickness: about 10 mm.** Unpublished anywhere found. It is what decides an
  enclosure's internal clearance and a box's depth.
- **Length including the USB-C connector: about 37 mm.** The spec's 36.37 mm
  excludes the connector, which sits on a short edge, so anything the board fits
  inside needs this number rather than that one.

**So, working figures: 37 x 20.3 x 10 mm.** Two measured to the nearest
millimetre and one sourced to two decimal places, which is a false precision
worth noticing — round the lot to 37 x 21 x 10 before cutting anything, and
re-measure with calipers if a tolerance below a millimetre ever matters.

**For scale, the box it shipped in is 70 x 50 x 16 mm**, also measured on
1 Sep. That is 33 mm of spare length, 30 mm of width and 6 mm of depth around
the board, which is a useful reference point for anything built to hold it.

Recorded here because it was an open checklist item since 20 Aug, and because a
sourced figure a reader can check beats a measurement nobody wrote down.

## Rebuilding the firmware, when the toolchain has rotted

The blitter is flashed once and never touched, which means the toolchain is
cold every time anybody needs it. On 2 Sep a rebuild took four fixes before
`idf.py build` would run at all, on a machine where ESP-IDF v5.3.2 and the
RISC-V toolchain were both already installed. In order:

1. **The Python environment did not exist.**
   `python3 $IDF_PATH/tools/idf_tools.py install-python-env`
2. **`pyclang` could not import `ruamel.yaml`.** The installer pulls 0.19,
   whose API it does not accept: `pip install "ruamel.yaml<0.18"`.
3. **`ruamel.yaml.clib` was then missing** — 0.17 needs the C extension that
   0.19 had made unnecessary: `pip install ruamel.yaml.clib`.
4. **ESP-IDF still could not see it.** Modern pip writes
   `ruamel_yaml_clib-*.dist-info`; the v5.3 dependency checker looks for the
   dotted `ruamel.yaml.clib`. The error names `ruamel.yaml.clib` as missing
   whatever requirement it happens to be checking, which is what makes it hard
   to read. Fixed by copying the dist-info to the dotted name and setting
   `Name:` in its METADATA to match.

**That fourth fix is gone, along with the rest of the install, and a rebuild
from nothing on 6 Sep needed none of the four.** `~/esp` and `~/.espressif` had
both disappeared by then. What worked, start to finish in about twenty minutes:

```bash
git clone -b v5.3.2 --depth 1 --recursive --shallow-submodules \
  https://github.com/espressif/esp-idf.git ~/esp/esp-idf
~/esp/esp-idf/install.sh esp32c6
brew install cmake ninja          # the step nothing tells you about
. ~/esp/esp-idf/export.sh
cd packages/device/firmware/blitter && idf.py set-target esp32c6 && idf.py build
```

Two things that cost time and are not in Espressif's instructions. **`cmake` and
`ninja` are not installed by `install.sh` on macOS** — it installs the RISC-V
toolchain and expects those from Homebrew, and the failure is a bare "cmake must
be available on the PATH". And **`set-target` must run after cmake exists**: a
`set-target` that failed for want of cmake leaves a build directory configured
for the default Xtensa target, and the next build asks for
`xtensa-esp32-elf-gcc` on a RISC-V part. `rm -rf build sdkconfig` and redo it.

So the four fixes above were symptoms of an install that had rotted in place,
not of this toolchain. A fresh one skips them. Keep the list for the next
rotted install; do not start from it.

Then `idf.py fullclean` before building: a build directory left from an earlier
Python refuses to configure against a new one, and says so clearly.

## Spares

Buy two boards. One to develop and reflash against, one to give. Replacement
lead time is roughly a week, and September has no week to spare.
