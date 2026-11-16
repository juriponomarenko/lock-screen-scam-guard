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
 *   2. passive  - watch the user's own escape attempts and see if the page cancelled them
 *   3. probe    - fire synthetic F5/F11/F12, but only at a page whose text is already suspicious
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

  /** Keys a legitimate page has no reason to cancel. Escape is left out: modals use it. */
  const ESCAPE_KEYS = new Set(['F5', 'F11', 'F12']);
  const ESCAPE_CHORDS = new Set(['r', 'w', 'l', 't', 'n']);
  const TRAP_EVENTS = ['beforeunload', 'keydown', 'keyup', 'keypress', 'contextmenu'];
  const INLINE_HANDLERS = ['onbeforeunload', 'oncontextmenu', 'onkeydown', 'onkeyup', 'onkeypress'];

  const observed = { keysBlocked: false, contextMenuBlocked: false };
  /** Trap code seen so far. Sticky: handlers outlive a script tag the page removes. */
  const seenCode = {};
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

  function inlineScriptText() {
    let js = '';
    for (const script of document.scripts) {
      if (script.src) continue;
      js += script.textContent + '\n';
      if (js.length > MAX_SCRIPT_CHARS) break;
    }
    const selector = INLINE_HANDLERS.map((name) => `[${name}]`).join(',');
    for (const element of document.querySelectorAll(selector)) {
      for (const name of INLINE_HANDLERS) {
        const code = element.getAttribute(name);
        if (code) js += `${name}="${code}"\n`;
      }
    }
    return js;
  }

  /**
   * innerText is the *visible* text (no script source, no display:none
   * padding), but it needs layout over the whole document. A generated report
   * can be megabytes, so past a size limit read only the leading text nodes.
   */
  function visibleText() {
    const body = document.body;
    if (!body) return '';
    if (body.textContent.length <= LARGE_DOCUMENT_CHARS) return body.innerText;

    const skipped = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let text = '';
    while (text.length < MAX_TEXT_CHARS && walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && !skipped.has(parent.tagName)) text += walker.currentNode.nodeValue + ' ';
    }
    return text;
  }

  function collectSignals() {
    const text = H.analyzeText(`${document.title}\n${visibleText()}`);
    for (const [name, found] of Object.entries(H.analyzeScripts(inlineScriptText()))) {
      if (found) seenCode[name] = true;
    }
    const code = seenCode;
    const scroller = document.scrollingElement || document.documentElement;
    const nav = globalThis.__lsgNav || {};
    return {
      impersonation: text.impersonation,
      scare: text.scare,
      phoneCta: text.phoneCta,
      errorCode: text.errorCode,
      keysBlocked: code.keysBlocked || observed.keysBlocked,
      contextMenuBlocked: code.contextMenuBlocked || observed.contextMenuBlocked,
      beforeunload: code.beforeunload,
      fullscreen: code.fullscreen || Boolean(document.fullscreenElement),
      inputLock: code.inputLock || Boolean(document.pointerLockElement),
      historyTrap: code.historyTrap,
      scriptedRedirect: Boolean(nav.scriptedRedirect),
      // Terse and not scrollable: looks like a lock screen, not a document.
      lockLayout:
        text.textLength <= H.LOCK_SCREEN_MAX_TEXT && scroller.scrollHeight <= window.innerHeight * 1.25,
    };
  }

  /** Layer 2: did the page cancel a real escape attempt by the user? */
  function watchEscapeAttempts() {
    const isEscapeKey = (event) =>
      ESCAPE_KEYS.has(event.key) ||
      ((event.ctrlKey || event.metaKey) && ESCAPE_CHORDS.has(String(event.key).toLowerCase()));

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

    const suspiciousText = signals.scare || signals.impersonation || signals.phoneCta;
    if (result.verdict !== 'block' && suspiciousText && !signals.keysBlocked && probes < MAX_PROBES) {
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
    if (banner) return;

    const host = document.createElement('div');
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
    evaluate();
    if (blocked) return;

    // Content injected after load (a common way to dodge a one-shot scan).
    observer = new MutationObserver(scheduleEvaluation);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
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
