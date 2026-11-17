# Lock-Screen Scam Guard

A Chrome (Manifest V3) extension that detects fake "your computer has been locked, call this number" pages shown from `blob:` URLs and gets the user out of them, while leaving legitimate `blob:` documents (report previews, editors, invoices) alone.

- [Add the extension to Chrome](#add-the-extension-to-chrome)
- [Try it](#try-it)
- [Decisions](#decisions)
- [How it is put together](#how-it-is-put-together)
- [Samples](#samples)
- [Tests](#tests)

The longer written note, with false-positive and false-negative risks and the bonus answers, is [NOTES.md](NOTES.md). The brief is [ASSIGNMENT.md](ASSIGNMENT.md).

## Add the extension to Chrome

1. Get the code onto your machine: clone the repository, or download it as a ZIP and unzip it.

   ```bash
   git clone https://github.com/juriponomarenko/lock-screen-scam-guard.git
   ```

2. Open Chrome and go to `chrome://extensions` (type it in the address bar).
3. Turn on **Developer mode** with the toggle in the top-right corner of that page. A row of buttons appears under the page title.
4. Click **Load unpacked**, the first button in that row (top-left).
5. In the folder picker, select the **`extension`** folder inside this project, the one that contains `manifest.json`. Do not select the project root.
6. A card named **Lock-Screen Scam Guard 1.0.0** appears, switched on, with **Details** and **Remove** buttons and no **Errors** button. The extension is now active; there is nothing to configure.
7. Only if you will open the sample pages straight from disk (`file://`): click **Details** on the card, scroll down, and check that **Allow access to file URLs** is on. It normally is for an unpacked extension. If you have to switch it on, Chrome applies the change after a restart. While it is off, the toolbar icon shows `!` on such a tab to say the page could not be inspected.

Later on:

- **After editing the code**, click the circular reload arrow on the card.
- **To switch it off or remove it**, use the toggle or the **Remove** button on the card.

On the Details page Chrome lists the permission "Read your browsing history" and site access "On all sites". The reason is in [Decisions](#decisions).

The manifest requires Chrome 133 or newer. The button names and positions above were checked against Chrome 157 on Windows, and the extension is verified on Chrome for Testing 146 and Chrome 157. Other Chromium browsers and other operating systems are untested.

## Try it

With Node installed, serve the samples from the project root:

```bash
npm run serve
```

Then:

1. Open `http://localhost:8080/malicious.html`. The lock screen is replaced by a "Scam page blocked" page.
2. Open `http://localhost:8080/benign.html` and click the button. The report opens in a new tab and nothing else happens.
3. For the "already on the page" case: remove the extension, open `malicious.html`, click somewhere in it, then load the extension again. The tab is redirected without a "Leave site?" prompt.

Without Node, open `samples/malicious.html` and `samples/benign.html` directly in Chrome (step 7 above applies).

## Decisions

In short: inspect only `blob:` documents, score three kinds of evidence, and redirect only when a page both looks like the scam and traps the user. Anything weaker gets a dismissible banner.

### Design

- **Look only at top-level `blob:` documents.** Showing content with no scannable URL is the scam's defining trick. Being a blob is the reason to look, never the verdict, because legitimate previews are blobs too.
- **Inject on demand, not on every page.** The service worker injects the detector only into blob tabs, so ordinary pages get no script and do not wake the worker. Tests assert both.
- **Sweep open tabs once at start**, so a scam already open at install time is caught.
- **Two responses, by the cost of being wrong.** A redirect destroys the page, so it needs proof of trapping. Weaker evidence gets a banner with a "Leave this page" button.
- **Escape from the service worker.** A page cannot block the tabs API. Its one defence, the "Leave site?" prompt, is possible only after the user has clicked; then the tab is discarded first, which runs no page code.
- **Broad permissions, narrow use.** A blob takes the origin of whichever site created it, so the extension needs access to all sites and to navigation events. The detector still only ever runs in blob tabs.
- **Left out on purpose:** content inside iframes of the blob document, and content painted more than 15 seconds after load. Both need new mechanisms and are listed as false negatives in [NOTES.md](NOTES.md).

### Heuristics

Evidence comes in three kinds, each scored:

| Kind | Signal | Points |
|---|---|---|
| Deception | Claims the device is locked, infected or at risk | 2 |
| Deception | Poses as an OS or security vendor ("Windows Security Alert") | 2 |
| Deception | Made-up error code | 1 |
| Hook | Phone number with "call / contact / support" next to it | 3 |
| Trap | Cancels F5, F11 or F12 | 3 |
| Trap | Locks the keyboard or pointer | 3 |
| Trap | `beforeunload` handler | 2 |
| Trap | Fullscreen | 2 |
| Trap | Cancels right-click | 1 |
| Trap | Back-button tampering | 1 |
| Provenance | The blob replaced the tab by script, with no user gesture | 1 |

A page counts as "trapping" when its trap points add up to 3 or more.

- **Block** (redirect): total of 6 or more, two kinds agree, and one of them is trapping.
- **Warn** (banner): total of 5 or more with two kinds, or trapping alone at 6 points or more.
- **Allow**: anything else. `benign.html` scores 0; `malicious.html` scores 15.

The judgement calls behind those numbers:

- **One kind alone never acts.** An invoice has a vendor name and a support number; an editor has an unsaved-changes prompt and its own right-click menu.
- **Words alone never redirect.** A help-desk ticket that quotes a scam reads the same as the scam; only behaviour separates them.
- **A vendor name is deception only when the page also traps the user.**
- **Only F5, F11 and F12 count as escape keys.** Editors and terminals legitimately bind Ctrl+L, Ctrl+R and Escape.
- **Trapping is detected three ways**, least intrusive first: reading the page's scripts, checking whether the user's own F5 or right-click was cancelled, and firing synthetic F5/F11/F12. The synthetic keys go only to a page that already claims the device is locked.

## How it is put together

| File | Role |
|---|---|
| `extension/background.js` | Service worker. Injects the detector into top-level `blob:` documents only, sweeps tabs that were already open, and performs the escape. |
| `extension/detector.js` | Content script. Collects evidence from the document, shows the banner, disarms the page's key traps. |
| `extension/heuristics.js` | Pure scoring: text and script analysis, weights, verdict. No DOM, so it is unit-tested in Node. |
| `extension/blocked.*` | The page the user lands on after a block. |

## Samples

| Sample | What it is | Expected |
|---|---|---|
| `malicious.html` | provided scam | blocked |
| `benign.html` | provided report viewer | untouched |
| `extra/benign-invoice.html` | vendor name + support phone number | untouched |
| `extra/benign-editor.html` | unsaved-changes prompt, custom right-click menu, Ctrl+S, Ctrl+L | untouched, all of them still work |
| `extra/benign-large-report.html` | 20,000-row generated report | untouched, inspected in about 40 ms |
| `extra/edge-security-article.html` | article that quotes scam wording and prints a helpline | banner only, never navigated |
| `extra/edge-security-leaflet.html` | short, non-scrolling awareness leaflet quoting scam wording | banner only, never navigated |
| `extra/malicious-obfuscated.html` | number as an image, handlers assembled at run time | blocked (probe) |
| `extra/malicious-obfuscated.html?trusted=1` | also ignores synthetic events | blocked when the user presses F5 |
| `extra/malicious-delayed.html` | paints the lock screen after 2.5 s | blocked when it appears |
| `extra/malicious-attribute-reveal.html?attribute=hidden` | reveals existing scam content after 2.5 s; also supports `class` and `style` | blocked when it appears |
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

- `npm test` runs 20 unit tests on the heuristics.
- `npm run test:e2e` runs 30 tests that load the unpacked extension into a real Chrome. They cover every sample above, plus: already open at install (with and without a prior click), confirmed fullscreen and keyboard lock before installation, service worker asleep, Back button after a block, extension reload, `file://` with and without file access, a `document.write()` rewrite, an SVG document, hidden padding, a short document that only quotes a scam, and two checks that ordinary pages get no detector and do not wake the service worker.

The end-to-end tests need a Chrome binary. Set `CHROME_PATH` to an installed Chrome (it runs with a throwaway profile), or install Chrome for Testing with `npx @puppeteer/browsers install chrome@stable`.
