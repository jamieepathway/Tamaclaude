/*
 * The blitter. Everything this board does.
 *
 * The Mac renders every frame; this firmware only receives rectangles and puts
 * them on the panel. It reads a 16-byte header and its payload from
 * USB-Serial/JTAG, decodes RLE or raw RGB565 into one framebuffer, and hands
 * that framebuffer to the ST7789 over SPI. The one exception is the boot
 * splash below, which the board has to draw itself because it comes up before
 * any host — beyond that there is no drawing code and no state worth keeping.
 * `docs/HARDWARE.md` says this is flashed once and never changes, and that
 * only holds if it stays this dumb.
 *
 * The wire format is `packages/protocol/src/packet.ts` and
 * `packages/protocol/src/rle.ts`. Read those; this file is the other half of
 * that contract and cannot be changed alone.
 *
 * The stream has no sync word, which is the one thing that makes this harder
 * than a memcpy. A reader that starts mid-stream — after a reset, or on
 * plug-in while the host is already sending — will read pixel data as a
 * header, believe in a payload length that was never a length, and either
 * stall or paint noise. So no header is acted on until it has been proved:
 * bounds, mode, and a payload length that agrees with the mode and the
 * rectangle's area. A header that fails is not a header, so we discard one
 * byte and try the next offset. That is slow by design and only ever runs
 * while we are lost.
 *
 * Pixels arrive little-endian, because that is what the host writes and what
 * the C6 reads natively. The panel latches big-endian, because that is the
 * RAMCTRL default the esp_lcd driver ships and the setting every working
 * ST7789 project on this board uses. So the decoder byte-swaps as it writes.
 * The ST7789 does have a RAMCTRL bit to make it little-endian instead — the
 * driver exposes it as `data_endian` — and using it would save the swap on the
 * raw path, but its behaviour over an SPI interface is not something we can
 * confirm without the board in hand, and a wrong guess there looks exactly
 * like a colour-order bug. The swap always works.
 *
 * Nothing is logged. Both console channels are off, deliberately (see
 * sdkconfig.defaults), so the only way to see inside is the short `#` lines
 * this writes back up the same pipe. They are out-of-band, rate-limited, and
 * safe for a host that never reads them.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/usb_serial_jtag.h"
#include "esp_err.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "splash-data.h"

/*
 * Pin map and panel quirks are upstream clawd-tank's `firmware/main/display.c`
 * (MIT, credited in CREDITS.md), which targets this exact board.
 */
#define PIN_MOSI 6
#define PIN_SCLK 7
#define PIN_CS 14
#define PIN_DC 15
#define PIN_RST 21
#define PIN_BL 22
#define LCD_HOST SPI2_HOST

/*
 * Which way up the device sits on the desk.
 *
 * A build-time constant rather than a runtime one, because the firmware is
 * flashed once and the orientation is a physical fact about where the thing
 * lives. It is not free to change: the host must agree, and `tools/blit.ts`
 * takes a matching flag. If the two disagree the sprite lands in the wrong
 * band and nothing warns you.
 *
 * Landscape is the default because it is how the device is meant to sit —
 * Clawd on the left, the text bands stacked down the right, which is also what
 * upstream clawd-tank does.
 *
 * Setting this to 0 no longer gives a portrait build on its own. The splash is
 * baked at the panel's landscape geometry and the `_Static_assert` below the
 * splash refuses to compile against the other one, deliberately — a portrait
 * device needs portrait artwork, not the same picture stretched. Re-compose
 * `assets/clawd/splash.svg` and re-bake before flipping this.
 */
#define PANEL_LANDSCAPE 1

/*
 * The panel's native geometry, mirroring SCREEN_WIDTH/SCREEN_HEIGHT in
 * `packages/protocol/src/screen.ts` — the one duplication the language barrier
 * forces. If they ever disagree, the TypeScript is right and this is a bug.
 *
 * Landscape swaps them, exactly as `panelSize()` does in
 * `packages/renderer/src/layout.ts`. Note that landscape is not a rotated
 * portrait layout: the bands are rearranged, because 200px of stage does not
 * fit in 172px of height. That is the host's problem, but it is why the two
 * orientations are not interchangeable.
 */
#define PANEL_NATIVE_WIDTH 172
#define PANEL_NATIVE_HEIGHT 320
#if PANEL_LANDSCAPE
#define SCREEN_WIDTH PANEL_NATIVE_HEIGHT
#define SCREEN_HEIGHT PANEL_NATIVE_WIDTH
#else
#define SCREEN_WIDTH PANEL_NATIVE_WIDTH
#define SCREEN_HEIGHT PANEL_NATIVE_HEIGHT
#endif
#define SCREEN_PIXELS (SCREEN_WIDTH * SCREEN_HEIGHT)

/*
 * The 172-wide window sits centred in the controller's 240-pixel RAM, so 34
 * columns of its memory are dead.
 *
 * Which axis they land on depends on swap_xy, and this is the expensive thing
 * to get wrong — the wrong axis gives a display that looks almost right and is
 * shifted. With swap_xy on, CASET addresses rows and the offset belongs on
 * y_gap; upstream's landscape code says exactly that in a comment. With it
 * off, the same 34 pixels belong on x_gap.
 */
#if PANEL_LANDSCAPE
#define PANEL_SWAP_XY true
#define PANEL_X_GAP 0
#define PANEL_Y_GAP 34
/* Upstream's proven landscape MADCTL is MV|MX, i.e. swap_xy with mirror_x. */
#define PANEL_MIRROR_X true
#define PANEL_MIRROR_Y false
#else
#define PANEL_SWAP_XY false
#define PANEL_X_GAP 34
#define PANEL_Y_GAP 0
/* Unverified: dropping MV from upstream's MV|MX leaves MX's portrait value
 * undecidable from their code, because it was doing two jobs there. If a
 * portrait build comes up rotated 180 degrees, make both of these true. */
#define PANEL_MIRROR_X false
#define PANEL_MIRROR_Y false
#endif

/*
 * 40MHz. The ST7789 is specified for faster and this board is routed short,
 * but a full-screen raw update is 110KB — 22ms at this clock — and the wire
 * takes 196ms to deliver it. SPI is not the bottleneck at any plausible clock,
 * so there is nothing to buy by pushing it and signal integrity to lose.
 */
#define LCD_PCLK_HZ (40 * 1000 * 1000)

/* Wire encodings, from packages/protocol/src/rle.ts. */
#define MODE_RAW 0
#define MODE_RLE 1

#define RECT_HEADER_BYTES 16

/*
 * One USB read. 64 full-speed packets' worth, the same figure the throughput
 * spike measured 562.5 KB/s with, so per-call overhead is not what limits us.
 */
#define RX_CHUNK 4096

/*
 * The driver's receive ring, which is a different thing from the read size
 * above and must be much larger.
 *
 * This device is deaf for the whole of a blit. A full-screen transfer is
 * 110,080 bytes, and at the measured 562.5 KB/s the host can hand us 12.4 KB
 * while it runs. IDF's receive ISR drains the hardware FIFO and then calls
 * xRingbufferSendFromISR *without checking its return* — so once the ring is
 * full the bytes are simply dropped, and because the FIFO was already emptied
 * the peripheral keeps ACKing and the host is never told. A short payload
 * would be silently truncated with no error anywhere.
 *
 * A 4KB ring survives today only because the frames we happen to prime with
 * compress to 1.2-1.6KB. A less compressible frame, or a raw-mode prime at
 * 67KB, loses bytes mid-packet. 32KB is 2.5x the worst case and the chip has
 * ~270KB spare.
 */
#define RX_RING_BYTES (32 * 1024)

/*
 * How long to wait for the rest of a packet before giving up on it. A header
 * that passed validation can still have been noise, in which case its payload
 * will never arrive; and a host that dies mid-write leaves us waiting on bytes
 * that no longer exist. Both look the same from here and both want the same
 * answer: abandon the packet, resync, do not paint. Generous enough that a
 * scheduling hiccup on the Mac is not mistaken for either.
 */
#define PACKET_TIMEOUT_MS 1000

/* How long to block hunting for a header before surfacing counters. */
#define HUNT_SLICE_MS 1000

/* Floor on the interval between status lines, so a garbage stream cannot make
 * us spend the link talking about it. */
#define REPORT_INTERVAL_MS 1000

/*
 * How long a silent line means the host has gone, and the backlight goes off.
 *
 * **The comment in `app_main` used to argue this could not be done**, on the
 * grounds that "the closest proxy, an idle timeout, would wipe the screen
 * during any long still frame. A crab asleep is a legitimate picture." The
 * objection was right about what would break it and wrong that it applies:
 * there is no long still frame on this wire. Three links, and the first draft
 * of this comment named the wrong file for one of them:
 *
 *   - `packages/device/src/panel.ts:52` sets `REFRESH_MS = 5000` and fires
 *     `afterRefresh` on that interval.
 *   - `packages/device/src/link.ts` §afterRefresh marks `needsPrime`. It marks
 *     a debt; it writes nothing.
 *   - `packages/cli/src/daemon.ts:716` is what pays it — `status.needsPrime ?
 *     whole : changed(...)` — inside §painting, which re-arms every `FRAME_MS`
 *     (125ms) for the life of the process.
 *
 * A sleeping crab is therefore repainted in full twelve times a minute.
 * Silence on this link does not mean a still picture; it means nothing is
 * driving the panel at all.
 *
 * Precisely: silence *while online*. `daemon.ts:657` returns early when the
 * phase is not `online`, which is correct — a host that is not online is not
 * driving anything — but it is why this is stated as a chain rather than a
 * guarantee. `packages/device/src/panel.test.ts` gates the arithmetic so a
 * change to `REFRESH_MS` cannot silently blank a live panel.
 *
 * Thirty seconds is six times the interval that has to lapse, so it takes six
 * consecutive missed refreshes to blank. `await_header` already wakes every
 * `HUNT_SLICE_MS` on a quiet line, so the check costs one comparison a second
 * and no new timer.
 *
 * What this buys is not only the brightness. A panel whose host has stopped
 * used to hold its last frame indefinitely — a stale picture that reads as a
 * live one, which is the failure industrial HMIs blank the screen to avoid.
 */
#define IDLE_BLANK_MS 30000

/* ---------------------------------------------------------------- buffers */

/*
 * Buffer strategy: one framebuffer, sized for the largest rectangle we accept,
 * and nothing else.
 *
 * The largest legal rectangle is the whole screen, so this is 172*320*2 =
 * 110,080 bytes of the C6's 512KB, allocated once in .bss. There is no PSRAM
 * and no malloc anywhere in the frame path — a per-frame allocation on a part
 * with no MMU is a fragmentation bomb that goes off after an hour of animation
 * rather than at boot, which is the worst time to find it.
 *
 * The compressed payload is never buffered at all. It is consumed straight out
 * of the USB read buffer and decoded into the framebuffer as it arrives, which
 * is what keeps the worst case at 110KB: an RLE payload can legally be twice
 * the size of the raw pixels it describes (four bytes per run, one run per
 * pixel), so staging it whole would need 220KB more for the pathological case
 * of a rectangle that does not compress.
 *
 * Aligned to 4 for the SPI DMA engine, which wants word-aligned source
 * buffers; a uint16_t array would otherwise only be aligned to 2.
 */
static uint16_t framebuffer[SCREEN_PIXELS] __attribute__((aligned(4)));

/* The USB read buffer, and how far into it we have got. */
static uint8_t rx[RX_CHUNK];
static size_t rx_len;
static size_t rx_pos;

/* --------------------------------------------------------------- counters */

static uint32_t stat_rects;    /* rectangles blitted */
static uint32_t stat_resyncs;  /* episodes of being lost */
static uint32_t stat_dropped;  /* bytes discarded while lost */
static uint32_t stat_aborted;  /* packets abandoned mid-payload */

/* --------------------------------------------------------------- backlight */

/* When the host was last heard from, and whether the panel is lit. Both are
 * zero-initialised, which is the correct start: nothing heard, nothing lit. */
static uint32_t last_traffic_ms;
static bool backlight_lit;

/* Milliseconds since boot, wrapping at 49 days. Unsigned subtraction against
 * it stays correct across the wrap, which is why every comparison here is
 * written `now - then < limit` rather than `now < then + limit`. */
static uint32_t now_ms(void) {
  return (uint32_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
}

/* Idempotent, so callers can assert the state they want on every packet
 * without a GPIO write per frame. */
static void backlight_set(bool lit) {
  if (lit == backlight_lit) return;
  ESP_ERROR_CHECK(gpio_set_level(PIN_BL, lit ? 1 : 0));
  backlight_lit = lit;
}

/*
 * Blank a panel whose host has stopped talking. See `IDLE_BLANK_MS`.
 *
 * `stat_rects == 0` is the guard that keeps the splash's meaning intact. A
 * panel nothing has ever driven keeps its splash however long it waits,
 * because that picture is the diagnostic — `app_main` records the rule: "the
 * splash means nothing has ever driven this panel, and a dark panel still
 * means a fault". Blanking on a timer would collapse those two into one. Only
 * a panel that has been driven and then abandoned goes dark.
 */
static void idle_check(void) {
  if (stat_rects == 0 || !backlight_lit) return;
  if (now_ms() - last_traffic_ms < IDLE_BLANK_MS) return;
  backlight_set(false);
}

/* ------------------------------------------------------------------- panel */

static esp_lcd_panel_handle_t panel;
static SemaphoreHandle_t blit_done;

/*
 * esp_lcd_panel_draw_bitmap queues the colour transfer and returns before it
 * has left the chip, so the framebuffer is still in flight when we get control
 * back. Decoding the next rectangle into it at that point would tear the one
 * being sent. This callback fires from the SPI ISR on the final chunk; the
 * blit loop waits on it, which makes the draw synchronous and the single
 * framebuffer safe to reuse.
 */
static bool on_blit_done(esp_lcd_panel_io_handle_t io,
                         esp_lcd_panel_io_event_data_t *event,
                         void *context) {
  (void)io;
  (void)event;
  (void)context;
  BaseType_t woken = pdFALSE;
  xSemaphoreGiveFromISR(blit_done, &woken);
  return woken == pdTRUE;
}

static void panel_start(void) {
  /*
   * Backlight off until there is something deliberate on the panel. The
   * controller's RAM holds whatever it held at power-on, and lighting that up
   * for the half-second the SPI bring-up takes is a flash of noise every
   * single boot.
   */
  gpio_config_t backlight = {
      .pin_bit_mask = 1ULL << PIN_BL,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  ESP_ERROR_CHECK(gpio_config(&backlight));
  /* Not `backlight_set(false)`. That helper is idempotent against
   * `backlight_lit`, which is already false here, so it would return without
   * ever driving the pin — and the whole point of this line is to drive it
   * explicitly before the SPI bring-up. The tidy-up is tempting and would pass
   * on the bench, because the output register happens to reset to 0. */
  ESP_ERROR_CHECK(gpio_set_level(PIN_BL, 0));

  spi_bus_config_t bus = {
      .sclk_io_num = PIN_SCLK,
      .mosi_io_num = PIN_MOSI,
      .miso_io_num = -1,
      .quadwp_io_num = -1,
      .quadhd_io_num = -1,
      /* The panel IO splits anything larger into chunks of this size, so it is
       * a DMA descriptor budget rather than a limit. One screen's worth means
       * a full-screen blit goes out as a single transaction. */
      .max_transfer_sz = SCREEN_PIXELS * 2,
  };
  ESP_ERROR_CHECK(spi_bus_initialize(LCD_HOST, &bus, SPI_DMA_CH_AUTO));

  esp_lcd_panel_io_handle_t io = NULL;
  esp_lcd_panel_io_spi_config_t io_config = {
      .cs_gpio_num = PIN_CS,
      .dc_gpio_num = PIN_DC,
      .spi_mode = 0,
      .pclk_hz = LCD_PCLK_HZ,
      .trans_queue_depth = 10,
      .on_color_trans_done = on_blit_done,
      .user_ctx = NULL,
      .lcd_cmd_bits = 8,
      .lcd_param_bits = 8,
  };
  ESP_ERROR_CHECK(
      esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_config, &io));

  /*
   * esp_lcd's ST7789 driver rather than a hand-rolled init sequence.
   * docs/HARDWARE.md says to start from Waveshare's demo to avoid re-deriving
   * the init; not having to derive it at all is better still.
   */
  esp_lcd_panel_dev_config_t panel_config = {
      .reset_gpio_num = PIN_RST,
      .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
      .bits_per_pixel = 16,
  };
  ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &panel_config, &panel));

  ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
  ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
  /* Required on this panel: it is wired such that without INVON every colour
   * comes out as its complement. Upstream does the same. */
  ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, true));
  ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(panel, PANEL_SWAP_XY));
  ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel, PANEL_MIRROR_X, PANEL_MIRROR_Y));
  ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, PANEL_X_GAP, PANEL_Y_GAP));
  /* The driver's init leaves the display off. */
  ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
}

/*
 * Blit the framebuffer's first width*height pixels and wait for the wire.
 *
 * Bounded, unlike the obvious `portMAX_DELAY`. Every other wait in this file
 * has a deadline and a reason; this one is the last transfer of a full screen,
 * 110KB at 40MHz, so 22ms is the honest figure and a second is twenty-five
 * times that. If the completion callback is ever missed the alternative is
 * worse than a reboot: app_main blocks forever, the idle task keeps feeding
 * the watchdog so nothing resets, the device stays enumerated but stops
 * draining USB, and the host blocks inside its own write with no timeout.
 * Both ends frozen, panel holding a stale frame, no output anywhere. A visible
 * restart is a much better failure than an invisible hang on a device that is
 * meant to sit on a desk unattended.
 */
#define BLIT_TIMEOUT_MS 1000

static void blit(uint16_t x, uint16_t y, uint16_t width, uint16_t height) {
  /* draw_bitmap takes exclusive end coordinates. */
  ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, x, y, x + width, y + height,
                                            framebuffer));
  if (xSemaphoreTake(blit_done, pdMS_TO_TICKS(BLIT_TIMEOUT_MS)) != pdTRUE) {
    esp_restart();
  }
}

/* ------------------------------------------------------------------ pixels */

/* Pack 8-bit RGB the way packages/protocol/src/colour.ts does. */
#define RGB565(r, g, b)                                              \
  ((uint16_t)((((r) & 0xf8) << 8) | (((g) & 0xfc) << 3) | (((b) & 0xf8) >> 3)))

/* Host order to panel order. See the note at the top of the file. */
static inline uint16_t panel_word(uint16_t rgb565) {
  return (uint16_t)__builtin_bswap16(rgb565);
}

static void fill(size_t from, size_t count, uint16_t word) {
  for (size_t i = 0; i < count; i++) framebuffer[from + i] = word;
}

/* ------------------------------------------------------------------ splash */

/*
 * A dark screen has to mean a fault, so the panel is never left showing
 * nothing. This is the one picture the device draws by itself: everything else
 * on this panel is rendered on the Mac and blitted, so the splash is the only
 * art that has to survive with no host attached.
 *
 * It is `assets/clawd/splash.svg`, baked by `pnpm bake:splash` into the table
 * beside this file. The payload encoding is the wire's own — (count, value)
 * pairs with `value` in host RGB565 order — so this decodes with the same two
 * calls `decode_rle()` makes, and a byte-order mistake here would be the same
 * mistake there rather than a new one. It does not travel over USB, so it has
 * no rect header and never meets `parse_header()`.
 *
 * What replaced the placeholder, and what was lost with it. The old fill drew
 * a two-pixel border and a corner marker, to prove the gap landed on the right
 * axis and to pin down the mirror settings. The artwork proves the second far
 * better — a mirrored or rotated wordmark is unmistakable, where a corner
 * square only ever said "one of these four corners". It does not prove the
 * first: every edge of this splash is flat ground, so a gap on the wrong axis
 * would show only as the uncovered band of power-on RAM. That diagnostic was
 * spent once and is gone, which is the right trade for art that ships, but it
 * is a trade rather than a free upgrade.
 *
 * The clamp is not ceremony. `fill()` has no bounds check, `count` is a
 * uint16_t, and a table that overran would write up to 65,535 words past the
 * end of a 55,040-word framebuffer and corrupt whatever `.bss` follows it, on
 * a device meant to sit on a desk unattended. `decode_rle()` refuses the
 * packet outright in that position; refusing is wrong here, because a splash
 * that declines to draw is the blank screen this whole function exists to
 * prevent. So it draws what fits and stops. `tools/bake-splash.test.ts` is
 * what makes the clamp unreachable in practice, by asserting the committed
 * table sums to exactly SPLASH_PIXELS — the firmware is in none of the six
 * gates, so that test and the assertion below are the only automated things
 * standing behind this file.
 */
_Static_assert(SPLASH_WIDTH == SCREEN_WIDTH && SPLASH_HEIGHT == SCREEN_HEIGHT,
               "the baked splash is not the size of the panel");

static void draw_splash(void) {
  size_t written = 0;
  for (size_t run = 0; run < SPLASH_RUNS; run++) {
    size_t count = splash_rle[run * 2];
    if (count > SPLASH_PIXELS - written) count = SPLASH_PIXELS - written;
    if (count == 0) continue;
    fill(written, count, panel_word(splash_rle[run * 2 + 1]));
    written += count;
  }
  blit(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
}

/* ------------------------------------------------------------------ stream */

/* Make sure the read buffer has something in it. Returns bytes available. */
static size_t stream_fill(TickType_t wait) {
  if (rx_pos == rx_len) {
    int read = usb_serial_jtag_read_bytes(rx, RX_CHUNK, wait);
    rx_pos = 0;
    rx_len = read > 0 ? (size_t)read : 0;
    /* The one place bytes enter from the host, so the one place liveness is
     * observable. Deliberately any byte rather than any valid packet: a host
     * sending garbage is still a host, and a dark panel is the wrong way to
     * report a protocol fault when the counters already do it. */
    if (read > 0) last_traffic_ms = now_ms();
  }
  return rx_len - rx_pos;
}

/*
 * Take exactly `count` bytes. False means the stream went quiet for longer
 * than `wait` with bytes still owing, which is only ever a fault: the caller
 * abandons whatever it was assembling.
 */
static bool stream_take(void *destination, size_t count, TickType_t wait) {
  uint8_t *out = destination;
  while (count > 0) {
    size_t available = stream_fill(wait);
    if (available == 0) return false;
    size_t take = available < count ? available : count;
    memcpy(out, rx + rx_pos, take);
    rx_pos += take;
    out += take;
    count -= take;
  }
  return true;
}

/* ------------------------------------------------------------------ report */

/*
 * Status, out of band. The protocol has no device-to-host direction, so these
 * lines are prefixed with '#' — trivially filtered by a host that grows a
 * reader, harmless to one that never reads. Written with a short timeout and
 * an ignored result: if nobody is draining the endpoint the line is dropped
 * rather than allowed to stall the blitter.
 */
static uint32_t last_report_ms;
static uint32_t reported_rects;
static uint32_t reported_resyncs;
static uint32_t reported_dropped;
static uint32_t reported_aborted;

static void report(void) {
  if (stat_rects == reported_rects && stat_resyncs == reported_resyncs &&
      stat_dropped == reported_dropped && stat_aborted == reported_aborted) {
    return;
  }

  /* Unsigned subtraction, so the tick counter's wrap at 49 days costs one
   * early report rather than 49 days of silence. */
  uint32_t now = now_ms();
  if (now - last_report_ms < REPORT_INTERVAL_MS) return;
  last_report_ms = now;
  reported_rects = stat_rects;
  reported_resyncs = stat_resyncs;
  reported_dropped = stat_dropped;
  reported_aborted = stat_aborted;

  /*
   * The orientation is on this line because it is the one thing the host has
   * no way to work out. It is a build-time constant here and an argument
   * there, with no handshake between them, so a mismatch used to be silent:
   * every packet fails the bounds check, stat_rects stays at zero forever, and
   * the sender re-primes into the void with nothing to say why. The host
   * compares this against its own and refuses to start if they differ.
   */
  char line[96];
  int length = snprintf(line, sizeof line,
                        "# rects %lu resync %lu/%lu abort %lu panel %ux%u %s\n",
                        (unsigned long)stat_rects, (unsigned long)stat_resyncs,
                        (unsigned long)stat_dropped, (unsigned long)stat_aborted,
                        (unsigned)SCREEN_WIDTH, (unsigned)SCREEN_HEIGHT,
                        PANEL_LANDSCAPE ? "landscape" : "portrait");
  usb_serial_jtag_write_bytes(line, (size_t)length, pdMS_TO_TICKS(10));
}

/* ------------------------------------------------------------------ header */

typedef struct {
  uint16_t x;
  uint16_t y;
  uint16_t width;
  uint16_t height;
  uint32_t length;
  uint16_t mode;
  uint32_t pixels;
} rect_header_t;

static inline uint16_t read16(const uint8_t *bytes, size_t offset) {
  return (uint16_t)(bytes[offset] | ((uint16_t)bytes[offset + 1] << 8));
}

static inline uint32_t read32(const uint8_t *bytes, size_t offset) {
  return (uint32_t)bytes[offset] | ((uint32_t)bytes[offset + 1] << 8) |
         ((uint32_t)bytes[offset + 2] << 16) | ((uint32_t)bytes[offset + 3] << 24);
}

/*
 * Is this sixteen bytes a header, or is it pixel data we happen to be standing
 * on? Everything checkable is checked, because the discrimination is the whole
 * defence: about forty bits of the sixteen are constrained, so the odds of
 * arbitrary pixel data locking us onto a false header are small, and a false
 * lock costs at most one abandoned packet.
 */
static bool parse_header(const uint8_t *bytes, rect_header_t *out) {
  uint16_t x = read16(bytes, 0);
  uint16_t y = read16(bytes, 2);
  uint16_t width = read16(bytes, 4);
  uint16_t height = read16(bytes, 6);
  uint32_t length = read32(bytes, 8);
  uint16_t mode = read16(bytes, 12);

  /* The host never writes the reserved halfword, so it is always zero. Two
   * free bytes of sync word, and by far the cheapest of these tests. */
  if (read16(bytes, 14) != 0) return false;
  if (mode != MODE_RAW && mode != MODE_RLE) return false;
  if (width == 0 || height == 0) return false;
  if ((uint32_t)x + width > SCREEN_WIDTH) return false;
  if ((uint32_t)y + height > SCREEN_HEIGHT) return false;

  uint32_t pixels = (uint32_t)width * height;
  if (mode == MODE_RAW) {
    /* Raw is exactly the pixels, no slack. */
    if (length != pixels * 2) return false;
  } else {
    /* Whole (count, value) pairs, at least one, and no more than one run per
     * pixel — an encoder that emitted more would be emitting empty runs. */
    if (length < 4 || length % 4 != 0) return false;
    if (length > pixels * 4) return false;
  }

  out->x = x;
  out->y = y;
  out->width = width;
  out->height = height;
  out->length = length;
  out->mode = mode;
  out->pixels = pixels;
  return true;
}

/*
 * Slide along the stream until sixteen consecutive bytes parse as a header.
 * On a stream we are already aligned to this reads sixteen bytes and returns;
 * otherwise it discards a byte at a time, which is the only resynchronisation
 * available without a sync word.
 */
static void await_header(rect_header_t *out) {
  uint8_t window[RECT_HEADER_BYTES];
  size_t held = 0;
  bool lost = false;

  for (;;) {
    while (held < RECT_HEADER_BYTES) {
      if (!stream_take(&window[held], 1, pdMS_TO_TICKS(HUNT_SLICE_MS))) {
        /* Quiet line. Nothing is wrong; surface the counters and keep waiting.
         * The bytes already held stay held — the packet may simply be split. */
        report();
        /* Quiet for a second is ordinary. Quiet for IDLE_BLANK_MS is a host
         * that has gone, and this is the only place that ever notices. */
        idle_check();
        continue;
      }
      held++;
    }

    if (parse_header(window, out)) {
      if (lost) stat_resyncs++;
      return;
    }

    /* Not a header. The first byte cannot be the start of one, so drop it and
     * reconsider the fifteen behind it plus whatever comes next. */
    memmove(window, window + 1, RECT_HEADER_BYTES - 1);
    held = RECT_HEADER_BYTES - 1;
    lost = true;
    stat_dropped++;
    /*
     * Counted and reported as we go, not on the way out. A stream that is
     * entirely garbage never reaches the return, and that is precisely the
     * case somebody debugging needs to be able to see.
     */
    report();
  }
}

/* ------------------------------------------------------------------ decode */

/*
 * Raw: the payload is the pixels. Read it straight into the framebuffer — the
 * validator already proved length == pixels*2, so it fits — then swap the
 * whole run in place. One linear pass, which is cheaper than swapping through
 * a staging buffer and keeps the read a single bulk copy.
 */
static bool decode_raw(const rect_header_t *header, TickType_t wait) {
  if (!stream_take(framebuffer, header->length, wait)) return false;
  for (uint32_t i = 0; i < header->pixels; i++) {
    framebuffer[i] = (uint16_t)__builtin_bswap16(framebuffer[i]);
  }
  return true;
}

/*
 * RLE: (count, value) pairs, little-endian, consumed four bytes at a time so a
 * run that straddles a USB read is not a special case. Every run is checked
 * against the remaining pixels; the decoder for this format on the host throws
 * on the same three conditions, and one fault should have one behaviour.
 *
 * A failure here means the packet is not what its header claimed, so nothing
 * is blitted — a half-decoded framebuffer is worse than a stale one.
 */
static bool decode_rle(const rect_header_t *header, TickType_t wait) {
  uint32_t written = 0;
  for (uint32_t offset = 0; offset < header->length; offset += 4) {
    uint8_t run[4];
    if (!stream_take(run, sizeof run, wait)) return false;
    uint16_t count = read16(run, 0);
    uint16_t value = read16(run, 2);
    if (count == 0) return false;
    if (written + count > header->pixels) return false;
    fill(written, count, panel_word(value));
    written += count;
  }
  return written == header->pixels;
}

/* -------------------------------------------------------------------- main */

void app_main(void) {
  blit_done = xSemaphoreCreateBinary();
  ESP_ERROR_CHECK(blit_done == NULL ? ESP_ERR_NO_MEM : ESP_OK);

  panel_start();
  draw_splash();
  /*
   * Backlight full on, straight from a GPIO rather than LEDC as upstream does.
   * Nothing here dims the panel or fades it, so a PWM channel would be a
   * peripheral held open to express a constant. When the brightness curve
   * arrives it belongs on the host anyway, as a protocol message, and this
   * line becomes a ledc_channel_config.
   */
  backlight_set(true);

  usb_serial_jtag_driver_config_t usb = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
  usb.rx_buffer_size = RX_RING_BYTES;
  usb.tx_buffer_size = 256;
  ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usb));

  /*
   * The splash stays up until the host paints over it, and it is never
   * redrawn. "No host connected" is not observable on this link — the USB
   * peripheral sees a Mac that has enumerated the device the same whether the
   * daemon is running or not. That part still holds: `usb_serial_jtag_is_
   * connected()` exists but reports SOF packets, so it sees the cable and not
   * the program.
   *
   * **The second half of this paragraph was wrong and is now `IDLE_BLANK_MS`.**
   * It said the closest proxy, an idle timeout, "would wipe the screen during
   * any long still frame. A crab asleep is a legitimate picture." True of a
   * host that goes quiet when the picture stops changing, and this host does
   * not: it repaints in full every five seconds by design. Silence here means
   * nothing is driving the panel, never that the picture is still.
   *
   * So there are now three states, not two. The splash means nothing has ever
   * driven this panel — `idle_check` will not blank it, so that reading is
   * intact. Lit means a host is talking. Dark means one was and has stopped:
   * asleep, quit, crashed, or unplugged. **"A dark panel means a fault" is no
   * longer true**, and `docs/INSTALL.md` carries the version a person needs.
   */
  for (;;) {
    rect_header_t header;
    await_header(&header);

    TickType_t wait = pdMS_TO_TICKS(PACKET_TIMEOUT_MS);
    bool decoded = header.mode == MODE_RAW ? decode_raw(&header, wait)
                                           : decode_rle(&header, wait);
    if (!decoded) {
      /* Either the payload never came or it disagreed with its header. We are
       * now at an unknown offset in the stream; await_header sorts that out. */
      stat_aborted++;
      report();
      continue;
    }

    blit(header.x, header.y, header.width, header.height);
    /* After the blit, not before it. Waking on the arrival of a header would
     * light the panel on whatever the controller's RAM still held — the stale
     * frame from before it went dark — for as long as the payload took. */
    backlight_set(true);
    stat_rects++;
    report();
  }
}
