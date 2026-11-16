/**
 * Service worker: decides *where* the detector runs and carries out the escape.
 *
 * It is only ever woken by (a) a top-level navigation to a blob: URL or (b) a
 * message from the detector, so ordinary browsing costs nothing: no content
 * script is injected into normal pages and this worker stays asleep.
 */
'use strict';

const BLOB = 'blob:';
const BLOCKED_PAGE = chrome.runtime.getURL('blocked.html');
const NAVIGATION_TIMEOUT_MS = 1500;
const POLL_MS = 100;

const isBlob = (url) => typeof url === 'string' && url.startsWith(BLOB);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------- injection

/**
 * Run the detector in a tab's top-level document.
 * @param {number} tabId
 * @param {{scriptedRedirect?: boolean}} nav what the navigation looked like, if known
 */
async function inject(tabId, nav) {
  const target = { tabId, frameIds: [0] };
  try {
    await chrome.scripting.executeScript({
      target,
      injectImmediately: true,
      func: (context) => {
        globalThis.__lsgNav = Object.assign(globalThis.__lsgNav || {}, context);
      },
      args: [nav],
    });
    await chrome.scripting.executeScript({
      target,
      injectImmediately: true,
      files: ['heuristics.js', 'detector.js'],
    });
  } catch (error) {
    // The tab closed or navigated on, or the origin is off limits.
    console.debug('[lock-screen-scam-guard] not inspected:', error.message);
    await flagIfFileAccessIsOff(tabId).catch(() => {});
  }
}

/**
 * A blob: document created by a file:// page ("blob:null/...") can only be
 * inspected when the user has turned on "Allow access to file URLs". Say so on
 * the toolbar icon rather than failing silently.
 */
async function flagIfFileAccessIsOff(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url || !tab.url.startsWith('blob:null/')) return;
  if (await chrome.extension.isAllowedFileSchemeAccess()) return;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b00020' });
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setTitle({
    tabId,
    title:
      'Lock-Screen Scam Guard could not inspect this page. If it was opened from a local file, ' +
      'turn on "Allow access to file URLs" in the extension\'s details.',
  });
}

// Arriving fresh: every top-level commit of a blob: document.
chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0 || !isBlob(details.url)) return;
    inject(details.tabId, {
      // Reached by script with no user gesture, the way malicious.html does it.
      scriptedRedirect: details.transitionQualifiers.includes('client_redirect'),
    });
  },
  { url: [{ urlPrefix: BLOB }] }
);

/**
 * Already on the page: content scripts are not retro-fitted into open tabs, so
 * sweep them once per extension session. storage.session is wiped on install,
 * update, reload, re-enable and browser start, which is exactly when a sweep
 * is needed, and it survives this worker going to sleep.
 */
async function sweepOpenTabsOnce() {
  const { swept } = await chrome.storage.session.get('swept');
  if (swept) return;
  await chrome.storage.session.set({ swept: true });
  const tabs = await chrome.tabs.query({});
  // Discarded tabs have no document to inspect; they are checked when they reload.
  const open = tabs.filter((tab) => isBlob(tab.url) && !tab.discarded);
  await Promise.all(open.map((tab) => inject(tab.id, {})));
}
sweepOpenTabsOnce().catch((error) => console.debug('[lock-screen-scam-guard] sweep failed:', error.message));

// ----------------------------------------------------------------- response

function blockedPageUrl(reasons, automatic) {
  const params = new URLSearchParams({
    why: Array.isArray(reasons) ? reasons.join(',') : '',
    auto: automatic ? '1' : '0',
  });
  return `${BLOCKED_PAGE}#${params}`;
}

/** Resolves true once the tab has left its blob: document (or is gone). */
async function hasLeft(tabId) {
  for (let waited = 0; waited < NAVIGATION_TIMEOUT_MS; waited += POLL_MS) {
    await sleep(POLL_MS);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !isBlob(tab.url)) return true;
  }
  return false;
}

/**
 * Get the user out. Done from here because nothing a page does (key blocking,
 * right-click blocking, history tricks, fullscreen) can stop the tabs API.
 *
 * The one thing a page can still do is answer a navigation with a "Leave
 * site?" prompt, which Chrome only shows once the user has interacted with the
 * page. So:
 *   - no interaction yet -> a plain navigation cannot be held; use it
 *   - interaction        -> skip straight to the path that runs no page code
 *
 * @param {boolean} mayPrompt the page has had a user gesture
 */
async function leave(tabId, reasons, automatic, mayPrompt) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isBlob(tab.url)) return; // the user already got out

  const url = blockedPageUrl(reasons, automatic);
  if (!mayPrompt) {
    await chrome.tabs.update(tabId, { url }).catch(() => {});
    if (await hasLeft(tabId)) return;
    // Held after all: the user clicked in the gap. Fall through.
  }
  await forceLeave(tab, url);
}

/**
 * Leave without giving the page a say. Discarding a tab throws its document
 * away without running unload handlers, so no prompt can appear.
 *
 * tabs.remove() is deliberately not used on a live trapped tab: it raises the
 * page's prompt, stays pending, and pulls focus back to the scam.
 */
async function forceLeave(tab, url) {
  let discarded = await chrome.tabs.discard(tab.id).catch(() => null);
  if (discarded) {
    await chrome.tabs.update(discarded.id, { url, active: true }).catch(() => {});
    return;
  }

  // Chrome would not discard the tab in place (it can refuse for the tab the
  // user is looking at). Move the user to safety first, then drop the old tab.
  await chrome.tabs.create({ url, windowId: tab.windowId, index: tab.index + 1, active: true });
  discarded = await chrome.tabs.discard(tab.id).catch(() => null);
  if (discarded) await chrome.tabs.remove(discarded.id).catch(() => {});
  // If even that failed the tab stays behind in the background, already
  // disarmed by the detector and showing its "Leave this page" banner.
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fromOurDetector = sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0;
  if (!fromOurDetector || !message || message.type !== 'lsg:leave') return;
  leave(sender.tab.id, message.reasons, Boolean(message.automatic), Boolean(message.mayPrompt)).finally(() =>
    sendResponse()
  );
  return true; // keep the worker alive until the tab is safe
});
