// End-to-end tests: the unpacked extension in a real Chrome against samples/.
//
//   npm run test:e2e
//
// Needs a Chrome binary: point CHROME_PATH at chrome.exe / chrome (an installed
// Chrome works, it runs with a throwaway profile), or install Chrome for Testing:
//   npx @puppeteer/browsers install chrome@stable
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startServer } from './serve.mjs';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const binary = { win32: 'chrome.exe', darwin: 'Google Chrome for Testing', linux: 'chrome' }[process.platform];
  const roots = [path.join(os.homedir(), '.cache', 'puppeteer', 'chrome'), path.resolve('chrome')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const found = readdirSync(root, { recursive: true })
      .map((entry) => path.join(root, String(entry)))
      .filter((entry) => path.basename(entry) === binary)
      .sort()
      .pop();
    if (found) return found;
  }
  throw new Error('No Chrome found. Set CHROME_PATH (see the top of this file).');
}

let browser;
let server;
let extensionId;

const installExtension = async () => {
  extensionId = await browser.installExtension(EXTENSION_DIR);
};
const sample = (name) => `${server.origin}/${name}`;
const pageUrls = async () => (await browser.pages()).map((page) => page.url());
const isBlockedUrl = (url) => url.startsWith(`chrome-extension://${extensionId}/blocked.html`);
const blockedPage = async () => (await browser.pages()).find((page) => isBlockedUrl(page.url()));
const blobPages = async () => (await browser.pages()).filter((page) => page.url().startsWith('blob:'));

async function waitFor(check, what, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Pages: ${await pageUrls()}`);
    await sleep(100);
  }
}

/** Open a sample that replaces its own tab with a blob: document. */
async function openSample(name) {
  const page = await browser.newPage();
  // Leave "Leave site?" prompts unanswered, as a trapped user would, but count them.
  page.prompts = [];
  page.on('dialog', (dialog) => page.prompts.push(dialog.type()));
  await page.goto(sample(name), { waitUntil: 'domcontentloaded' }).catch(() => {});
  return page;
}

/** Open a sample whose button opens the blob: document in a new tab. */
async function openSampleViaClick(name, buttonSelector) {
  const opener = await browser.newPage();
  await opener.goto(sample(name));
  await opener.click(buttonSelector);
  const target = await browser.waitForTarget((t) => t.type() === 'page' && t.url().startsWith('blob:'));
  const page = await target.page();
  await page.bringToFront();
  return { opener, page };
}

/** Navigate a fresh tab to a blob: document built from markup, the way malicious.html does. */
async function openBlob(markup, type = 'text/html') {
  const page = await browser.newPage();
  page.prompts = [];
  page.on('dialog', (dialog) => page.prompts.push(dialog.type()));
  await page.goto(sample('benign.html'));
  await page
    .evaluate((html, mime) => (location.href = URL.createObjectURL(new Blob([html], { type: mime }))), markup, type)
    .catch(() => {});
  return page;
}

/**
 * Run `openPages` with the extension removed, then install it: the "already on
 * the page" case. The finally keeps one failed test from leaving the rest of
 * the suite without an extension.
 */
async function installAfter(openPages) {
  await browser.uninstallExtension(extensionId);
  try {
    return await openPages();
  } finally {
    await installExtension();
  }
}

async function expectBlocked(reasonsToInclude = []) {
  const page = await waitFor(blockedPage, 'the tab to reach the blocked page');
  assert.deepEqual(await blobPages(), [], 'no blob: lock screen may be left open');
  const why = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('why').split(',');
  for (const reason of reasonsToInclude) assert.ok(why.includes(reason), `reason "${reason}" missing from ${why}`);
  return page;
}

const hasBanner = (page) => page.evaluate(() => Boolean(document.querySelector('div[popover]')));

/** The banner lives in a closed shadow root, so reach its buttons through CDP. */
async function clickBannerButton(page, selector) {
  const cdp = await page.createCDPSession();
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const findHost = (node) => {
    if (node.shadowRoots && (node.attributes || []).includes('popover')) return node;
    for (const child of node.children || []) {
      const hit = findHost(child);
      if (hit) return hit;
    }
    return null;
  };
  const host = findHost(root);
  assert.ok(host, 'banner host not found');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: host.shadowRoots[0].nodeId, selector });
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
  const [x1, y1, , , x3, y3] = model.content;
  await cdp.detach();
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}

/** The extension's service worker target, woken first if it is asleep. */
async function serviceWorker() {
  const isOurs = (t) => t.type() === 'service_worker' && t.url().includes(extensionId);
  if (!browser.targets().some(isOurs)) {
    const [page] = await browser.pages();
    const cdp = await page.createCDPSession();
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${extensionId}/` });
    await cdp.detach();
  }
  await browser.waitForTarget(isOurs, { timeout: 5000 });
  // After an extension restart the old worker's target can linger; take the newest.
  return browser.targets().filter(isOurs).at(-1);
}

/** Run an expression in the extension's service worker. */
async function inServiceWorker(expression) {
  const worker = await serviceWorker();
  const cdp = await worker.createCDPSession();
  const { result, exceptionDetails } = await Promise.race([
    cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => { ${expression} })()`,
    }),
    sleep(4000).then(() => {
      throw new Error('service worker did not answer');
    }),
  ]);
  await cdp.detach();
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

/**
 * The detector's own view of a tab, read from its isolated world.
 * null means the detector was never injected there.
 */
function detectorState(page) {
  return inServiceWorker(`
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === ${JSON.stringify(page.url())});
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const d = globalThis.__lsgDetector;
        return d ? { verdict: d.verdict, score: d.score, reasons: d.reasons, ms: d.lastEvaluationMs } : null;
      },
    });
    return injection.result;
  `);
}

/** Flip "Allow access to file URLs", as the toggle on chrome://extensions does. */
async function setFileAccess(allowed) {
  const page = await browser.newPage();
  await page.goto('chrome://extensions/');
  await page.evaluate(
    (id, fileAccess) =>
      new Promise((resolve) =>
        chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess }, resolve)
      ),
    extensionId,
    allowed
  );
  await waitFor(
    () =>
      page.evaluate(
        (id) => new Promise((resolve) => chrome.developerPrivate.getExtensionInfo(id, resolve)),
        extensionId
      ).then((info) => info.fileAccess.isActive === allowed && info.state === 'ENABLED'),
    'the extension to restart with the new file access setting'
  );
  await page.close();
  await sleep(500); // let the restart sweep finish
}

async function stopServiceWorker() {
  const [page] = await browser.pages();
  const cdp = await page.createCDPSession();
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await waitFor(
    () => !browser.targets().some((t) => t.type() === 'service_worker' && t.url().includes(extensionId)),
    'the service worker to stop'
  );
}

before(async () => {
  server = await startServer();
  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: !process.env.HEADFUL,
    pipe: true,
    enableExtensions: true,
    args: ['--enable-unsafe-extension-debugging'],
  });
  // Developer mode on, as it is for anyone who loaded the extension unpacked.
  // Branded Chrome will not restart an unpacked extension without it.
  const settings = await browser.newPage();
  await settings.goto('chrome://extensions/');
  await settings.evaluate(
    () => new Promise((resolve) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve))
  );
  await settings.close();

  await installExtension();
  // Let the install-time sweep finish, so the first test exercises the
  // navigation path alone rather than racing it.
  await sleep(500);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

afterEach(async () => {
  const pages = await browser.pages();
  if (!pages.some((page) => page.url() === 'about:blank')) await browser.newPage();
  for (const page of await browser.pages()) {
    if (page.url() !== 'about:blank') await page.close().catch(() => {});
  }
});

// ------------------------------------------------------------ the two given samples

test('malicious.html: the lock screen is replaced by the blocked page', async () => {
  await openSample('malicious.html');
  const page = await expectBlocked([
    'scare',
    'impersonation',
    'phoneCta',
    'errorCode',
    'keysBlocked',
    'beforeunload',
    'contextMenuBlocked',
    'scriptedRedirect',
  ]);
  assert.equal(await page.$eval('h1', (h) => h.textContent), 'Scam page blocked');
  assert.equal(await page.$$eval('#reasons li', (items) => items.length), 8);
});

test('malicious.html: Back does not return the user to the lock screen', async () => {
  await openSample('malicious.html');
  const page = await expectBlocked();
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(2500);
  const lockScreens = [];
  for (const candidate of await browser.pages()) {
    const text = await candidate.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (text.includes('Your computer has been locked')) lockScreens.push(candidate.url());
  }
  assert.deepEqual(lockScreens, []);
});

test('malicious.html: still caught after the service worker has gone to sleep', async () => {
  await stopServiceWorker();
  await openSample('malicious.html');
  await expectBlocked();
});

test('benign.html: the generated report opens and is left completely alone', async () => {
  const { opener, page } = await openSampleViaClick('benign.html', '#view-report');
  await sleep(2500); // well past every detector checkpoint
  assert.ok(page.url().startsWith('blob:'));
  assert.equal(await page.$eval('h1', (h) => h.textContent), 'Monthly Report');
  assert.equal(await page.$$eval('tr', (rows) => rows.length), 3);
  assert.equal(await hasBanner(page), false);
  assert.equal(await opener.$eval('h1', (h) => h.textContent), 'Monthly Report Viewer');
  assert.equal(await blockedPage(), undefined);
  // "Left alone" must mean inspected and cleared, not skipped.
  const state = await detectorState(page);
  assert.equal(state.verdict, 'allow');
  assert.equal(state.score, 0);
  // And the ordinary page that created it was never touched at all.
  assert.equal(await detectorState(opener), null);
});

test('ordinary web pages never get the detector injected', async () => {
  const page = await browser.newPage();
  await page.goto(sample('extra/benign-invoice.html'));
  await sleep(1000);
  assert.equal(await detectorState(page), null);
});

test('ordinary browsing does not even wake the service worker', async () => {
  await stopServiceWorker();
  const page = await browser.newPage();
  for (const name of ['benign.html', 'extra/benign-invoice.html', 'extra/benign-editor.html']) {
    await page.goto(sample(name));
    await page.reload();
  }
  await sleep(1000);
  const awake = browser.targets().some((t) => t.type() === 'service_worker' && t.url().includes(extensionId));
  assert.equal(awake, false, 'no event the extension listens for should have fired');
});

// ----------------------------------------------------------- harder benign pages

test('benign invoice with a vendor name and a support phone number is left alone', async () => {
  const { page } = await openSampleViaClick('extra/benign-invoice.html', '#open');
  await sleep(2500);
  assert.ok(page.url().startsWith('blob:'));
  assert.equal(await hasBanner(page), false);
  const state = await detectorState(page);
  assert.equal(state.verdict, 'allow');
  assert.deepEqual(state.reasons.sort(), ['impersonation', 'phoneCta'], 'it does look half like a scam');
});

test('benign megabyte-sized report is left alone and inspected cheaply', async (t) => {
  const { page } = await openSampleViaClick('extra/benign-large-report.html', '#open');
  await page.waitForSelector('tr:nth-child(20001)');
  await sleep(2500);
  assert.equal(await hasBanner(page), false);
  const state = await detectorState(page);
  assert.equal(state.verdict, 'allow');
  assert.equal(state.score, 0);
  t.diagnostic(`detector evaluation took ${state.ms.toFixed(1)} ms on a 20,000-row document`);
  assert.ok(state.ms < 100, `evaluation took ${state.ms} ms`);
});

test('benign editor keeps its unsaved-changes prompt, shortcut and custom menu', async () => {
  const page = await browser.newPage();
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.dismiss(); // "Stay on page"
  });
  await page.goto(sample('extra/benign-editor.html'));
  await page.click('#open');
  await page.waitForSelector('#note');
  await sleep(2500);
  assert.ok(page.url().startsWith('blob:'));
  assert.equal(await hasBanner(page), false);
  assert.equal((await detectorState(page)).verdict, 'allow');

  await page.type('#note', 'draft');
  assert.equal(await page.$eval('#status', (s) => s.textContent), 'Unsaved changes');

  await page.click('h1', { button: 'right' });
  assert.equal(await page.$eval('#menu', (m) => getComputedStyle(m).display), 'block', 'custom menu');

  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
  assert.equal(await page.$eval('#status', (s) => s.textContent), 'Saved', 'Ctrl+S shortcut');

  await page.keyboard.down('Control');
  await page.keyboard.press('l');
  await page.keyboard.up('Control');
  assert.equal(await page.$eval('#status', (s) => s.textContent), 'Selected all', 'Ctrl+L shortcut');
  await sleep(500);
  assert.equal(await hasBanner(page), false, 'using an app shortcut must not raise the scam banner');

  await page.type('#note', ' more');
  await page.goto('about:blank').catch(() => {});
  assert.deepEqual(dialogs, ['beforeunload'], 'the page still gets to ask about unsaved changes');
  assert.ok(page.url().startsWith('blob:'), 'and the user stayed');
  await page.close();
});

test('scam-awareness article is never navigated away; its banner can be dismissed', async () => {
  const { page } = await openSampleViaClick('extra/edge-security-article.html', '#open');
  await waitFor(() => hasBanner(page), 'the warning banner');
  assert.ok(page.url().startsWith('blob:'));
  assert.equal(await blockedPage(), undefined);
  assert.equal((await detectorState(page)).verdict, 'warn');

  await clickBannerButton(page, 'button:not(.leave)');
  await waitFor(async () => !(await hasBanner(page)), 'the banner to go away');
  await sleep(2000);
  assert.equal(await hasBanner(page), false, 'a dismissed banner stays dismissed');
  assert.ok(page.url().startsWith('blob:'));
});

// ------------------------------------------------------------ harder scam pages

test('obfuscated scam with the number in an image is caught by the active probe', async () => {
  await openSample('extra/malicious-obfuscated.html');
  await expectBlocked(['scare', 'keysBlocked']);
});

test('scam that ignores synthetic events is caught when the user tries to reload', async () => {
  const page = await openSample('extra/malicious-obfuscated.html?trusted=1');
  await waitFor(() => page.url().startsWith('blob:'), 'the lock screen');
  await sleep(2500);
  assert.ok(page.url().startsWith('blob:'), 'not enough evidence yet');
  await page.keyboard.press('F5');
  await expectBlocked(['scare', 'keysBlocked']);
});

test('scam that paints its lock screen late is caught when the content appears', async () => {
  await openSample('extra/malicious-delayed.html');
  await expectBlocked(['scare', 'phoneCta', 'keysBlocked']);
});

test('layered scam (blob-to-blob hop, history flood, fullscreen, keyboard lock) is caught', async () => {
  await openSample('extra/malicious-layered.html');
  await expectBlocked(['scare', 'phoneCta', 'keysBlocked', 'fullscreen', 'inputLock', 'historyTrap']);
});

test('image-only scam gets the banner, and "Leave this page" beats its traps', async () => {
  const page = await openSample('extra/malicious-image-only.html');
  await waitFor(() => hasBanner(page).catch(() => false), 'the warning banner');
  await sleep(1500);
  assert.ok(page.url().startsWith('blob:'), 'behaviour alone does not trigger automatic navigation');

  await clickBannerButton(page, 'button.leave');
  const blocked = await expectBlocked(['keysBlocked', 'beforeunload']);
  assert.deepEqual(page.prompts, [], 'the page never got to show "Leave site?"');
  assert.equal(await blocked.$eval('h1', (h) => h.textContent), 'You left a suspicious page');
});

test('the banner stays on top when the page goes fullscreen', async () => {
  const page = await openSample('extra/malicious-image-only.html');
  await waitFor(() => hasBanner(page).catch(() => false), 'the warning banner');
  await page.evaluate(() =>
    document.addEventListener('click', () => document.documentElement.requestFullscreen(), { once: true })
  );
  await page.mouse.click(300, 300);
  await waitFor(() => page.evaluate(() => Boolean(document.fullscreenElement)), 'fullscreen');
  await sleep(300);
  const onTop = await page.evaluate(() => document.elementFromPoint(20, 20) === document.querySelector('div[popover]'));
  assert.equal(onTop, true, 'banner must be the top-most element at the top of the screen');
  assert.ok(page.url().startsWith('blob:'));
});

// ------------------------------------------------- variants found in review

const LOCK_TEXT = `<div style="text-align:center;color:#fff"><h1>Your computer has been locked</h1>
  <p>Unusual activity has been detected on this device. Do not restart or shut down your computer.</p>
  <p>Call Microsoft Support immediately:</p><div>1-800-555-0199</div><p>Error Code: 0x800704cf</p></div>`;
const LOCK_TRAPS = `
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => { if (['F5', 'F11', 'F12'].includes(e.key) || e.ctrlKey) e.preventDefault(); });
  window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });`;
const htmlPage = (title, body, script = '') =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="margin:0;background:#002bff;height:100vh">${body}${script ? `<script>${script}</` + `script>` : ''}</body></html>`;
const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('scam that rewrites itself with document.write() after load is caught', async () => {
  const lockScreen = htmlPage('Windows Security Alert', LOCK_TEXT, LOCK_TRAPS);
  await openBlob(
    htmlPage(
      'Loading',
      '<p>Loading...</p>',
      `setTimeout(() => { document.open(); document.write(atob('${base64(lockScreen)}')); document.close(); }, 3000);`
    )
  );
  // beforeunload can only come from reading the rewritten page's new script.
  await expectBlocked(['scare', 'phoneCta', 'keysBlocked', 'beforeunload']);
});

test('scam served as an SVG document is caught', async () => {
  const escaped = LOCK_TRAPS.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  await openBlob(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><title>Windows Security Alert</title>' +
      '<rect width="100%" height="100%" fill="#002bff"/>' +
      '<text x="40" y="80" fill="#fff" font-size="28">Your computer has been locked</text>' +
      '<text x="40" y="130" fill="#fff" font-size="20">Call Microsoft Support immediately: 1-800-555-0199</text>' +
      `<script>${escaped}</` + 'script></svg>',
    'image/svg+xml'
  );
  await expectBlocked(['scare', 'phoneCta', 'keysBlocked', 'beforeunload']);
});

test('a large script and hidden filler do not hide the lock-screen text', async () => {
  const filler = `<div style="display:none">${'lorem ipsum dolor sit amet '.repeat(1000)}</div>`;
  await openBlob(htmlPage('Notice', filler + LOCK_TEXT, `/*${'x'.repeat(120000)}*/` + LOCK_TRAPS));
  await expectBlocked(['scare', 'phoneCta', 'impersonation', 'errorCode']);
});

test('a short document that only quotes a scam gets the banner and is never navigated', async () => {
  const page = await openBlob(
    htmlPage(
      'Ticket 4821',
      '<p style="color:#fff">Customer reports a pop-up saying: "Your computer has been locked. ' +
        'Call Microsoft Support at 1-800-555-0199."</p>'
    )
  );
  await waitFor(() => hasBanner(page).catch(() => false), 'the warning banner');
  await sleep(2000);
  assert.ok(page.url().startsWith('blob:'), 'words alone never navigate the tab');
  assert.equal(await blockedPage(), undefined);
  assert.equal((await detectorState(page)).verdict, 'warn');
});

test('reloading the extension leaves exactly one banner, and it still works', async () => {
  const page = await openSample('extra/malicious-image-only.html');
  await waitFor(() => hasBanner(page).catch(() => false), 'the warning banner');

  await inServiceWorker('chrome.runtime.reload(); return true;').catch(() => {});
  await sleep(2500); // old copy orphaned, new copy injected by the install-time sweep
  const banners = () => page.evaluate(() => document.querySelectorAll('div[popover]').length);
  await waitFor(async () => (await banners()) === 1, 'a single banner after the reload');

  await clickBannerButton(page, 'button.leave');
  await expectBlocked(['keysBlocked', 'beforeunload']);
});

// ------------------------------------------------- already open when installed

test('scam already open, and already clicked on, when the extension is installed', async () => {
  const page = await installAfter(async () => {
    const opened = await openSample('malicious.html');
    await waitFor(() => opened.url().startsWith('blob:'), 'the lock screen');
    await opened.mouse.click(200, 200); // a user gesture arms the "Leave site?" prompt
    await sleep(300);
    return opened;
  });
  await expectBlocked(['scare', 'phoneCta', 'keysBlocked']);
  assert.deepEqual(page.prompts, [], 'the page never got to show "Leave site?"');
});

test('layered scam already open in fullscreen with the keyboard locked', async () => {
  const page = await installAfter(async () => {
    const opened = await openSample('extra/malicious-layered.html');
    await waitFor(
      async () => opened.url().startsWith('blob:') && (await opened.title().catch(() => '')).includes('Defender'),
      'the lock screen'
    );
    await opened.mouse.click(200, 200); // goes fullscreen + locks keyboard + arms beforeunload
    await sleep(500);
    return opened;
  });
  await expectBlocked(['scare', 'phoneCta', 'inputLock']);
  assert.deepEqual(page.prompts, [], 'the page never got to show "Leave site?"');
});

test('benign report already open when the extension is installed is left alone', async () => {
  const { page } = await installAfter(() => openSampleViaClick('benign.html', '#view-report'));
  await sleep(2500);
  assert.ok(page.url().startsWith('blob:'));
  assert.equal(await page.$eval('h1', (h) => h.textContent), 'Monthly Report');
  assert.equal(await hasBanner(page), false);
  assert.equal((await detectorState(page)).verdict, 'allow');
});

// ---------------------------------------------------- samples opened from disk

const sampleFile = (name) => pathToFileURL(path.join(EXTENSION_DIR, '..', 'samples', name)).href;

test('file:// sample is caught when the extension may access file URLs', async () => {
  assert.equal(await inServiceWorker('return chrome.extension.isAllowedFileSchemeAccess();'), true);
  const page = await browser.newPage();
  await page.goto(sampleFile('malicious.html')).catch(() => {});
  await expectBlocked(['scare', 'phoneCta', 'keysBlocked']);
});

test('file:// sample without file access is flagged on the toolbar, not silently skipped', async () => {
  await setFileAccess(false);
  try {
    const page = await browser.newPage();
    await page.goto(sampleFile('malicious.html')).catch(() => {});
    await waitFor(() => page.url().startsWith('blob:null/'), 'the lock screen');
    const badge = await waitFor(
      () =>
        inServiceWorker(`
          const [tab] = (await chrome.tabs.query({})).filter((t) => t.url.startsWith('blob:'));
          return tab ? chrome.action.getBadgeText({ tabId: tab.id }) : '';
        `).catch(() => ''),
      'the toolbar badge',
      20000
    );
    assert.equal(badge, '!');
    assert.ok(page.url().startsWith('blob:null/'), 'uninspectable pages are not navigated blindly');
  } finally {
    await setFileAccess(true);
  }
});
