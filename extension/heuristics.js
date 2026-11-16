/**
 * Pure detection heuristics: strings and booleans in, a verdict out.
 *
 * No DOM and no extension APIs, so this one file runs unchanged as a content
 * script (it defines `LSGHeuristics`) and under Node for unit tests.
 *
 * Evidence comes in three independent kinds:
 *   - deception: the page claims the device is locked / infected
 *   - hook:      it pushes a phone number to call
 *   - trap:      it blocks the ways a user would normally leave
 *
 * One kind on its own is something legitimate pages do every day (an invoice
 * has a phone number, an editor has an "unsaved changes" prompt). The verdict
 * therefore needs two kinds to agree before the tab is ever touched.
 */
(function (root) {
  'use strict';

  const WEIGHTS = Object.freeze({
    // Deceptive content
    phoneCta: 3,
    impersonation: 2,
    scare: 2,
    errorCode: 1,
    // Trapping behaviour
    keysBlocked: 3,
    inputLock: 3,
    beforeunload: 2,
    fullscreen: 2,
    contextMenuBlocked: 1,
    historyTrap: 1,
    // How the document got here
    scriptedRedirect: 1,
  });

  const CONTENT_KEYS = ['phoneCta', 'impersonation', 'scare', 'errorCode'];
  const TRAP_KEYS = [
    'keysBlocked',
    'inputLock',
    'beforeunload',
    'fullscreen',
    'contextMenuBlocked',
    'historyTrap',
  ];

  const THRESHOLDS = Object.freeze({
    block: 6, // total score needed to navigate the tab away
    warn: 5, // total score needed to show the dismissible banner
    trapKind: 3, // trap score that counts as "this page is trapping the user"
    heavyTrap: 6, // trap score that earns a banner with no other evidence
  });

  const MAX_TEXT = 20000;
  const MAX_SCRIPT = 200000;
  /** A lock screen is terse; a document about scams is not. */
  const LOCK_SCREEN_MAX_TEXT = 1500;

  // ---------------------------------------------------------------- content

  const ZERO_WIDTH = /[­​-‍⁠﻿]/g;

  function normalizeText(text) {
    return String(text || '')
      .slice(0, MAX_TEXT)
      .normalize('NFKC')
      .replace(ZERO_WIDTH, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const BRAND = '(?:microsoft|windows|apple|mac\\s?os|icloud|defender|google|chrome|norton|mcafee)';
  const AUTHORITY =
    '(?:support|security|defender|firewall|technicians?|help\\s?desk|helpline|alert|warning|certified|official)';
  /** A vendor name used as an authority ("Windows Security Alert"), not a bare mention. */
  const IMPERSONATION = new RegExp(
    `\\b${BRAND}\\b[^.!?]{0,40}\\b${AUTHORITY}\\b|\\b${AUTHORITY}\\b[^.!?]{0,40}\\b${BRAND}\\b`,
    'i'
  );

  const SCARE = [
    // "Your computer has been locked", "this device is infected"
    /\b(?:computer|pc|device|system|mac|laptop|browser|windows|screen|account|iphone|phone)\b[^.!?]{0,40}\b(?:locked|blocked|infected|compromised|hacked|disabled|suspended|at risk|in danger)\b/i,
    // "Do not restart or shut down"
    /\b(?:do not|don'?t|never)\b[^.!?]{0,15}\b(?:restart|reboot|shut\s?down|turn off|power off|close|ignore)\b/i,
    // "Trojan spyware detected"
    /\b(?:virus(?:es)?|trojans?|spyware|malware|ransomware|threats?)\b[^.!?]{0,30}\b(?:detected|found|identified|alert)\b/i,
    // "Unusual activity"
    /\b(?:unusual|suspicious|illegal|unauthori[sz]ed)\s+(?:activity|access|sign[- ]?in|log[- ]?in)\b/i,
    // "Your personal files may be at risk"
    /\b(?:files|data|information|passwords?|photos|identity|banking details)\b[^.!?]{0,30}\b(?:at risk|stolen|compromised|exposed|being (?:stolen|tracked))\b/i,
  ];

  const PHONE =
    /(?<![\d.])(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.\-]\d{3,4}[\s.\-]\d{3,4}\b|\b1?8(?:00|33|44|55|66|77|88)\d{7}\b/g;
  const CALL_TO_ACTION =
    /\b(?:call|dial|contact|phone|ring|speak|talk|reach)\b|\b(?:support|helpline|toll[\s-]?free|technician|help\s?desk)\b/i;

  /** A phone number with "call / contact / support" wording right next to it. */
  function hasPhoneCta(text) {
    for (const match of text.matchAll(PHONE)) {
      const digits = match[0].replace(/\D/g, '').length;
      if (digits < 9 || digits > 15) continue;
      const context = text.slice(Math.max(0, match.index - 120), match.index + match[0].length + 60);
      if (CALL_TO_ACTION.test(context)) return true;
    }
    return false;
  }

  const ERROR_CODE = /\b0x[0-9a-f]{4,10}\b|\b(?:error|stop)\s+code\b/i;

  /** @param {string} rawText page title plus visible text */
  function analyzeText(rawText) {
    const text = normalizeText(rawText);
    return {
      impersonation: IMPERSONATION.test(text),
      scare: SCARE.some((pattern) => pattern.test(text)),
      phoneCta: hasPhoneCta(text),
      errorCode: ERROR_CODE.test(text),
      textLength: text.length,
    };
  }

  // ------------------------------------------------------------------ traps

  /**
   * Static look at the page's own inline script for escape-blocking code.
   * Deliberately narrow: an app that handles Ctrl+S must not look like a trap,
   * so the key signal needs the reload / fullscreen / devtools keys by name.
   *
   * @param {string} rawJs concatenated inline scripts and inline handler attributes
   */
  function analyzeScripts(rawJs) {
    const js = String(rawJs || '').slice(0, MAX_SCRIPT);
    const cancels = /preventDefault\s*\(|return\s+false|returnValue\s*=/.test(js);
    const listensForKeys = /key(?:down|up|press)/.test(js);
    const namesEscapeKeys =
      /['"`]F(?:5|11|12)['"`]/.test(js) || (/\b(?:keyCode|which)\b/.test(js) && /\b(?:116|122|123)\b/.test(js));
    return {
      keysBlocked: listensForKeys && namesEscapeKeys && cancels,
      beforeunload: /\bonbeforeunload\b|['"`]beforeunload['"`]/.test(js),
      contextMenuBlocked: /\boncontextmenu\b|['"`]contextmenu['"`]/.test(js) && cancels,
      fullscreen: /\b(?:webkit|moz|ms)?[rR]equestFull[sS]creen\b/.test(js),
      inputLock: /\bkeyboard\s*\.\s*lock\s*\(|\brequestPointerLock\b/.test(js),
      historyTrap: /\bpushState\s*\(/.test(js) && /\bonpopstate\b|['"`]popstate['"`]/.test(js),
    };
  }

  // ---------------------------------------------------------------- verdict

  function sum(signals, keys, reasons) {
    let total = 0;
    for (const key of keys) {
      if (signals[key]) {
        total += WEIGHTS[key];
        reasons.push(key);
      }
    }
    return total;
  }

  /**
   * @param {object} signals booleans named after WEIGHTS, plus `lockLayout`
   * @returns {{verdict: 'allow'|'warn'|'block', total: number, content: number,
   *            trap: number, kinds: number, reasons: string[]}}
   */
  function score(signals) {
    const s = signals || {};
    const reasons = [];
    const content = sum(s, CONTENT_KEYS, reasons);
    const trap = sum(s, TRAP_KEYS, reasons);
    const provenance = sum(s, ['scriptedRedirect'], reasons);
    const total = content + trap + provenance;

    const trapped = trap >= THRESHOLDS.trapKind;
    // A vendor name alone is not deception (invoices and help pages name
    // Microsoft too) unless the page is also trapping the user.
    const deceptive = Boolean(s.scare || (s.impersonation && trapped));
    const hooked = Boolean(s.phoneCta);
    const kinds = Number(deceptive) + Number(hooked) + Number(trapped);

    let verdict = 'allow';
    if (total >= THRESHOLDS.block && kinds >= 2 && (trapped || s.lockLayout)) {
      // Without trap evidence, only block something that looks like a lock
      // screen (terse, fills the viewport) rather than a document.
      verdict = 'block';
    } else if ((total >= THRESHOLDS.warn && kinds >= 2) || trap >= THRESHOLDS.heavyTrap) {
      verdict = 'warn';
    }
    return { verdict, total, content, trap, kinds, reasons };
  }

  const api = Object.freeze({
    WEIGHTS,
    THRESHOLDS,
    LOCK_SCREEN_MAX_TEXT,
    normalizeText,
    analyzeText,
    analyzeScripts,
    score,
  });

  root.LSGHeuristics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
