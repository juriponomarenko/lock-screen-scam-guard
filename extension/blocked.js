'use strict';

// Only these known keys are ever rendered; anything else in the URL is ignored.
const REASON_TEXT = {
  scare: 'It claimed your device was locked, infected or at risk.',
  impersonation: 'It posed as an operating-system or security vendor.',
  phoneCta: 'It pushed you to call a phone number.',
  errorCode: 'It showed a made-up error code.',
  keysBlocked: 'It blocked keyboard shortcuts such as reload.',
  contextMenuBlocked: 'It blocked right-click.',
  beforeunload: 'It tried to stop you from leaving the page.',
  fullscreen: 'It tried to take over the whole screen.',
  inputLock: 'It tried to capture your keyboard or mouse.',
  historyTrap: 'It tampered with the Back button.',
  scriptedRedirect: 'It replaced the page you opened without you clicking anything.',
};

const params = new URLSearchParams(location.hash.slice(1));
const reasons = (params.get('why') || '').split(',').filter((key) => key in REASON_TEXT);

if (params.get('auto') === '0') {
  document.getElementById('headline').textContent = 'You left a suspicious page';
  document.title = 'Suspicious page closed';
}

if (reasons.length) {
  const list = document.getElementById('reasons');
  for (const key of reasons) {
    const item = document.createElement('li');
    item.textContent = REASON_TEXT[key];
    list.append(item);
  }
  document.getElementById('why').hidden = false;
}

document.getElementById('close').addEventListener('click', async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
});
