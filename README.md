# Lock-Screen Scam Guard

A Chrome (Manifest V3) extension that detects fake "your computer has been locked" tech-support pages shown from `blob:` URLs and gets the user out of them, while leaving legitimate uses of `blob:` documents alone.

The reasoning, trade-offs and known risks are in [NOTES.md](NOTES.md). The brief is in [ASSIGNMENT.md](ASSIGNMENT.md).

## Try it

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select the `extension/` folder.
2. Serve the samples:

   ```bash
   npm run serve
   ```

3. Open `http://localhost:8080/malicious.html`. The lock screen is replaced by a "Scam page blocked" page.
4. Open `http://localhost:8080/benign.html` and click the button. The report opens in a new tab and nothing else happens.

To test the "already on the page" case, remove the extension, open `malicious.html`, click somewhere in it, then load the extension again.

The samples can also be opened straight from disk (`file://`). That needs **Allow access to file URLs** to be on in the extension's details page. If it is off, the toolbar icon shows `!` on the tab to say the page could not be inspected.

## How it is put together

| File | Role |
|---|---|
| `extension/background.js` | Service worker. Injects the detector into top-level `blob:` documents only, sweeps tabs that were already open, and performs the escape. |
| `extension/detector.js` | Content script. Collects evidence from the document, shows the banner, disarms the page's key traps. |
| `extension/heuristics.js` | Pure scoring: text and script analysis, weights, verdict. No DOM, so it is unit-tested in Node. |
| `extension/blocked.*` | The page the user lands on after a block. |

The detector is injected with `chrome.scripting.executeScript` rather than declared in the manifest. That is deliberate: a declared content script would have to match every URL and would be loaded into every page, and the performance requirement is easiest to meet by not being there.

## Samples

| Sample | What it is | Expected |
|---|---|---|
| `malicious.html` | provided scam | blocked |
| `benign.html` | provided report viewer | untouched |
| `extra/benign-invoice.html` | vendor name + support phone number | untouched |
| `extra/benign-editor.html` | unsaved-changes prompt, custom right-click menu, Ctrl+S | untouched, all three still work |
| `extra/benign-large-report.html` | 20,000-row generated report | untouched, inspected in about 18 ms |
| `extra/edge-security-article.html` | article that quotes scam wording and prints a helpline | banner only, never navigated |
| `extra/malicious-obfuscated.html` | number as an image, handlers assembled at run time | blocked (probe) |
| `extra/malicious-obfuscated.html?trusted=1` | also ignores synthetic events | blocked when the user presses F5 |
| `extra/malicious-delayed.html` | paints the lock screen after 2.5 s | blocked when it appears |
| `extra/malicious-layered.html` | blob-to-blob hop, history trap, fullscreen, keyboard lock | blocked |
| `extra/malicious-image-only.html` | all text drawn on a canvas | banner; "Leave this page" works |

## Tests

```bash
npm install
```

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm test` runs 16 unit tests on the heuristics.
- `npm run test:e2e` loads the unpacked extension into a real Chrome and runs every sample above, plus: already open at install (with and without a prior click), service worker asleep, Back button after a block, `file://` with and without file access, and two checks that ordinary pages get no detector and do not wake the service worker.

The end-to-end tests need a Chrome for Testing binary. Set `CHROME_PATH`, or install one with `npx @puppeteer/browsers install chrome@stable`.

Verified on Chrome for Testing 146 and Chrome 157 on Windows. Not verified on older Chrome versions, macOS or Linux.
