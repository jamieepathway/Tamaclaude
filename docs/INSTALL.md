# Setting it up

A small panel that sits on your desk and shows what Claude Code is doing. A
pixel crab called Clawd lives on it: he types while Claude types, thinks while
it thinks, and sleeps when nothing has happened for a while.

This is everything needed to get it running, in order. Most of the waiting is
one download.

> **The panel needs your Mac.** Every frame is drawn on the computer and sent
> to the device over USB — the panel itself holds no pictures. Plugged into a
> plain power adapter it shows its boot screen and waits. That is why there is
> software to install at all.

## What you need first

Two tools, neither of which macOS ships:

- **Node 24** — the version this is pinned to is 24.16.0
- **pnpm 10.32.1** — the project pins this exactly, and a different pnpm will
  switch itself to it rather than complain

If you already use [mise](https://mise.jdx.dev), the project pins both and can
install them for you — `mise install` inside the folder, once step 1 has given
you one. Otherwise install Node 24 from
[nodejs.org](https://nodejs.org) and then run `corepack enable pnpm`.

Nothing in the project compiles on install, so Xcode itself is not needed.
Apple's command line tools probably are, because `git` on macOS usually comes
from them — the first `git` command offers to install them. Nobody has yet
tested this on a Mac that has never had them.

## 1. Get the project

If it is not already on your Mac, clone it — the address is on the card, and
`git` will ask to install Apple's command line tools the first time if you have
never used it:

```bash
git clone <the repo address>
cd Tamaclaude
```

If somebody handed you the folder instead, put it somewhere permanent before
going on. Both later steps record where it lives, and moving it afterwards
stops the panel.

## 2. Build it

From inside the project folder:

```bash
pnpm install
pnpm build
```

`pnpm install` fetches a few hundred packages, nearly all of them tooling for
working on the project rather than running it — the program itself uses exactly
one third-party library. pnpm will print a warning that it
ignored a build script and suggest `pnpm approve-builds`; you can leave it
alone, because nothing needed to run the panel builds anything.

You do **not** need `pnpm exec playwright install`. That line is in the
README because `pnpm test` needs a headless browser — but running a panel does
not, and you are not running the tests. The animations are already drawn and
baked into the code.

## 3. Put your pack in place

A _pack_ is a folder holding your colours, the things Clawd says, and the date
he knows about. **Yours was made for you** — you should not have to build one.
It lives in its own small repository, private because a pack holds things this
project deliberately keeps off the public internet. You were given its address
along with this one.

Clone it straight into place:

```bash
git clone <the pack address you were given> ~/.tamaclaude/pack
```

**It is private, so git has to know who you are** — be signed in to GitHub on
this Mac and have accepted the invitation before you run that. If you get
`Repository not found`, that is almost always access rather than a typo:
GitHub reports a private repo you cannot see and one that does not exist in
exactly the same words, so the error sends you hunting the address when the
address is fine.

If you were handed a folder rather than an address, copy its contents in
instead so that `manifest.json` sits directly inside `~/.tamaclaude/pack/` —
and mind the trailing slash, because without it you get a folder inside a
folder and the program will say it cannot find the pack:

```bash
mkdir -p ~/.tamaclaude/pack
cp -R /path/to/your-pack/ ~/.tamaclaude/pack/
```

Then check it:

```bash
pnpm tamaclaude pack
```

**It should name your pack and say when its birthday fires.** If instead you
get `Cannot find module` and a page of Node output, step 2 did not finish — run
`pnpm build` again and watch for errors.

If it says `example`, or `birthday: none in this pack`, the wrong folder is in
place. That is worth stopping for rather than pressing on: the panel will look
completely correct and quietly do the wrong thing on the one day it matters.
There is an example pack in the project with placeholder colours and no date,
which exists so the software has something to test against.

> **If you cloned it, it is already backed up** — the pack repository is the
> copy, and a wiped Mac just means cloning it again. If you were handed a
> folder instead, keep it somewhere safe: the pack is the one thing here that
> cannot be rebuilt from a fresh download.

## 4. Plug the panel in

Use the USB cable, into the Mac itself rather than a hub if you have the
choice. Do this before the next step — the program finds the panel by looking
for it, so it needs to already be there.

You should see the boot screen: Clawd waving next to the name.

## 5. Start it

```bash
pnpm tamaclaude daemon
```

The boot screen should be replaced by Clawd beside his rock pool.

**Then press `Ctrl-C` to stop it before going on.** It will print
`ELIFECYCLE  Command failed` on the way out — that is what stopping it looks
like, not a problem. The next step starts the same program automatically, and
two copies cannot both run: the second finds the first still holding its socket
and exits. The installer checks and says so — `agent loaded but not running;
last exit 1` — so this is loud rather than silent, but it is easier not to
cause it.

## 6. Make it start when you log in

```bash
pnpm tamaclaude install-agent
```

That prints what it _would_ do and changes nothing. When it looks right:

```bash
pnpm tamaclaude install-agent --apply
```

Now it starts whenever you log in. Check:

```bash
pnpm tamaclaude status
```

It asks the system whether the thing is genuinely running, rather than assuming
it is.

## 7. Connect it to Claude Code

The panel reacts to Claude Code by being told what it is doing. This step wires
that up, and like the last one it shows you the change before making it:

```bash
pnpm tamaclaude-install-hooks
```

That prints the change and writes nothing. It edits `~/.claude/settings.json`,
which is also where your own Claude Code settings live, so it is worth reading
what it says it will add. When it looks right:

```bash
pnpm tamaclaude-install-hooks --apply
```

**Start a new Claude Code session before you test.** Hooks are read when a
session starts, so one that was already open knows nothing about them — and
`hook-settings.ts` ends every hook command with `2>/dev/null || true`, on
purpose, so that a broken hook can never interrupt a session. The two
together mean an already-open session shows you precisely what a failed
install would show you. It has not failed; it is not listening yet.

Then ask Claude Code to **read** a file, and watch — Clawd should start
climbing. Merely opening a session is not enough: that puts him at rest.

Reading rather than editing, because reading needs no approval. If Claude asks
your permission for something, the panel shows him holding a sign and keeps
showing it until the next thing you ask — so a first edit on a fresh install
tends to sit on the sign rather than the typing you were watching for.

## Do not move the project folder

Both the login entry and the Claude Code wiring store the full path to this
folder. Moving, renaming or deleting it stops the panel. The Claude Code half
goes quiet with no message at all; the login half shows up in
`pnpm tamaclaude status` and in the log. If you
do move it, run steps 6 and 7 again from the new location and both will
re-point themselves.

## When it stops working

Start here:

```bash
pnpm tamaclaude status
```

It asks the system whether the program is genuinely running, rather than
assuming. A handful of things account for almost everything, and the first one
below is usually not a fault at all.

**The panel is completely dark — no picture, no glow.** Most often this is
working as intended. The panel turns its backlight off after **thirty seconds**
with nothing arriving from the Mac, so a dark panel usually means the Mac is
asleep, or the daemon is not running. It comes back on its own, within a couple
of seconds, as soon as the Mac has something to send.

So check in this order:

1. **Is the Mac asleep?** Wake it. The panel should light within a few seconds.
2. **Is the daemon running?** `pnpm tamaclaude status`. If it is not, the
   entries below cover why.
3. **Only if the Mac is awake and `status` says it is running** is a dark panel
   a fault — most likely the cable or the board itself. Unplug the panel from
   its hub and plug it back in.

This changed on 6 Sep. Before then a panel whose host had stopped held its last
picture indefinitely, which looked healthy and was not — the more confusing of
the two failures, and the reason it now goes dark instead. Note the one case
that is _not_ covered: a panel showing the boot splash stays lit however long
it waits, because "nothing has ever driven this panel" is worth being able to
see.

**Clawd stopped reacting, but the panel is still on.** The Claude Code wiring
also stores the full path to Node, and it is deliberately silent when that path
breaks — it must never interrupt a session, so a failure prints nothing
anywhere. `status` will look fine. Re-point it:

```bash
pnpm tamaclaude-install-hooks --apply
```

**The panel is stuck on the boot screen, or never came back after a
restart.** Usually the login
entry pointing at a Node that has moved or been upgraded — same cause,
different half:

```bash
pnpm tamaclaude status                   # says so, if this is why
pnpm tamaclaude install-agent --apply    # re-points it
```

**You started it by hand and forgot.** If a `pnpm tamaclaude daemon` is still
running in a Terminal window somewhere, the automatic one cannot claim the
panel — it exits and retries every thirty seconds while everything looks
installed. `status` shows it loaded but not running. Close that window, or
press `Ctrl-C` in it, and the automatic one takes over within a minute.

**The panel is not plugged in.** `status` says so directly:

```
agent     loaded, waiting for a panel — plug it in and it starts itself
```

Plug it in and it starts on its own within thirty seconds; there is nothing to
re-run.

`status` still reports the program rather than the hardware, so it cannot tell
you the panel is _healthy_ — only that the daemon could not find one. To see
which device it would use, the dry run prints it:

```bash
pnpm tamaclaude install-agent
```

**Two panels are plugged in.** If a second board is ever attached — during a
repair, say — the daemon refuses rather than guessing, because every ESP32 in
this mode looks identical over USB and driving the wrong one would report
itself working. `status` says `loaded but not running; last exit 2 — see the
log`, and the log names both devices. Unplug one.

If none of those, the log is at `~/.tamaclaude/daemon.log` — written only by
the automatic startup from step 6, so it will not exist if you never got that
far.

It does not grow forever. Each time the program starts it checks: past a
megabyte, the current log is set aside as `~/.tamaclaude/daemon.log.1` and a
fresh one begins, and the first line of the fresh one says so. There are never
more than those two files.

Nothing older is kept. How long the two of them go back depends on how much
there has been to say, so if you are chasing something intermittent, copy the
log somewhere else before it turns over.

## Changing your pack

If you cloned it, pull:

```bash
git -C ~/.tamaclaude/pack pull
```

`git -C` rather than `cd`, deliberately: everything else on this page runs
from the top of the project folder, and a `cd` here leaves you somewhere
`pnpm tamaclaude` cannot work — the pack folder has no `package.json`, so the
next command answers `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` and the restart
never happens. The pull succeeds, nothing else does, and the panel goes on
showing the old pack.

Otherwise replace the **contents** of `~/.tamaclaude/pack/`. Either way the
program reads the pack once when it starts, so make it start again —
unplugging the panel is not enough. Logging out and back in does it, or:

```bash
pnpm tamaclaude uninstall-agent
pnpm tamaclaude install-agent --apply
```

Do not set `TAMACLAUDE_PACK` in your shell to point somewhere else — the login entry
carries its own copy of that setting, so the panel would go on using the old
pack while `pnpm tamaclaude pack` cheerfully reports the new one. If you do
want it somewhere else, change it and re-run `install-agent --apply`.

## Turning it off

```bash
pnpm tamaclaude uninstall-agent
```

That stops it running and stops it coming back. It leaves the Claude Code
wiring in place, which is harmless — the hook finds nothing listening and gives
up — but it does run on every event. There is no automatic way to remove it
yet; edit `~/.claude/settings.json` and delete the `tamaclaude` entries if you
want it gone entirely.

## A note on the commands

**Run everything from the top of the project folder.** `pnpm tamaclaude …`
resolves against the nearest `package.json`, so it works there and in ordinary
subfolders like `docs/`, and fails inside `packages/…` or anywhere outside the
project — including your home folder, which is where a Terminal opens.

So the first thing to type when something has gone wrong is:

```bash
cd ~/Tamaclaude          # or wherever you put it
```

Nothing is installed globally, and there is nothing on your `PATH` to go stale.
