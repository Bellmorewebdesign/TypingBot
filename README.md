# TypingBot

A personal Chrome/Edge side panel for drafting in a blank Google Doc. The Node backend runs on your Ubuntu server and calls Claude. The extension targets the linked Docs tab using browser input. The GPU is optional.

**Status:** experimental browser integration. The backend and editor state transitions have automated tests. Editing, clipboard access and keyboard selection in a signed-in Google Doc still require a desktop test. Use a disposable blank document for that test.

## Start on the Ubuntu server

From this branch's checkout:

```sh
test -f .env || (umask 077 && printf 'PAIR_TOKEN=%s\nMODEL_MODE=mock\nANTHROPIC_API_KEY=\n' "$(openssl rand -hex 32)" > .env)
docker compose up --build -d
```

The service listens on localhost port 4317. Open the local .env file to get the pairing token. On a different computer, either start an SSH tunnel there and keep it open:

```sh
ssh -N -L 4317:127.0.0.1:4317 YOUR_USER@YOUR_SERVER
```

or use a private network (Tailscale, WireGuard, ZeroTier). Set `BIND_ADDR` in the server's `.env` to the server's private-network IP (for Tailscale, `tailscale ip -4`), run `docker compose up -d`, then enter `http://THAT_IP:4317` as the **Backend URL** in the panel. The browser asks once to allow that origin. Traffic on those networks is encrypted by the network; do not publish the port on a public address and do not use `BIND_ADDR=0.0.0.0` without a firewall. For a local test, leave the default `http://127.0.0.1:4317`.

Download this branch on the computer running the browser. Open chrome://extensions or edge://extensions, turn on Developer mode, click **Load unpacked**, and select the **extension** folder. The panel uses native browser modules and needs no npm install or build. Linux or Windows desktop Ctrl shortcuts are assumed.

## Run the free smoke test

1. Open a new blank single-tab Google document, click in the body, then open TypingBot from the toolbar. Reload existing Docs tabs after installing the extension.
2. Under **Backend connection**, paste the pairing token and click **Save and test**. The badge should say **mock**.
3. Enter a short brief, choose one paragraph, open **Advanced writing settings**, and click **Accelerate for testing**. Set revision chance to 100% to exercise replacements.
4. Click **Generate writing plan**, inspect **Planned edits**, then **Run / resume**. Keep the linked tab active and the side panel open. The mock produces fixed example prose independent of the brief. During the run the panel shows the current action, estimated time remaining, elapsed time, usage cost and AI activity.
5. Verify the panel can append two sentences, replace an earlier sentence, then apply a final review. Try Pause during a sentence. If interrupted, restore the text to one of the two displayed snapshots and confirm which matches. Resume and check the final text for duplicates. Repeat in Edge if using Edge.

**Clipboard:** the prototype uses select-all and copy to compare plain document text and uses copy to verify a selected replacement. These checks replace your clipboard contents. The extension only attaches its debugger to the chosen tab during an edit. The debugger permission produces a broad browser warning. Clipboard permissions and an offscreen document handle verification. Storage persists sessions/settings, and a Docs content script detects manual input. Attaching DevTools, moving focus, opening another tab, and Google editor changes may interrupt a run. A pause can leave a partial sentence; inspect it before recovery. The prototype assumes plain text, one document tab, no collaborators, and no suggestions, lists, tables or other embedded objects.

## What the panel controls
Simple settings: preset (ELA / English, Social Studies, Custom), brief, pasted reference text, source files, paragraphs, target length (words per paragraph), Run / Pause / Stop, current activity and paragraph, elapsed time, ETA range and app-tracked cost. Advanced settings, all of which change behaviour: average/minimum/maximum typing speed, keystroke variation, burst length, punctuation pause, sentence pause, short and long break chance and length, typo rate and correction delay, wording-revision chance and how many sentences back to revisit, final review on/off, minimum minutes per paragraph, per-run and daily budget. Settings that conflict (for example minimum speed above average, or a long break longer than the paragraph minimum) are flagged before a plan is requested; errors block the run.

## Writing controls

English favors slower typing, more sentence revisions and longer rereading pauses. Social Studies uses faster typing, shorter pauses and fewer mid-paragraph revisions. In Advanced, tune typing speed and variation, burst length, typo rate, pauses, longer breaks, revision frequency and distance, minimum minutes per paragraph, and the final review. Save a custom preset. Default paragraph duration is at least 60 minutes including scheduled pauses. Test mode sets the minimum to zero. Keep the browser awake. The ETA is an estimate; manual pauses suspend it.

The backend asks for paragraph drafts with proposed replacements in one call. The extension schedules sentence insertions and earlier revisions, varies typing, introduces temporary typing mistakes and corrects them. A second optional model request reviews the complete working draft. The log records whether content came from the mock or Claude, final review activity, and playback corrections. Generating a new plan replaces the last local session and log.

## Sources and live Claude

Paste reference text or select PDF, Markdown and TXT files. Uploads stay on the server inside its data volume with a 500 MB total limit per source collection. The prototype ranks 1,400-character excerpts against the writing brief and sends up to four with the pasted references. It reads the first 40 pages of each text-based PDF and the first 512 KB of each text file. Image-only scans need pasted text. Starting a fresh collection changes which sources are used; previously uploaded files stay in the volume.

After mock verification, edit the server's .env file, set MODEL_MODE=live and set ANTHROPIC_API_KEY. Run docker compose up -d again to recreate the service. Keep this key on the server. Live mode uses claude-haiku-5-5 unless `ANTHROPIC_MODEL` names another model in the server's verified price table (Haiku 5.5, Sonnet 5.5, Opus 5.5); an unknown model is refused and the app never switches models by itself. Each request has a bounded text payload, max 3,200 output tokens, `effort: low` and no automatic retry. The app reserves a conservative maximum before sending and records returned usage in SQLite. Defaults and server ceilings are 10 cents per session and 50 cents per UTC day; panel settings can lower either. A provider failure with uncertain usage leaves the reservation in place. Pending reservations can reduce remaining budget beyond the successful spend shown for the session. Pricing was checked against Anthropic's pricing page on 2026-11-24 (Haiku 5.5 $0.10/$0.50 per million input/output tokens for prompts up to 100k; cache write/read tokens are priced too). Spend shown is **app-tracked only**: other apps using the same Anthropic account are not included, so your real balance is in the Anthropic Console. The daily limit uses UTC days.

The live draft, preview and final review all use the same source collection. Model calls transmit the brief, selected source text and applicable draft to Anthropic. Mock mode spends no API credits. Pairing and SSH forwarding are designed for personal use.

## What is verified (and what is not)
* Automated, no browser: `npm test` (budget gate incl. concurrency and daily limit, plan validation, pacing/conflicts, editor and reconcile logic against a simulated debugger).
* Automated, real Chromium: `npm run test:browser` runs the real editor code against a stand-in editor page and loads the unpacked extension against the mock backend. See `docs/DOCS-INTEGRATION.md`.
* **Not verified:** anything inside a real signed-in Google Doc, live Claude calls (no API key was available), and `docker compose build` (no Docker daemon was available; `docker compose config` validates). Follow the checklist in `docs/DOCS-INTEGRATION.md`.
* File uploads, extraction and excerpt retrieval exist from the earlier prototype and have a unit test; they were not re-tested against very large files.

## Development

Use Node.js 24 or later and Poppler (pdftotext) for PDF extraction. Use npm test to run backend, budget and simulated-editor tests. Start without Docker using node --env-file=.env server/main.ts. Native Node TypeScript stripping handles the backend; the panel and service worker are plain browser JavaScript.

The editor verification logic is in extension/editor.js, the session and recovery flow in extension/worker.js, and the timing defaults in extension/pacing.js. Actual Docs verification is a separate manual check from automated tests.
