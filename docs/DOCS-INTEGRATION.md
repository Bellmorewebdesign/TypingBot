# Google Docs integration: findings, permissions, and what is verified

## Why browser input (and why not DOM events)
Google Docs renders the page on a canvas and takes keyboard input through a hidden iframe
(`iframe.docs-texteventtarget-iframe`). Synthetic JavaScript `KeyboardEvent`s are untrusted and are ignored by the editor,
and the document text is not readable from the DOM. The extension therefore uses the Chrome DevTools Protocol through
`chrome.debugger` (trusted `Input.insertText` / `Input.dispatchKeyEvent`) and reads text back with select-all + copy.

No Google Docs API and no OAuth are used. **No additional local component was needed for the approach in this branch.**
The cost is the permission set below. If Google changes the editor so that this stops working, the fallback is a local
native-messaging helper or OS-level input, which would be a larger architectural change and is *not* part of this branch.

## Permissions and what they are for
| Permission | Why | Cost to you |
|---|---|---|
| `debugger` | Trusted keystrokes and text insertion in the Docs tab. Attached only for the duration of one edit and only to the linked tab. | Chrome shows a "TypingBot started debugging this browser" bar during an edit. Opening DevTools on that tab can detach it. |
| host `https://docs.google.com/document/*` | Content script that detects manual mouse/keyboard input. | Runs only on Docs documents. |
| `offscreen`, `clipboardRead`, `clipboardWrite` | Verify document text and selected passages by copying them. | **Overwrites your clipboard during a run.** |
| `storage` | Settings, pairing token, session state (survives extension reload). | Local to the browser profile. |
| `sidePanel` | The UI. | none |
| host `http://127.0.0.1:4317/*` | Talk to the backend on this PC. Nothing else is reachable. | none |

Restrictions enforced in code: edits are refused unless the linked tab is the *active tab of the focused window* and its URL still
has the document id captured when the plan was created (`guard()` in `extension/editor.js`).

## The backend connection
The extension talks to `http://127.0.0.1:4317` only. The service accepts a request only if the browser-set `Origin` is this extension's pinned ID (`extension/manifest.json` `key`) and the `Host` is local. Chrome puts `Origin` on an extension's POST requests but **not** on its GETs (found while testing: a GET arrives with `Sec-Fetch-Site: none` and no Origin), so every route that reads or changes anything is a POST; the only GET is a bare liveness check used by Docker.

## Safety behaviour (implemented and tested against a simulated and a stand-in editor)
* Before every edit the whole document is read and must equal the extension's saved copy, else nothing is typed.
* A replacement selects the target by counting from the end of the text, then **copies the selection and requires it to equal the target** before typing over it. Repeated phrases are addressed by offset, never by text search.
* After every edit the document is read again and must equal the expected text.
* An interrupted edit is never replayed. On **Resume** the document is read and classified (`reconcile()` in `editor.js`):
  completed -> skipped, untouched -> retried, partly typed -> only the remainder is typed, anything else -> stays paused for a person.
* Manual mouse input, or a key press that does not match the one-use marker the extension attached, pauses immediately (`takeover.js`).
* Tab switched, window unfocused, document reloaded, browser restarted, extension reloaded -> paused.

## Verification status
| Claim | Evidence |
|---|---|
| Edit/replace/verify/reconcile logic | Unit tests with a simulated debugger + clipboard (`tests/editor.test.mjs`, `tests/reconcile.test.mjs`). |
| CDP key/insertText/shift-arrow selection/copy mechanics in a real browser engine | `tests/browser/probe.mjs` runs the real `editor.js` in real Chromium against a stand-in page that mimics Docs' hidden input iframe. |
| Packaged extension: fresh install, upgrade, Start with/without a length, backend restart, double-click, error placement, a full session with pause/resume | `tests/browser/start-button.test.mjs` (real Chromium, unpacked extension, real backend in mock mode, stand-in Docs page at a docs.google.com URL). |
| **Works inside an actual Google Doc** | **NOT verified.** Needs a signed-in desktop browser. |

## Bugs the real-browser tests found
* Enter was sent as a bare `rawKeyDown`, which Chromium does not turn into a paragraph break (paragraph 2 was glued to paragraph 1). It is now a `keyDown` carrying `\r`; `tests/browser/probe.mjs` covers it.
* Chrome sends no `Origin` on an extension's GET requests, only on POSTs (see above).

## Manual Google Docs checklist (use a disposable blank doc, single tab, no collaborators)
1. Append: run a 1-paragraph accelerated mock session. Expect exactly the planned sentences, no doubled characters.
2. Replacement: with revision chance 100% expect an earlier sentence replaced once and nothing else changed.
3. Docs autocorrect: type text containing quotes, `--`, `(c)`, `1/2`, a lowercase sentence start. Docs may rewrite these; if the final check reports a mismatch, disable Tools > Preferences > Automatic substitutions / "Automatically capitalize words" and retry. Report what Docs changed.
4. Does select-all + copy return the text without a trailing newline? (A mismatch would pause the first edit with "Document differs".)
5. Does `Enter` created through `rawKeyDown` start a new paragraph? (Multi-paragraph runs.)
6. Pause mid-sentence, then Resume: expect "Reconciled · continuing a partly typed edit" and no duplicate text.
7. Pause mid-typo (right after a wrong letter appears): expect the *manual* recovery prompt (an uncorrected typo is deliberately not auto-guessed).
8. Click in the doc during a run: expect an immediate pause. Type a key during a run: expect a pause.
9. Switch tabs / minimise: expect a pause.
10. Repeat in Microsoft Edge.
