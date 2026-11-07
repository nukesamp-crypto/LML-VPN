'use strict';
// LML-owned shortcuts in the embedded, unmodified TheFeed interface. They do
// not subscribe to a Telegram account or change anybody's existing channels.
(() => {
  if (window.__lmlFeedPinsInstalled) return;
  window.__lmlFeedPinsInstalled = true;
  const username = 'LML_panel';
  const same = value => String(value || '').replace(/^@/, '').toLowerCase() === username.toLowerCase();
  const matchQuery = query => !query || 'lml vpn @lml_panel'.includes(String(query).trim().toLowerCase());

  function badge(parent) {
    if (!parent || parent.querySelector('[data-lml-pin-badge]')) return;
    const marker = document.createElement('span');
    marker.dataset.lmlPinBadge = '1';
    marker.className = 'lml-feed-pin-badge';
    marker.textContent = '📌';
    marker.title = 'سنجاق‌شده در LML';
    marker.setAttribute('aria-label', 'سنجاق‌شده در LML');
    parent.append(marker);
  }
  function row(kind) {
    const el = document.createElement('button');
    el.type = 'button';
    el.dataset.lmlPinned = kind;
    el.className = (kind === 'mirror' ? 'tm-channel-item ' : '') + 'lml-feed-shortcut';
    if (kind === 'mirror') el.dataset.u = username;
    el.setAttribute('aria-label', 'باز کردن کانال LML VPN');
    const avatar = document.createElement('span');
    avatar.className = 'lml-feed-pin-avatar';
    avatar.textContent = 'L';
    const copy = document.createElement('span');
    copy.className = 'lml-feed-pin-copy';
    const name = document.createElement('strong');
    name.textContent = 'LML VPN';
    const handle = document.createElement('small');
    handle.textContent = '@LML_panel';
    copy.append(name, handle);
    el.append(avatar, copy);
    badge(el);
    if (kind === 'mirror') {
      el.addEventListener('click', () => { if (typeof window.tmSelectFromClick === 'function') window.tmSelectFromClick(username); });
    } else {
      // Resolving/reading is not joining. The upstream UI still asks the user
      // before subscribing or doing anything to their Telegram account.
      el.addEventListener('click', () => { if (typeof window.telOpenByUsername === 'function') window.telOpenByUsername(username); });
    }
    return el;
  }

  function pinMirror() {
    const list = document.getElementById('tmChannelsList');
    if (!list) return;
    const native = Array.from(list.children).find(el => el.classList.contains('tm-channel-item') && !el.dataset.lmlPinned && same(el.dataset.u));
    const shortcut = list.querySelector('[data-lml-pinned="mirror"]');
    if (native) {
      if (shortcut) shortcut.remove();
      badge(native.querySelector('.tm-channel-item-meta') || native);
      if (list.firstElementChild !== native) list.prepend(native);
    } else {
      const el = shortcut || row('mirror');
      if (list.firstElementChild !== el) list.prepend(el);
      const query = document.getElementById('channelSearch')?.value || '';
      el.style.display = matchQuery(query) ? 'flex' : 'none';
    }
  }
  function pinTelegram() {
    const body = document.getElementById('telBody');
    const tabs = body && body.querySelector('.tel-tabs');
    if (!body || !tabs) return; // no logged-in list yet
    const state = window.telState || {};
    if (!['all', 'channel'].includes(state.tab || 'all') ||
        !matchQuery(state.searchIn === 'list' ? state.search : '')) {
      body.querySelector('[data-lml-pinned="telegram"]')?.remove();
      return;
    }
    const list = body.querySelector('.tel-list');
    const dialogs = Array.isArray(state.dialogs) ? state.dialogs : [];
    const dialog = dialogs.find(d => same(d?.peer?.username));
    const key = dialog && typeof window.telPeerKey === 'function' ? window.telPeerKey(dialog.peer) : '';
    const native = key && list ? Array.from(list.children).find(el => (el.getAttribute('onclick') || '') === `telOpenPeer('${key}')`) : null;
    const shortcut = body.querySelector('[data-lml-pinned="telegram"]');
    if (native) {
      if (shortcut) shortcut.remove();
      badge(native.querySelector('.tel-row-top') || native);
      if (list.firstElementChild !== native) list.prepend(native);
    } else {
      const el = shortcut || row('telegram');
      const target = list || body;
      if (list) {
        if (target.firstElementChild !== el) target.prepend(el);
      } else if (tabs.nextElementSibling !== el) tabs.after(el);
    }
  }
  function pinFeedIfAvailable() {
    const list = document.getElementById('channelList');
    if (!list) return;
    // A DNS feed can only supply channels its server already publishes; do
    // not fabricate a DNS entry or silently switch it to the Google mirror.
    const native = Array.from(list.children).find(el => el.classList.contains('ch-item') && same(el.dataset.name));
    if (!native) return;
    badge(native.querySelector('.ch-name') || native);
    const saved = document.getElementById('savedChannelBtn');
    const first = saved && saved.parentElement === list ? saved.nextElementSibling : list.firstElementChild;
    if (first !== native) list.insertBefore(native, first);
  }
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; pinMirror(); pinTelegram(); pinFeedIfAvailable(); });
  }
  const observer = new MutationObserver(schedule);
  for (const id of ['tmChannelsList', 'telSidebar', 'channelList']) {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { childList: true, subtree: true });
  }
  schedule();
})();
