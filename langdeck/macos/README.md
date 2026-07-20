# Can you run this on your Mac? (~5 minutes)

Hi — thanks for helping.

**Short version:** run three commands, copy the output, send it back. That's the whole job.

## What this is

I'm building a Stream Deck button that shows which keyboard language you're currently typing in,
and switches to the next one when you press it. The Windows half is finished and working. The Mac
half is written but has **never been run**, because I don't have a Mac — so every line of it is
educated guesswork until your machine says otherwise.

That's what you're doing: turning guesses into facts. **A failure is a genuinely useful result**,
not a wasted trip. If it explodes, the error message is exactly what I need.

## Is it safe?

Yes, and here's specifically why:

- It's ~200 lines of Swift you can read in full — `langtool.swift` is right there in this folder.
- It only calls Apple's documented Text Input Services API, the same one the menu-bar input
  switcher uses. It does **not** simulate keystrokes, read your typing, or touch the network.
- The test **changes your input language and changes it straight back**, and verifies the restore.
- It needs **no special permissions**. If macOS pops up a prompt asking for Accessibility or Input
  Monitoring access, **stop and tell me** — that would mean one of my assumptions is wrong, and
  that's important to know.
- Nothing is installed. Everything stays in this folder; delete it when you're done.

## What you need

macOS with **Xcode Command Line Tools**. You may already have them. If not, the build script will
tell you, and this installs them (a few minutes, Apple's own tooling):

```bash
xcode-select --install
```

**You also need at least two keyboard input sources enabled**, otherwise there's nothing to switch
between and the test can't prove anything. Check:
**System Settings → Keyboard → Text Input → Input Sources → Edit…**
Any second language will do — it doesn't matter which.

## What to run

Open Terminal, `cd` into this folder, then:

```bash
chmod +x build.sh verify.sh
./build.sh
./verify.sh
```

`verify.sh` will pause partway through and ask you to **switch your input language by hand** — use
the menu bar or whatever shortcut you normally use. It's checking whether macOS tells our code
about changes it didn't make. You'll have 12 seconds; the script waits for you.

## What to send back

**All the terminal output from both commands.** Please don't trim it — the boring environment
lines (macOS version, chip, Swift version) matter as much as the results, because behaviour can
differ between macOS versions and between Intel and Apple Silicon.

The last line will say something like `RESULT: 6 passed, 0 failed`.

## If it fails

Please send the output anyway. Specifically useful:

| What you see | What it tells me |
|---|---|
| `swiftc not found` | You need the Command Line Tools (`xcode-select --install`) |
| Compiler errors | My Swift is wrong — the exact error tells me where |
| `switch NOT confirmed` | The API call reports success but doesn't actually work — a big finding |
| `no change notification seen` | Either you didn't switch in time, or macOS doesn't notify the way I expect |
| A permission prompt | My "no permissions needed" assumption is wrong — important |

Any of these is a good outcome. The point of this exercise is to find out which one is true.

## What the code actually does

Four commands, all printing one line of JSON:

| Command | Purpose |
|---|---|
| `./langtool list` | every enabled, selectable keyboard input source |
| `./langtool current` | which one is active right now |
| `./langtool select <id>` | switch to a specific one |
| `./langtool watch` | print a line whenever the input source changes |

`watch` is the interesting one. On Windows there's no such notification, so that version has to
poll every 1.5 seconds and can briefly show the wrong language. macOS publishes a real change
notification, so if it works, the Mac version will be strictly better than the Windows one —
instant instead of up-to-1.5-seconds-stale.

## The thing I'm least sure about

`langtool.swift` filters input sources to ones that are *enabled*, *selectable*, and in the
*keyboard* category. Without that filter the list also includes things like character palettes,
which can't be selected — and a "switch to the next one" button that lands on an unselectable
entry would just silently do nothing. If `list` shows entries that look wrong or missing, that
filter is the first suspect.

Thanks again — this genuinely can't be done without you.
