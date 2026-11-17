'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../extension/heuristics.js');

// Visible text of samples/malicious.html (title + body).
const SCAM_TEXT = `Windows Security Alert
  Your computer has been locked
  Unusual activity has been detected on this device. Your IP address and personal files may be at risk.
  Do not restart or shut down your computer.
  Call Microsoft Support immediately:
  1-800-555-0199
  Error Code: 0x800704cf`;

// Inline script of samples/malicious.html.
const SCAM_SCRIPT = `
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    const blocked = ['F5', 'F11', 'F12', 'Escape'];
    if (blocked.includes(e.key) || (e.ctrlKey && ['r', 'w', 'l'].includes(e.key.toLowerCase()))) {
      e.preventDefault();
    }
  });
  window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });`;

// Visible text of the blob document samples/benign.html opens.
const REPORT_TEXT = `Monthly Report
  Monthly Report Generated on: Mon Nov 16 2026
  Item Value Sessions 1,204 Conversions 87`;

const signals = (text, script, extra = {}) => ({
  ...H.analyzeText(text),
  ...H.analyzeScripts(script),
  ...extra,
});

test('text: the provided scam page shows every content signal', () => {
  const t = H.analyzeText(SCAM_TEXT);
  assert.deepEqual(
    { impersonation: t.impersonation, scare: t.scare, phoneCta: t.phoneCta, errorCode: t.errorCode },
    { impersonation: true, scare: true, phoneCta: true, errorCode: true }
  );
});

test('text: the provided benign report shows none', () => {
  const t = H.analyzeText(REPORT_TEXT);
  assert.deepEqual(
    { impersonation: t.impersonation, scare: t.scare, phoneCta: t.phoneCta, errorCode: t.errorCode },
    { impersonation: false, scare: false, phoneCta: false, errorCode: false }
  );
});

test('text: phone numbers need call-to-action wording next to them', () => {
  const hook = (text) => H.analyzeText(text).phoneCta;
  assert.equal(hook('Call support now: 1-800-555-0199'), true);
  assert.equal(hook('Contact Apple Support: (800) 555-0123'), true);
  assert.equal(hook('Dial +44 20 7946 0958 to speak to a technician'), true);
  assert.equal(hook('Toll free helpline 18005550199'), true);
  assert.equal(hook('Order reference 1-800-555-0199 shipped'), false, 'number without wording');
  assert.equal(hook('Call us on Monday. Report dated 2026-11-16.'), false, 'a date is not a phone number');
  assert.equal(hook('Contact the server at 192.168.1.1 for details'), false, 'an IP is not a phone number');
  assert.equal(hook('Contact support if 192.168.100.200 is unreachable'), false, 'nor is one with long octets');
  assert.equal(hook('Call me maybe. Sessions 1,204 Conversions 87'), false, 'plain figures');
});

test('text: a bare vendor name is not impersonation', () => {
  const imp = (text) => H.analyzeText(text).impersonation;
  assert.equal(imp('Windows Security Alert'), true);
  assert.equal(imp('Call Apple Support'), true);
  assert.equal(imp('Apple sales rose 4% this quarter'), false);
  assert.equal(imp('We replaced the windows in the east wing'), false);
});

test('text: zero-width characters, full-width letters and curly quotes do not hide wording', () => {
  const zwsp = String.fromCharCode(0x200b);
  const zwj = String.fromCharCode(0x200d);
  const fullWidthC = String.fromCharCode(0xff23);
  const curly = String.fromCharCode(0x2019);
  const sneaky = `Your com${zwsp}puter has been lo${zwj}cked. ${fullWidthC}all Microsoft Support 1-800-555-0199`;
  assert.equal(H.analyzeText(sneaky).scare, true);
  assert.equal(H.analyzeText(sneaky).phoneCta, true);
  assert.equal(H.analyzeText(`Don${curly}t restart your computer`).scare, true);
});

test('text: billing wording about an account is not a device-lock claim', () => {
  assert.equal(H.analyzeText('Your account has been suspended until the invoice is paid').scare, false);
  assert.equal(H.analyzeText('Your computer has been locked').scare, true);
});

test('scripts: the provided scam script is recognised as trapping', () => {
  const s = H.analyzeScripts(SCAM_SCRIPT);
  assert.equal(s.keysBlocked, true);
  assert.equal(s.beforeunload, true);
  assert.equal(s.contextMenuBlocked, true);
  assert.equal(s.fullscreen, false);
  assert.equal(s.inputLock, false);
});

test('scripts: an app shortcut such as Ctrl+S is not a key trap', () => {
  const editor = `
    window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });
    document.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e); });
    document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); } });`;
  const s = H.analyzeScripts(editor);
  assert.equal(s.keysBlocked, false);
  assert.equal(s.beforeunload, true);
  assert.equal(s.contextMenuBlocked, true);
});

test('scripts: legacy keyCode checks and inline handlers are recognised', () => {
  assert.equal(
    H.analyzeScripts('document.onkeydown = function (e) { if (e.keyCode == 116 || e.keyCode == 123) return false; }')
      .keysBlocked,
    true
  );
  assert.equal(H.analyzeScripts('oncontextmenu="return false"').contextMenuBlocked, true);
  assert.equal(H.analyzeScripts('el.requestFullscreen(); navigator.keyboard.lock();').inputLock, true);
});

test('verdict: provided scam page is blocked with the full score', () => {
  const r = H.score(signals(SCAM_TEXT, SCAM_SCRIPT, { scriptedRedirect: true }));
  assert.equal(r.verdict, 'block');
  assert.equal(r.total, 15);
  assert.equal(r.kinds, 3);
});

test('verdict: provided scam page is still blocked when found already open', () => {
  // No navigation data on the install-time sweep.
  const r = H.score(signals(SCAM_TEXT, SCAM_SCRIPT));
  assert.equal(r.verdict, 'block');
});

test('verdict: provided benign report is allowed with a score of zero', () => {
  const r = H.score(signals(REPORT_TEXT, ''));
  assert.equal(r.verdict, 'allow');
  assert.equal(r.total, 0);
});

test('verdict: one kind of evidence is never enough', () => {
  const allow = (s, why) => assert.equal(H.score(s).verdict, 'allow', why);
  allow({ phoneCta: true, impersonation: true }, 'invoice naming a vendor with a support line');
  allow({ phoneCta: true, impersonation: true, errorCode: true }, 'vendor error page with a helpline');
  allow({ beforeunload: true, contextMenuBlocked: true }, 'editor with unsaved-changes prompt and custom menu');
  allow({ fullscreen: true, beforeunload: true }, 'presentation viewer');
  allow({ scare: true, impersonation: true }, 'antivirus scan report');
  allow({ keysBlocked: true, scriptedRedirect: true }, 'page that only disables F12');
});

test('verdict: words alone never navigate the tab, however scam-like', () => {
  const text = { scare: true, phoneCta: true, impersonation: true, errorCode: true, scriptedRedirect: true };
  assert.equal(H.score(text).verdict, 'warn');
  assert.equal(H.score({ ...text, keysBlocked: true }).verdict, 'block');
});

test('verdict: text-only scam evidence warns even with every content signal', () => {
  const r = H.score(signals(SCAM_TEXT, ''));
  assert.equal(r.verdict, 'warn');
  assert.equal(r.trap, 0);
  assert.equal(r.content, 8);
});

test('verdict: a short awareness leaflet quoting the scam is only warned', () => {
  const leaflet = 'Recognize a tech-support scam. A fake warning may say: "Windows Security Alert. ' +
    'Your computer has been locked. Call Microsoft Support at 1-800-555-0199." ' +
    'This is a scam. Never call the number. Close the tab.';
  const r = H.score(signals(leaflet, ''));
  assert.equal(r.verdict, 'warn');
  assert.equal(r.total, 7);
  assert.equal(r.trap, 0);
});

test('verdict: weak trapping plus quoted scam text does not trigger automatic navigation', () => {
  const r = H.score(signals(SCAM_TEXT, "window.addEventListener('beforeunload', () => {});"));
  assert.equal(r.verdict, 'warn');
  assert.equal(r.trap, 2);
});

test('verdict: trapping alone warns, and only when it is heavy', () => {
  assert.equal(H.score({ keysBlocked: true, beforeunload: true }).verdict, 'allow');
  assert.equal(H.score({ keysBlocked: true, beforeunload: true, contextMenuBlocked: true }).verdict, 'warn');
});

test('verdict: vendor name plus trapping counts as deception', () => {
  const r = H.score({ impersonation: true, keysBlocked: true, beforeunload: true });
  assert.equal(r.verdict, 'block');
  assert.equal(r.kinds, 2);
});

test('verdict: reasons list exactly the signals that fired', () => {
  const r = H.score({ scare: true, phoneCta: true, keysBlocked: true });
  assert.deepEqual(r.reasons.sort(), ['keysBlocked', 'phoneCta', 'scare']);
});
