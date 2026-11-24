# TypingBot

A personal Chrome side panel for drafting in a Google Doc. A small Node backend runs on your Ubuntu PC (in Docker) and calls Claude; the extension types into the Doc you have open. Everything runs on one PC: there is nothing to pair, no token to copy and no URL to enter.

**Status:** experimental browser integration. Backend, editor logic and the packaged extension (Start button, reconnection, upgrade, double-click) have automated tests. Typing inside a real signed-in Google Doc has **not** been verified; see [docs/DOCS-INTEGRATION.md](docs/DOCS-INTEGRATION.md) for the checklist. Use a disposable blank document first.

## Install or upgrade (Ubuntu PC)

```sh
git clone https://github.com/Bellmorewebdesign/TypingBot.git ~/TypingBot-preview   # first time only
cd ~/TypingBot-preview
git fetch origin && git checkout claude/wonderful-faraday-7uss4k && git pull --ff-only
./scripts/install.sh
```

`install.sh` is safe to repeat. It never touches an existing `.env` (your Anthropic key and mode stay as they are), enables Docker at boot, rebuilds and starts the container, and waits until it answers. The container has `restart: unless-stopped`, so TypingBot starts again after a reboot as soon as the PC is on. It is published on `127.0.0.1:4317` only: reachable from this PC, not from the network. (Docker Compose 2.24 or newer is required.)

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → select the `extension` folder. After an upgrade click the reload icon on the TypingBot card. The old pairing token, port and URL settings are deleted automatically; your last session, sources and preferences are kept.

## Use

1. Open a blank Google Doc and click inside the page. Open TypingBot from the toolbar. The panel connects by itself; if the backend is not running it shows one command to run.
2. Describe what you want. Say how long it should be if you care ("about 300 words across three paragraphs"); otherwise Claude chooses.
3. Optionally attach PDF, Markdown or text sources (up to 500 MB per collection) or paste reference text. Pick **ELA / English** or **Social Studies**.
4. Click **Start**. The panel plans the piece and begins. While it runs you see the current activity, elapsed time, an ETA range, app-tracked cost, **Pause / Resume** and **Stop**. Keep the Doc tab in front and the side panel open. The **AI activity log** is at the bottom of the panel.

Under **More options**: pace (slower / preset / faster), how often earlier wording is revised, minimum time per paragraph (presets use one hour; an hour per paragraph is intended), final review on/off, **accelerated test mode** (finishes in minutes), a length override (paragraphs, words per paragraph; blank by default and never filled in for you) and per-session / daily spending limits. The presets own the fine details (typing speed range, burst length, punctuation and sentence pauses, short and long breaks, typo rate and correction delay, revisit distance).

Every problem is explained next to the control it belongs to (for example a missing brief under the brief, an unreadable PDF under Sources, a reached budget beside Start). A click on Start never silently does nothing.

## Free smoke test

The default `.env` is mock mode: no API calls, no spend. Mock text is fixed example prose, but it follows a length written in the brief (so you can see "three paragraphs" honoured) and chooses two paragraphs otherwise. Try a short run with **Accelerated test mode** ticked and check: text appears once, an earlier sentence is replaced, the final review edit lands, Pause mid-sentence then Resume does not duplicate text.

## Going live with Claude

Edit `~/TypingBot-preview/.env`: set `MODEL_MODE=live` and `ANTHROPIC_API_KEY=...`, then `docker compose up -d`. The key stays on the server. `ANTHROPIC_MODEL` is optional (Haiku 5.5 by default; Sonnet 5.5 and Opus 5.5 have verified prices; any other model is refused, and the app never switches model by itself). Each request has a bounded payload, max 3,200 output tokens, `effort: low` and no automatic retry. The server reserves a conservative maximum before sending and records returned usage (input, output, cache write/read) in SQLite. Defaults and ceilings: 10 cents per session and 50 cents per UTC day; the panel can lower them. A failed or uncertain call keeps its reservation. Prices were checked against Anthropic's pricing page on 2026-11-24. Spend shown is **app-tracked only**: other apps on the same Anthropic account are not included, so your true balance is in the Anthropic Console.

Model calls send the brief, selected source excerpts and the current draft to Anthropic.

## How it is protected

* The service listens on `127.0.0.1` only (published that way by Docker) and rejects any request whose `Host` is not local, which blocks DNS-rebinding.
* Everything except a bare liveness check (`/health`, which reveals nothing) requires the browser-set `Origin` of **this installed extension**. A web page cannot forge `Origin`, so a website you visit cannot read your sources, change state or spend credits. The extension ID is fixed by a `key` in `extension/manifest.json`, so it is the same on every install. A program already running as you on this PC can still forge the header; that is why the port is not exposed to the network, and it could read your `.env` anyway.
* The Anthropic key never leaves the server.

## Reconnection and recovery

The panel checks the backend every few seconds, shows a red box with the single fix when it is unreachable (`cd ~/TypingBot-preview && docker compose up -d`), and recovers by itself when the backend returns. If the extension is not recognised (rare: reinstall under a different ID) it says to reload it at `chrome://extensions`.

An interrupted edit is never replayed: on Resume the document is read and compared with the text before and after the edit; a finished edit is skipped, an untouched one retried, a partly typed one continues from where it stopped, and anything else stays paused for you (use **Matches before / after**). Pausing can leave a partial sentence. Manual mouse or key input, switching tabs, reloading the Doc or restarting the browser pauses the run.

**Clipboard:** the prototype uses select-all and copy to compare the document text, which **overwrites your clipboard**. The `debugger` permission shows Chrome's "TypingBot started debugging this browser" bar during edits and produces a broad install warning.

The prototype assumes plain text, one document tab, no collaborators, and no suggestions, lists, tables or embedded objects, with Windows/Linux Ctrl shortcuts.

## What is verified (and what is not)

* `npm test`: budget gate (concurrency, daily limit), request lockdown (wrong/no Origin, rebinding Host), optional length, plan validation, pacing/conflicts, editor and interrupted-edit reconciliation against a simulated debugger.
* `npm run test:browser`: the real editor code in real Chromium against a stand-in editor page, and the **packaged extension** end to end against the real backend in mock mode: fresh install, upgrade with old settings, brief with and without a word count, length override, backend restart and reconnection, double-click and racing Start messages (exactly one paid request), every error shown beside its control, and a complete session with pause/resume.
* **Not verified:** anything inside a real signed-in Google Doc, live Claude calls (no API key available here), and `docker compose build` (no Docker daemon available here; `docker compose config` validates).

## Development

Node.js 24 or newer (or 22.18+) and Poppler (`pdftotext`, inside the image) for PDFs. `npm install` is only needed for the browser tests (`playwright`). `npm test` runs the backend and logic tests; `npm run test:browser` needs Chromium. Run the backend without Docker with `node --env-file=.env server/main.ts`.

Editor verification logic: `extension/editor.js`. Session and recovery flow: `extension/worker.js`. Panel: `extension/panel.*`. Timing presets and the simple controls: `extension/pacing.js`. Backend and budget: `server/main.ts`.
