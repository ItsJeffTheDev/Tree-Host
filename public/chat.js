'use strict';
// Live support chat. Customers: the chat bubble in the dashboard (initSupportChat). Staff: Staff Console → Support chat
// (consoleSupportChat). Server side: src/support-chat.js and the /api/support routes in server.js. New messages arrive
// as "chat" events on the dashboard's live connection; while a chat is open it also polls, in case a proxy holds the
// live connection back. Loaded before console.js and app.js; uses their helpers ($, esc, api, toast, ic...) at call time.

const CHAT_STATUS = { open: ['Waiting', 'yellow'], answered: ['Answered', 'green'], closed: ['Closed', ''] };
const chatTime = (t) => {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const chatText = (t) => esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,)])/g, '<a href="$1" target="_blank" rel="noopener nofollow">$1</a>');

/** The messages of a conversation. `me`: 'customer' or 'staff' (whose messages go on the right). */
function chatMessagesHtml(c, me) {
  let lastDay = '';
  return c.messages
    .map((m) => {
      const day = new Date(m.at).toDateString();
      const sep = day !== lastDay ? `<div class="cm-day">${day === new Date().toDateString() ? 'Today' : new Date(m.at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</div>` : '';
      lastDay = day;
      if (m.from === 'system') return `${sep}<div class="cm-system">${esc(m.text)}</div>`;
      const mine = m.from === me;
      const who = m.from === 'staff' ? `${esc(m.name)} <span class="badge ${ROLE_BADGE[m.roleLabel?.toLowerCase()] || 'green'}">${esc(m.roleLabel || 'Tree Host')}</span>` : esc(m.name);
      return `${sep}<div class="cm ${mine ? 'mine' : 'theirs'} ${m.from}">
        ${mine ? '' : `<div class="cm-who">${who}</div>`}
        <div class="cm-bubble">${chatText(m.text)}</div>
        <div class="cm-time">${chatTime(m.at)}</div>
      </div>`;
    })
    .join('');
}

/** Enter sends, Shift+Enter is a new line; tells the other side "typing…" at most every 3 seconds. */
function bindChatInput(form, { onSend, onTyping }) {
  const box = form.querySelector('textarea');
  let lastTyping = 0;
  const grow = () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
  };
  box.addEventListener('input', () => {
    grow();
    if (onTyping && Date.now() - lastTyping > 3000 && box.value.trim()) {
      lastTyping = Date.now();
      onTyping();
    }
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await onSend(text);
      box.value = '';
      grow();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      box.focus();
    }
  });
}

// =====================================================================================================
// Customers: the chat bubble
// =====================================================================================================

const supportChat = { open: false, view: 'list', chats: [], current: null, agents: 0, typingUntil: 0, poll: null };

function initSupportChat() {
  if (!isTeam() || !state.me.user || hasPerm('support.chat')) return; // staff answer from the Staff Console
  const root = document.createElement('div');
  root.id = 'support-chat';
  root.innerHTML = `
    <button class="sc-bubble" id="sc-bubble" title="Chat with Tree Host support" aria-label="Chat with Tree Host support">${ic('chat')}<span class="sc-unread hidden" id="sc-unread"></span></button>
    <div class="sc-panel hidden" id="sc-panel" role="dialog" aria-label="Tree Host support chat"></div>`;
  document.body.appendChild(root);
  $('#sc-bubble').addEventListener('click', () => (supportChat.open ? closeSupportChat() : openSupportChat()));
  refreshSupportChats().then(() => {
    const id = new URLSearchParams(location.search).get('chat');
    if (id) {
      history.replaceState(null, '', location.pathname);
      openSupportChat(id);
    }
  });
}

async function refreshSupportChats() {
  const d = await api('GET', '/api/support/chats').catch(() => null);
  if (!d) return;
  supportChat.chats = d.chats;
  supportChat.agents = d.agentsOnline;
  updateSupportUnread();
}

function updateSupportUnread() {
  const n = supportChat.chats.reduce((s, c) => s + c.unread, 0);
  const el = $('#sc-unread');
  if (!el) return;
  el.textContent = n > 9 ? '9+' : String(n);
  el.classList.toggle('hidden', !n);
}

async function openSupportChat(chatId) {
  supportChat.open = true;
  $('#sc-panel').classList.remove('hidden');
  $('#sc-bubble').classList.add('on');
  await refreshSupportChats();
  if (chatId || (supportChat.view === 'chat' && supportChat.current)) await showSupportChat(chatId || supportChat.current.id);
  else drawSupportPanel(supportChat.chats.some((c) => c.status !== 'closed') || supportChat.chats.length ? 'list' : 'new');
  clearInterval(supportChat.poll);
  supportChat.poll = setInterval(() => {
    if (supportChat.view === 'chat' && supportChat.current) reloadSupportChat();
  }, 6000);
}

function closeSupportChat() {
  supportChat.open = false;
  clearInterval(supportChat.poll);
  $('#sc-panel').classList.add('hidden');
  $('#sc-bubble').classList.remove('on');
}

function supportHeader(back) {
  const on = supportChat.agents > 0;
  return `<div class="sc-head">
    ${back ? `<button class="sc-icon" id="sc-back" title="Back">${ic('arrow')}</button>` : `<div class="sc-logo">${ic('tree')}</div>`}
    <div class="sc-title"><b>Tree Host support</b><span class="sc-status ${on ? 'on' : ''}">${on ? "We're online: we usually reply in a few minutes" : "Leave a message: we'll reply here and by email"}</span></div>
    <button class="sc-icon" id="sc-close" title="Close">${ic('x')}</button>
  </div>`;
}

function drawSupportPanel(view) {
  supportChat.view = view;
  const p = $('#sc-panel');
  if (view === 'list') {
    const list = supportChat.chats;
    p.innerHTML = `${supportHeader(false)}
      <div class="sc-body">
        <p class="sc-hello">Hi ${esc(state.me.user.username)}! Questions about your server, billing or anything else? We're happy to help.</p>
        <button class="btn primary block" id="sc-new">${ic('plus')} Start a new chat</button>
        ${list.length ? `<div class="sc-list-title">Your chats</div>${list
          .map((c) => `<button class="sc-item" data-chat="${esc(c.id)}">
            <div class="sc-item-top"><b>${esc(c.subject)}</b>${c.unread ? `<span class="sc-dot">${c.unread}</span>` : ''}</div>
            <div class="sc-item-sub">${c.last ? `${c.last.from === 'staff' ? `${esc(c.last.name)}: ` : c.last.from === 'customer' ? 'You: ' : ''}${esc(c.last.text)}` : ''}</div>
            <div class="sc-item-meta"><span class="badge ${CHAT_STATUS[c.status][1]}">${CHAT_STATUS[c.status][0]}</span> ${chatTime(c.updatedAt)}</div>
          </button>`)
          .join('')}` : ''}
        <p class="sc-alt">Prefer email? <a href="mailto:support@treehost.online">support@treehost.online</a></p>
      </div>`;
    $('#sc-new', p).addEventListener('click', () => drawSupportPanel('new'));
    $$('[data-chat]', p).forEach((b) => b.addEventListener('click', () => showSupportChat(b.dataset.chat)));
  } else if (view === 'new') {
    const mine = [...state.servers.values()].filter((s) => s.owner === state.me.user.id);
    p.innerHTML = `${supportHeader(supportChat.chats.length > 0)}
      <form class="sc-body sc-new" id="sc-new-form">
        <p class="sc-hello">What can we help with? Tell us as much as you can, and we'll pick it up from there.</p>
        ${mine.length ? `<label class="field">Which server is it about? <select name="serverId"><option value="">None / not about a server</option>${mine.map((s) => `<option value="${esc(s.id)}" ${s.id === state.selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
        <label class="field">Your message <textarea name="text" rows="5" maxlength="2000" required placeholder="e.g. My server won't start since I added a plugin..."></textarea></label>
        <button class="btn primary block" type="submit">${ic('chat')} Start chat</button>
      </form>`;
    const f = $('#sc-new-form', p);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('[type=submit]', f);
      btn.disabled = true;
      try {
        const c = await api('POST', '/api/support/chats', { text: f.text.value, serverId: f.serverId ? f.serverId.value : '' });
        supportChat.chats.unshift(c);
        await showSupportChat(c.id, c);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
    f.text.focus();
  }
  $('#sc-close', p).addEventListener('click', closeSupportChat);
  $('#sc-back', p)?.addEventListener('click', () => drawSupportPanel('list'));
}

async function showSupportChat(chatId, preloaded) {
  const c = preloaded || (await api('GET', `/api/support/chats/${encodeURIComponent(chatId)}`).catch((e) => toast(e.message, 'error')));
  if (!c) return drawSupportPanel('list');
  if (c.agentsOnline !== undefined) supportChat.agents = c.agentsOnline;
  supportChat.current = c;
  supportChat.view = 'chat';
  const p = $('#sc-panel');
  const closed = c.status === 'closed';
  p.innerHTML = `${supportHeader(true)}
    <div class="sc-subject"><b>${esc(c.subject)}</b> <span class="badge ${CHAT_STATUS[c.status][1]}">${CHAT_STATUS[c.status][0]}</span>
      ${closed ? '' : '<button class="sc-link" id="sc-end">End chat</button>'}</div>
    <div class="sc-messages" id="sc-messages">${chatMessagesHtml(c, 'customer')}
      ${c.status === 'open' && !c.assignedTo ? `<div class="cm-system">${supportChat.agents ? 'Someone from Tree Host will be with you shortly.' : "We've got your message. We'll reply here, and email you when we do."}</div>` : ''}
    </div>
    <div class="sc-typing hidden" id="sc-typing"></div>
    ${closed
      ? `<div class="sc-closed">This chat is closed. <button class="btn sm primary" id="sc-again">Start a new chat</button></div>`
      : `<form class="sc-input" id="sc-form"><textarea rows="1" maxlength="2000" placeholder="Write a message…" aria-label="Message"></textarea>
         <button class="btn primary" type="submit" title="Send">${ic('arrow')}</button></form>`}`;
  $('#sc-close', p).addEventListener('click', closeSupportChat);
  $('#sc-back', p).addEventListener('click', async () => {
    await refreshSupportChats();
    drawSupportPanel('list');
  });
  $('#sc-again', p)?.addEventListener('click', () => drawSupportPanel('new'));
  $('#sc-end', p)?.addEventListener('click', () =>
    attempt(async () => {
      await api('POST', `/api/support/chats/${c.id}/close`);
      await showSupportChat(c.id);
    }),
  );
  const form = $('#sc-form', p);
  if (form) {
    bindChatInput(form, {
      onSend: async (text) => {
        const m = await api('POST', `/api/support/chats/${c.id}/messages`, { text });
        if (!c.messages.some((x) => x.id === m.id)) c.messages.push(m);
        redrawSupportMessages();
      },
      onTyping: () => api('POST', `/api/support/chats/${c.id}/typing`).catch(() => {}),
    });
    $('textarea', form).focus();
  }
  scrollChat($('#sc-messages', p));
  markSupportRead(c);
}

async function reloadSupportChat() {
  const c = supportChat.current;
  if (!c) return;
  const fresh = await api('GET', `/api/support/chats/${c.id}`).catch(() => null);
  if (!fresh || !supportChat.open || supportChat.current?.id !== c.id) return;
  if (fresh.messages.length !== c.messages.length || fresh.status !== c.status) showSupportChat(c.id, fresh);
}

function redrawSupportMessages() {
  const el = $('#sc-messages');
  if (!el || !supportChat.current) return;
  el.innerHTML = chatMessagesHtml(supportChat.current, 'customer');
  scrollChat(el);
}

function markSupportRead(c) {
  const item = supportChat.chats.find((x) => x.id === c.id);
  if (item) item.unread = 0;
  updateSupportUnread();
  if (document.visibilityState === 'visible') api('POST', `/api/support/chats/${c.id}/read`).catch(() => {});
}

const scrollChat = (el) => el && (el.scrollTop = el.scrollHeight);

/** A live "chat" event for the customer. */
function onSupportChatEvent(ev) {
  if (!state.me?.user || ev.userId !== state.me.user.id || hasPerm('support.chat')) return;
  const open = supportChat.open && supportChat.view === 'chat' && supportChat.current?.id === ev.chatId;
  if (ev.type === 'message') {
    if (open) {
      const c = supportChat.current;
      if (!c.messages.some((m) => m.id === ev.message.id)) c.messages.push(ev.message);
      if (ev.chat) c.status = ev.chat.status;
      if (ev.message.from === 'system') showSupportChat(c.id, c); // e.g. closed or someone joined: redraw everything
      else redrawSupportMessages();
      $('#sc-typing')?.classList.add('hidden');
      markSupportRead(c);
    } else if (ev.message.from !== 'customer') {
      refreshSupportChats();
      if (ev.message.from === 'staff') toast(`Tree Host support: ${ev.message.text.slice(0, 80)}`);
    }
  } else if (ev.type === 'typing' && ev.side === 'staff' && open) {
    const t = $('#sc-typing');
    if (!t) return;
    t.textContent = `${ev.name} is typing…`;
    t.classList.remove('hidden');
    clearTimeout(supportChat.typingTimer);
    supportChat.typingTimer = setTimeout(() => t.classList.add('hidden'), 4500);
  }
}

// =====================================================================================================
// Staff: Staff Console → Support chat
// =====================================================================================================

const agentChat = { list: [], current: null, filter: 'active', q: '', es: null, body: null, poll: null, customer: null };

/** Live events for staff, started with the Staff Console (the badge in the menu stays current on every page). */
function startAgentChatEvents() {
  if (agentChat.es || !hasPerm('support.chat')) return;
  const es = new EventSource('/api/events');
  agentChat.es = es;
  es.addEventListener('chat', (e) => onAgentChatEvent(JSON.parse(e.data)));
  refreshAgentBadge();
  setInterval(refreshAgentBadge, 30000);
}

async function refreshAgentBadge() {
  const d = await api('GET', '/api/admin/support/chats?status=active').catch(() => null);
  if (!d) return;
  agentChat.list = agentChat.filter === 'active' ? d.chats : agentChat.list;
  setAgentBadge(d.chats.filter((c) => c.status === 'open').length);
}

function setAgentBadge(n) {
  const a = $('[data-sec="chat"]');
  if (!a) return;
  let b = $('.nav-count', a);
  if (!b) {
    b = document.createElement('span');
    b.className = 'nav-count';
    a.appendChild(b);
  }
  b.textContent = n;
  b.classList.toggle('hidden', !n);
  document.title = n ? `(${n}) Staff Console · Tree Host` : 'Staff Console · Tree Host';
}

async function consoleSupportChat(body, sub) {
  agentChat.body = body;
  body.innerHTML = `
    <div class="ac">
      <aside class="ac-side">
        <div class="ac-tools">
          <input type="search" id="ac-q" placeholder="Search name or message" value="${esc(agentChat.q)}">
          <div class="ac-tabs">${[['active', 'Active'], ['closed', 'Closed']].map(([k, l]) => `<button class="chip ${agentChat.filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
        </div>
        <div class="ac-list" id="ac-list"><div class="muted" style="padding:12px">Loading…</div></div>
      </aside>
      <section class="ac-main" id="ac-main"><div class="ac-empty">${ic('chat')}<p>Pick a chat on the left.<br><span class="muted small">New chats show up here instantly, with a count in the menu.</span></p></div></section>
    </div>`;
  $('#ac-q', body).addEventListener('input', (e) => {
    agentChat.q = e.target.value.trim().toLowerCase();
    drawAgentList();
  });
  $$('[data-f]', body).forEach((b) => b.addEventListener('click', async () => {
    agentChat.filter = b.dataset.f;
    $$('[data-f]', body).forEach((x) => x.classList.toggle('on', x === b));
    await loadAgentList();
  }));
  await loadAgentList();
  const open = sub || (agentChat.current && agentChat.current.id);
  if (open) openAgentChat(open);
  clearInterval(agentChat.poll);
  agentChat.poll = setInterval(() => {
    if (!document.body.contains(body)) return clearInterval(agentChat.poll);
    loadAgentList();
    if (agentChat.current) openAgentChat(agentChat.current.id, { quiet: true });
  }, 15000);
}

async function loadAgentList() {
  const d = await api('GET', `/api/admin/support/chats?status=${agentChat.filter}`).catch((e) => (toast(e.message, 'error'), null));
  if (!d) return;
  agentChat.list = d.chats;
  agentChat.agents = d.agentsOnline;
  if (agentChat.filter === 'active') setAgentBadge(d.chats.filter((c) => c.status === 'open').length);
  drawAgentList();
}

function drawAgentList() {
  const el = $('#ac-list');
  if (!el) return;
  const me = state.me.user.id;
  const list = agentChat.list.filter((c) => !agentChat.q || [c.username, c.subject, c.last && c.last.text].some((x) => String(x || '').toLowerCase().includes(agentChat.q)));
  el.innerHTML = list.length
    ? list
        .map((c) => `<button class="ac-item ${agentChat.current?.id === c.id ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-chat="${esc(c.id)}">
          <div class="ac-item-top"><b>${esc(c.username)}</b><span class="small muted">${chatTime(c.updatedAt)}</span></div>
          <div class="ac-item-subject">${esc(c.subject)}</div>
          <div class="ac-item-sub">${c.last ? `${c.last.from === 'customer' ? '' : `${esc(c.last.name || 'Tree Host')}: `}${esc(c.last.text)}` : ''}</div>
          <div class="ac-item-meta"><span class="badge ${CHAT_STATUS[c.status][1]}">${CHAT_STATUS[c.status][0]}</span>
            ${c.assignedTo ? `<span class="small muted">${c.assignedTo === me ? 'You' : esc(c.assignedName)}</span>` : '<span class="small" style="color:#e8c27a">Unassigned</span>'}
            ${c.unread ? `<span class="sc-dot">${c.unread}</span>` : ''}</div>
        </button>`)
        .join('')
    : `<div class="muted small" style="padding:14px">${agentChat.filter === 'closed' ? 'No closed chats.' : 'No active chats. Nice and quiet.'}</div>`;
  $$('[data-chat]', el).forEach((b) => b.addEventListener('click', () => openAgentChat(b.dataset.chat)));
}

async function openAgentChat(chatId, { quiet = false } = {}) {
  const c = await api('GET', `/api/support/chats/${encodeURIComponent(chatId)}`).catch((e) => (quiet ? null : toast(e.message, 'error')));
  const main = $('#ac-main');
  if (!c || !main) return;
  const same = agentChat.current && agentChat.current.id === c.id;
  if (quiet && same && agentChat.current.messages.length === c.messages.length && agentChat.current.status === c.status) return;
  const draft = same && $('#ac-form textarea') ? $('#ac-form textarea').value : '';
  agentChat.current = c;
  if (location.hash !== `#chat/${c.id}`) history.replaceState(null, '', `#chat/${c.id}`);
  const me = state.me.user.id;
  const closed = c.status === 'closed';
  main.innerHTML = `
    <div class="ac-head">
      <div style="min-width:0"><div class="ac-head-title"><b>${esc(c.username)}</b> <span class="badge ${CHAT_STATUS[c.status][1]}">${CHAT_STATUS[c.status][0]}</span></div>
        <div class="small muted ac-head-sub">${esc(c.subject)} · started ${esc(new Date(c.createdAt).toLocaleString())}${c.assignedTo ? ` · ${c.assignedTo === me ? 'yours' : `with ${esc(c.assignedName)}`}` : ''}</div></div>
      <div class="row">
        ${!closed && c.assignedTo !== me ? `<button class="btn sm" id="ac-claim">${ic('hand')} ${c.assignedTo ? 'Take over' : 'Claim'}</button>` : ''}
        ${closed ? `<button class="btn sm" id="ac-reopen">Reopen</button>` : `<button class="btn sm" id="ac-close">${ic('check')} Close</button>`}
      </div>
    </div>
    <div class="ac-wrap">
      <div class="ac-convo">
        <div class="sc-messages ac-messages" id="ac-messages">${chatMessagesHtml(c, 'staff')}</div>
        <div class="sc-typing hidden" id="ac-typing"></div>
        ${closed
          ? '<div class="sc-closed">Closed. Reopen it to reply, or the customer can start a new chat.</div>'
          : `<form class="sc-input" id="ac-form"><textarea rows="1" maxlength="2000" placeholder="Reply to ${esc(c.username)}… (Enter sends, Shift+Enter for a new line)">${esc(draft)}</textarea>
             <button class="btn primary" type="submit" title="Send">${ic('arrow')}</button></form>`}
      </div>
      <aside class="ac-customer" id="ac-customer"><div class="muted small">Loading customer…</div></aside>
    </div>`;
  $('#ac-claim', main)?.addEventListener('click', () => attempt(async () => {
    await api('POST', `/api/admin/support/chats/${c.id}/claim`);
    openAgentChat(c.id);
  }));
  $('#ac-close', main)?.addEventListener('click', () => attempt(async () => {
    await api('POST', `/api/support/chats/${c.id}/close`);
    await openAgentChat(c.id);
    loadAgentList();
  }));
  $('#ac-reopen', main)?.addEventListener('click', () => attempt(async () => {
    await api('POST', `/api/admin/support/chats/${c.id}/reopen`);
    await openAgentChat(c.id);
    loadAgentList();
  }));
  const form = $('#ac-form', main);
  if (form) {
    bindChatInput(form, {
      onSend: async (text) => {
        const m = await api('POST', `/api/support/chats/${c.id}/messages`, { text });
        if (!c.messages.some((x) => x.id === m.id)) c.messages.push(m);
        redrawAgentMessages();
        loadAgentList();
      },
      onTyping: () => api('POST', `/api/support/chats/${c.id}/typing`).catch(() => {}),
    });
    if (!quiet) $('textarea', form).focus();
  }
  scrollChat($('#ac-messages', main));
  if (c.unread) api('POST', `/api/support/chats/${c.id}/read`).catch(() => {});
  const item = agentChat.list.find((x) => x.id === c.id);
  if (item) item.unread = 0;
  drawAgentList();
  drawAgentCustomer(c);
}

async function drawAgentCustomer(c) {
  const el = $('#ac-customer');
  const u = agentChat.customer && agentChat.customer.chat === c.id ? agentChat.customer.data : await api('GET', `/api/admin/support/chats/${c.id}/customer`).catch(() => null);
  agentChat.customer = { chat: c.id, data: u };
  if (!el || !u) return;
  if (u.deleted) return (el.innerHTML = `<b>${esc(u.username)}</b><p class="muted small">This account was deleted.</p>`);
  const about = c.serverId && u.servers.find((s) => s.id === c.serverId);
  el.innerHTML = `
    <div class="ac-cust-name"><b>${esc(u.username)}</b> <span class="badge ${ROLE_BADGE[u.role] || ''}">${esc(u.roleLabel)}</span>${u.restriction ? ` <span class="badge red">${esc(u.restriction)}</span>` : ''}</div>
    ${u.email ? `<div class="small"><a href="mailto:${esc(u.email)}">${esc(u.email)}</a></div>` : ''}
    <div class="small muted">Customer since ${u.createdAt ? esc(new Date(u.createdAt).toLocaleDateString()) : '?'}${u.mcName ? ` · Minecraft: ${esc(u.mcName)}` : ''}</div>
    ${about ? `<div class="ac-about">${ic('server')} About <b>${esc(about.name)}</b></div>` : ''}
    <div class="ac-cust-h">Plans</div>
    <div class="small">${u.plans.length ? u.plans.map(esc).join(', ') : '<span class="muted">none</span>'}</div>
    <div class="ac-cust-h">Servers (${u.servers.length})</div>
    ${u.servers.length ? u.servers.map((s) => `<div class="small ac-srv"><span class="dot ${s.running ? 'running' : 'stopped'}"></span> ${esc(s.name)} <span class="muted">${esc(s.type)} ${esc(s.version)}</span></div>`).join('') : '<div class="small muted">none</div>'}
    ${u.otherChats ? `<div class="small muted" style="margin-top:10px">${u.otherChats} other chat${u.otherChats === 1 ? '' : 's'} with us</div>` : ''}
    ${hasPerm('users.view') ? `<a class="btn sm block" style="margin-top:12px" href="#people">${ic('users')} Open in People</a>` : ''}`;
}

function redrawAgentMessages() {
  const el = $('#ac-messages');
  if (!el || !agentChat.current) return;
  el.innerHTML = chatMessagesHtml(agentChat.current, 'staff');
  scrollChat(el);
}

/** A live "chat" event for staff. */
function onAgentChatEvent(ev) {
  const open = agentChat.current && agentChat.current.id === ev.chatId && $('#ac-main');
  if (ev.type === 'new') {
    toast(`New support chat from ${ev.chat.username}: ${ev.chat.subject.slice(0, 60)}`);
  }
  if (ev.type === 'new' || ev.type === 'message') {
    if (ev.chat) {
      const i = agentChat.list.findIndex((c) => c.id === ev.chatId);
      if (i >= 0) agentChat.list[i] = { ...ev.chat, unread: open ? 0 : ev.chat.unread };
      else if (agentChat.filter === 'active') agentChat.list.unshift(ev.chat);
      agentChat.list.sort((a, b) => (b.status === 'open') - (a.status === 'open') || b.updatedAt - a.updatedAt);
      setAgentBadge(agentChat.list.filter((c) => c.status === 'open').length);
      drawAgentList();
    }
    if (open && ev.message) {
      const c = agentChat.current;
      if (!c.messages.some((m) => m.id === ev.message.id)) c.messages.push(ev.message);
      if (ev.message.from === 'system') openAgentChat(c.id, { quiet: true });
      else redrawAgentMessages();
      $('#ac-typing')?.classList.add('hidden');
      if (ev.message.from === 'customer' && document.visibilityState === 'visible') api('POST', `/api/support/chats/${c.id}/read`).catch(() => {});
    }
  } else if (ev.type === 'typing' && ev.side === 'customer' && open) {
    const t = $('#ac-typing');
    if (!t) return;
    t.textContent = `${ev.name} is typing…`;
    t.classList.remove('hidden');
    clearTimeout(agentChat.typingTimer);
    agentChat.typingTimer = setTimeout(() => t.classList.add('hidden'), 4500);
  }
}
