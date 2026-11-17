/**
 * Detector: the content script.
 *
 * The service worker injects this (after heuristics.js) into top-level blob:
 * documents only, so ordinary pages never run a line of it. It gathers
 * evidence from the document, asks the pure heuristics for a verdict, and:
 *
 *   block -> disarms the page's traps and asks the service worker to navigate away
 *   warn  -> shows a dismissible banner with a "Leave this page" button
 *   allow -> does nothing at all
 *
 * Evidence about trapping comes from three layers, cheapest and least
 * intrusive first:
 *   1. static   - read the page's inline scripts (works on an already-open page)
 *   2. passive  - when the user presses F5/F11/F12 or right-clicks, see if the page cancelled it
 *   3. probe    - fire synthetic F5/F11/F12, but only at a page that claims the device is locked
 */
(() => {
  'use strict';

  if (globalThis.__lsgDetector) {
    // Injected twice: the install-time sweep raced a navigation. The second
    // injection may have brought navigation context, so look again.
    globalThis.__lsgDetector.recheck();
    return;
  }
  globalThis.__lsgDetector = { recheck: () => {} };
  if (location.protocol !== 'blob:' || window.top !== window) return;

  const H = globalThis.LSGHeuristics;

  const OBSERVE_MS = 15000; // how long late-arriving content is watched for
  const DEBOUNCE_MS = 200;
  const MAX_EVALUATIONS = 40;
  const MAX_PROBES = 3;
  const MAX_SCRIPT_CHARS = 200000;
  const MAX_TEXT_CHARS = 20000;
  const LARGE_DOCUMENT_CHARS = 100000;
  const FALLBACK_BANNER_MS = 3000;

  /**
   * Keys a legitimate page has no reason to cancel. Escape is left out (modals
   * use it) and so are Ctrl chords (editors and terminals bind Ctrl+L, Ctrl+R).
   */
  const ESCAPE_KEYS = new Set(['F5', 'F11', 'F12']);
  /** Elements whose text is source code, not page content. */
  const NON_CONTENT = new Set(['script', 'style', 'noscript', 'template']);
  const BANNER_MARK = 'data-lsg-banner';
  const TRAP_EVENTS = ['beforeunload', 'keydown', 'keyup', 'keypress', 'contextmenu'];
  const INLINE_HANDLERS = ['onbeforeunload', 'oncontextmenu', 'onkeydown', 'onkeyup', 'onkeypress'];

  const observed = { keysBlocked: false, contextMenuBlocked: false };
  /** Inline code read so far, and what the heuristics make of it. */
  const readScripts = new WeakSet();
  const readHandlers = new Set();
  let codeSeen = '';
  let seenCode = {};
  let evaluations = 0;
  let probes = 0;
  let debounce = 0;
  let observer = null;
  let blocked = false;
  let disarmed = false;
  let dismissed = false;
  let banner = null;
  let lastReasons = [];

  // ------------------------------------------------------------- evidence

  /**
   * Static look at the page's own code. Source is accumulated as it is first
   * seen and never dropped, so a script tag the page removes after running
   * still counts, and nothing is re-read unless new code has appeared.
   */
  function scanCode() {
    let added = '';
    // querySelectorAll rather than document.scripts: it also finds SVG <script>.
    for (const script of document.querySelectorAll('script')) {
      if (readScripts.has(script)) continue;
      readScripts.add(script);
      if (!script.src) added += script.textContent + '\n';
    }
    for (const element of document.querySelectorAll(INLINE_HANDLERS.map((name) => `[${name}]`).join(','))) {
      for (const name of INLINE_HANDLERS) {
        const handler = element.hasAttribute(name) ? `${name}="${element.getAttribute(name)}"\n` : '';
        if (handler && !readHandlers.has(handler)) {
          readHandlers.add(handler);
          added += handler;
        }
      }
    }
    if (!added || codeSeen.length >= MAX_SCRIPT_CHARS) return;
    codeSeen = (codeSeen + added).slice(0, MAX_SCRIPT_CHARS);
    seenCode = H.analyzeScripts(codeSeen);
  }

  /** Text nodes that are page content (not script or style source), in document order. */
  function* contentTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && !NON_CONTENT.has(parent.localName)) yield walker.currentNode;
    }
  }

  /**
   * The text a user can see. innerText gives exactly that (no script source,
   * no display:none padding) but lays out the whole document, and a generated
   * report can be megabytes. So measure first, and past the limit read only
   * the leading rendered text nodes. Non-HTML documents (SVG) have no
   * innerText and always take the second path.
   */
  function visibleText() {
    const root = document.body || document.documentElement;
    if (!root) return '';

    if (typeof root.innerText === 'string') {
      let size = 0;
      for (const node of contentTextNodes(root)) {
        size += node.length;
        if (size > LARGE_DOCUMENT_CHARS) break;
      }
      if (size <= LARGE_DOCUMENT_CHARS) return root.innerText;
    }

    let text = '';
    for (const node of contentTextNodes(root)) {
      if (!node.parentElement.checkVisibility()) continue;
      text += node.nodeValue + ' ';
      if (text.length >= MAX_TEXT_CHARS) break;
    }
    return text;
  }

  function collectSignals() {
    const text = H.analyzeText(`${document.title}\n${visibleText()}`);
    scanCode();
    const nav = globalThis.__lsgNav || {};
    return {
      impersonation: text.impersonation,
      scare: text.scare,
      phoneCta: text.phoneCta,
      errorCode: text.errorCode,
      keysBlocked: Boolean(seenCode.keysBlocked || observed.keysBlocked),
      contextMenuBlocked: Boolean(seenCode.contextMenuBlocked || observed.contextMenuBlocked),
      beforeunload: Boolean(seenCode.beforeunload),
      fullscreen: Boolean(seenCode.fullscreen || document.fullscreenElement),
      inputLock: Boolean(seenCode.inputLock || document.pointerLockElement),
      historyTrap: Boolean(seenCode.historyTrap),
      scriptedRedirect: Boolean(nav.scriptedRedirect),
    };
  }

  /** Layer 2: did the page cancel a real escape attempt by the user? */
  function watchEscapeAttempts() {
    const isEscapeKey = (event) => ESCAPE_KEYS.has(event.key);

    const watch = (type, matches, flag) => {
      window.addEventListener(
        type,
        (event) => {
          if (!event.isTrusted || observed[flag] || disarmed || !matches(event)) return;
          // Look after dispatch has finished, i.e. after the page's handlers ran.
          setTimeout(() => {
            if (!event.defaultPrevented) return;
            observed[flag] = true;
            evaluate(true);
          }, 0);
        },
        true
      );
    };
    watch('keydown', isEscapeKey, 'keysBlocked');
    watch('contextmenu', () => true, 'contextMenuBlocked');
  }

  /**
   * Layer 3: synthetic reload / fullscreen / devtools keys. Untrusted events
   * trigger no browser default, so all that can happen is the page cancelling
   * them. Limited to keys an ordinary page does not act on: no Ctrl chords (an
   * editor might handle them) and no right-click (a custom menu would pop up).
   */
  function probe() {
    probes += 1;
    const target = document.body || document.documentElement;
    const cancelled = (key, keyCode) =>
      !target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code: key,
          keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
    observed.keysBlocked = cancelled('F5', 116) || cancelled('F12', 123) || cancelled('F11', 122);
  }

  // -------------------------------------------------------------- verdict

  function evaluate(force = false) {
    if (blocked) return;
    if (!force && ++evaluations > MAX_EVALUATIONS) return;

    const startedAt = performance.now();
    let signals = collectSignals();
    let result = H.score(signals);

    // Probe only a page that already claims the device is locked or infected.
    // A vendor name or a phone number alone (an invoice) is not enough to poke it.
    if (result.verdict !== 'block' && signals.scare && !signals.keysBlocked && probes < MAX_PROBES) {
      probe();
      signals = collectSignals();
      result = H.score(signals);
    }

    lastReasons = result.reasons;
    // Diagnostics, readable only from this extension's isolated world (tests,
    // or DevTools with the extension's context selected).
    Object.assign(globalThis.__lsgDetector, {
      verdict: result.verdict,
      score: result.total,
      reasons: result.reasons,
      evaluations,
      lastEvaluationMs: performance.now() - startedAt,
    });

    if (result.verdict === 'block') {
      blocked = true;
      stopObserving();
      hideBanner();
      requestLeave(result.reasons, true);
      // If the tab somehow is still here, give the user a manual way out.
      setTimeout(() => showBanner(result.reasons), FALLBACK_BANNER_MS);
    } else if (result.verdict === 'warn' && !dismissed) {
      showBanner(result.reasons);
    }
  }

  function scheduleEvaluation() {
    if (blocked || debounce) return;
    debounce = setTimeout(() => {
      debounce = 0;
      evaluate();
    }, DEBOUNCE_MS);
  }

  function stopObserving() {
    if (observer) observer.disconnect();
    observer = null;
  }

  // ------------------------------------------------------------- response

  /**
   * Take the page's traps apart so the user's own keys and right-click work
   * again. A capturing listener on `window` runs before anything the page
   * registered on document or body, so stopping propagation here means those
   * handlers never see the event.
   *
   * This cannot be relied on for beforeunload: that event is delivered to
   * window directly and listeners run in registration order, so the page's
   * handler (registered first) still runs. The service worker deals with that.
   */
  function disarm() {
    if (disarmed) return;
    disarmed = true;
    const swallow = (event) => event.stopImmediatePropagation();
    for (const type of TRAP_EVENTS) window.addEventListener(type, swallow, true);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (document.pointerLockElement) document.exitPointerLock();
    if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  }

  function requestLeave(reasons, automatic) {
    disarm();
    // Chrome only lets a page hold a navigation with "Leave site?" after a user
    // gesture. Tell the worker, so it can pick a path that shows no prompt.
    const mayPrompt = Boolean(navigator.userActivation && navigator.userActivation.hasBeenActive);
    try {
      chrome.runtime.sendMessage({ type: 'lsg:leave', automatic, reasons, mayPrompt }).catch(() => {});
    } catch {
      // The extension was reloaded and this copy of the script is orphaned.
    }
  }

  function hideBanner() {
    if (banner) banner.remove();
    banner = null;
  }

  function showBanner(reasons) {
    // An HTML banner does not render inside an SVG or XML document.
    if (banner || !document.body) return;

    const host = document.createElement('div');
    host.setAttribute(BANNER_MARK, '');
    // Popover puts the banner in the top layer: above any z-index and above a
    // fullscreen element. The inline !important rules undo the popover defaults.
    host.setAttribute('popover', 'manual');
    host.setAttribute(
      'style',
      [
        'all: initial',
        'display: block',
        'position: fixed',
        'inset: 0 0 auto 0',
        'width: auto',
        'height: auto',
        'margin: 0',
        'padding: 0',
        'border: 0',
        'background: transparent',
        'overflow: visible',
        'z-index: 2147483647',
      ]
        .map((rule) => `${rule} !important`)
        .join('; ')
    );

    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
             padding: 12px 16px; background: #1f2933; color: #fff;
             font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
             box-shadow: 0 2px 12px rgba(0, 0, 0, .45); cursor: default; }
      .text { flex: 1 1 320px; }
      strong { color: #ffd166; }
      button { font: inherit; padding: 6px 14px; border-radius: 6px; cursor: pointer;
               border: 1px solid #fff; background: transparent; color: #fff; }
      button.leave { background: #ffd166; border-color: #ffd166; color: #1f2933; font-weight: 600; }
    `;

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'alert');

    const text = document.createElement('div');
    text.className = 'text';
    const lead = document.createElement('strong');
    lead.textContent = 'This page shows signs of a fake "computer locked" scam. ';
    text.append(lead, 'Your device is not locked. Do not call any number shown here.');

    const leave = document.createElement('button');
    leave.className = 'leave';
    leave.textContent = 'Leave this page';
    leave.addEventListener('click', () => requestLeave(reasons, false));

    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      dismissed = true;
      hideBanner();
    });

    bar.append(text, leave, dismiss);
    shadow.append(style, bar);
    document.documentElement.append(host);
    banner = host;
    raiseBanner();
  }

  /**
   * (Re-)enter the top layer. Needed again when the page goes fullscreen,
   * because the fullscreen element is stacked above anything shown before it.
   */
  function raiseBanner() {
    if (!banner) return;
    try {
      if (banner.matches(':popover-open')) banner.hidePopover();
      banner.showPopover();
    } catch {
      // No popover support: the fixed position and z-index still apply.
    }
  }

  // ---------------------------------------------------------------- start

  function start() {
    globalThis.__lsgDetector.recheck = () => evaluate(true);
    // After an extension reload the previous copy of this script is orphaned in
    // its own isolated world. Its banner can no longer reach the worker; drop it.
    for (const stale of document.querySelectorAll(`[${BANNER_MARK}]`)) stale.remove();
    evaluate();
    if (blocked) return;

    // Content injected or revealed after load (a common way to dodge a
    // one-shot scan). Watch the document node, not the root element:
    // document.write() and root replacement swap the root element out.
    // Attribute observation is limited to the ones that change visibility,
    // so unrelated attribute churn does not trigger rescans.
    observer = new MutationObserver(scheduleEvaluation);
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'class', 'style'],
    });
    setTimeout(stopObserving, OBSERVE_MS);

    // Handlers registered late: look again once the page has settled.
    const settled = () => setTimeout(evaluate, 1500);
    if (document.readyState === 'complete') settled();
    else window.addEventListener('load', settled, { once: true });

    // After the observation window these keep the detector event-driven.
    document.addEventListener('fullscreenchange', () => {
      evaluate(true);
      raiseBanner();
    });
    document.addEventListener('pointerlockchange', () => evaluate(true));
  }

  watchEscapeAttempts();

  // Back/forward cache can bring a blocked page back with this script still alive.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && blocked) requestLeave(lastReasons, true);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
