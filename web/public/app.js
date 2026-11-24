'use strict';

/**
 * Node Chat 网页端
 * ------------------------------------------------------------------
 * 协议和服务端完全一致：WebSocket 上跑的仍是 NDJSON，一行一条。
 * 网关只做搬运，所以这里的字段名与 server/src/protocol.js 一一对应。
 */

(function () {
  const $ = (sel) => document.querySelector(sel);
  const MAX_TEXT = 4000;
  const MAX_IMAGE_CHARS = 580000; // 服务端图片上限 600000，留点余量
  const MAX_MEDIA_CHARS = 1100000; // GIF/动画上限 1200000，留点余量
  const MAX_VIDEO_CHARS = 1900000; // 短视频上限 2000000，留点余量

  const state = {
    ws: null,
    authed: false,
    user: null,
    avatar: null,
    serverName: 'Node Chat',
    rooms: [],
    members: [],
    online: [],
    avatars: {},
    conv: null, // { kind: 'room' | 'dm', id }
    msgs: [],
    msgIds: new Set(),
    contacts: loadContacts(),
    unread: {},
    pending: new Map(),
    reqSeq: 0,
    retry: 0,
    retryTimer: null,
    manualClose: false,
    attachImage: null,
    attachVideo: null,
    lastDay: '',
  };

  // ================================================================ 工具
  function loadContacts() {
    try {
      const raw = localStorage.getItem('nc.web.contacts');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch (_) {
      return [];
    }
  }

  function saveContacts() {
    try {
      localStorage.setItem('nc.web.contacts', JSON.stringify(state.contacts.slice(0, 60)));
    } catch (_) {}
  }

  function addContact(name) {
    if (!name || name === state.user || state.contacts.includes(name)) return;
    state.contacts.unshift(name);
    saveContacts();
  }

  function convKey(kind, id) {
    return kind + ':' + id;
  }

  function isActive(kind, id) {
    return !!state.conv && state.conv.kind === kind && state.conv.id === id;
  }

  /** 用户名 -> 稳定的头像底色（同一个人永远是同一个颜色，相邻名字也不会撞色） */
  function colorOf(name) {
    let h = 0;
    for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 100000;
    const hue = (h * 137) % 360;
    return `hsl(${hue} 52% 50%)`;
  }

  function initials(name) {
    const s = String(name || '?').trim();
    if (!s) return '?';
    // 中文取最后一个字更像称呼，英文取首字母
    if (/[\u4e00-\u9fa5]/.test(s)) return s.slice(-1);
    return s.slice(0, 1).toUpperCase();
  }

  function paintAvatar(el, name, size) {
    const av = state.avatars[name];
    if (av) {
      el.style.backgroundImage = `url(${av})`;
      el.textContent = '';
    } else {
      el.style.backgroundImage = 'none';
      el.style.background = colorOf(name);
      el.textContent = initials(name);
      if (size) el.style.fontSize = size;
    }
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function timeOf(ts) {
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function dayOf(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(Date.now() - 86400000);
    if (dayOf(ts) === dayOf(today.getTime())) return '今天';
    if (dayOf(ts) === dayOf(yest.getTime())) return '昨天';
    return d.getMonth() + 1 + '月' + d.getDate() + '日';
  }

  function toast(text, ms) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.hidden = true;
    }, ms || 2800);
  }

  function setConn(kind, text) {
    const el = $('#connState');
    el.className = 'conn ' + kind;
    el.innerHTML = '<i></i>';
    el.appendChild(document.createTextNode(text));
  }

  // ================================================================ 连接
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  function connect() {
    return new Promise((resolve, reject) => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) return resolve();
      let ws;
      try {
        ws = new WebSocket(wsUrl());
      } catch (e) {
        return reject(e);
      }
      state.ws = ws;
      const timer = setTimeout(() => reject(new Error('连接超时')), 10000);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (!state.authed) clearTimeout(timer);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        handle(msg);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (state.ws !== ws) return;
        state.authed = false;
        if (state.manualClose) return;
        if (!state.creds) return; // 还没登录过，不自动重连
        setConn('offline', '已断开');
        scheduleReconnect();
      };
    });
  }

  function scheduleReconnect() {
    if (state.retryTimer || !state.creds) return;
    const delay = Math.min(1000 * Math.pow(2, state.retry), 15000);
    state.retry += 1;
    setConn('connecting', `重连中 ${Math.round(delay / 1000)}s`);
    state.retryTimer = setTimeout(async () => {
      state.retryTimer = null;
      try {
        await connect();
        await login(state.creds.u, state.creds.p, true);
      } catch (e) {
        scheduleReconnect();
      }
    }, delay);
  }

  /** 发一帧（自动补 id 的版本见 request） */
  function send(obj) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      throw new Error('还没连上');
    }
    state.ws.send(JSON.stringify(obj));
  }

  function request(type, data, timeoutMs) {
    const id = `w${++state.reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error('请求超时'));
      }, timeoutMs || 12000);
      state.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        send({ type, id, data: data || {} });
      } catch (e) {
        clearTimeout(timer);
        state.pending.delete(id);
        reject(e);
      }
    });
  }

  // ================================================================ 收帧
  function handle(msg) {
    const type = msg.type;
    const data = msg.data || {};

    if (msg.id && state.pending.has(msg.id)) {
      const p = state.pending.get(msg.id);
      state.pending.delete(msg.id);
      if (
        type === 'error' ||
        type === 'auth_err' ||
        type === 'secure_err' ||
        type === 'register_err' ||
        type === 'verify_err'
      ) {
        p.reject(Object.assign(new Error(data.message || '请求失败'), { code: data.code }));
      } else {
        p.resolve(data);
      }
      // 这些帧不再往下走业务分支（history/rooms 等已经交给 promise 了）
      if (type !== 'msg' && type !== 'group') return;
    }

    switch (type) {
      case 'msg':
        onIncomingDm(data);
        break;
      case 'group':
        onIncomingGroup(data);
        break;
      case 'system':
        onSystem(data);
        break;
      case 'presence':
        onPresence(data);
        break;
      case 'error':
        if (data.code === 'upstream_unavailable') toast(data.message);
        else if (!msg.id) toast(data.message || '出错了');
        break;
      case 'auth_err':
        if (data.message) toast(data.message);
        break;
      default:
        break;
    }
  }

  function onIncomingDm(m) {
    if (!m || !m.from) return;
    addContact(m.from);
    if (isActive('dm', m.from)) {
      appendMessage(m);
    } else {
      const k = convKey('dm', m.from);
      state.unread[k] = (state.unread[k] || 0) + 1;
      bumpUnread(k);
    }
    renderSidebar();
  }

  function onIncomingGroup(m) {
    if (!m || !m.room) return;
    if (isActive('room', m.room)) {
      appendMessage(m);
    } else {
      const k = convKey('room', m.room);
      state.unread[k] = (state.unread[k] || 0) + 1;
      bumpUnread(k);
    }
  }

  function onSystem(d) {
    if (d.event === 'announcement') {
      addSystemLine(`📢 ${d.text || ''}`);
      return;
    }
    if (d.event === 'avatar') {
      state.avatars[d.user] = d.avatar;
      renderMembers();
      renderSidebar();
      if (d.user === state.user) {
        state.avatar = d.avatar;
        paintAvatar($('#meAvatar'), state.user);
      }
      return;
    }
    if (d.event === 'member_joined' || d.event === 'member_left') {
      if (state.conv && state.conv.kind === 'room' && state.conv.id === d.room) {
        refreshMembers();
      }
      return;
    }
    // user_joined / user_left 只在不打扰的情况下更新在线列表
    if (d.event === 'user_joined' && !state.online.includes(d.user)) {
      state.online.push(d.user);
      renderMembers();
      renderSidebar();
    } else if (d.event === 'user_left') {
      state.online = state.online.filter((u) => u !== d.user);
      renderMembers();
      renderSidebar();
    }
  }

  function onPresence(d) {
    const u = d.user;
    if (!u) return;
    if (d.online) {
      if (!state.online.includes(u)) state.online.push(u);
    } else {
      state.online = state.online.filter((x) => x !== u);
    }
    renderMembers();
    renderSidebar();
  }

  // ================================================================ 登录
  async function login(username, password, isRetry) {
    try {
      const data = await request('auth', { username, password }, 12000);
      await enterChat(data);
      return data;
    } catch (e) {
      if (isRetry) {
        toast('重连后登录失败：' + e.message);
        state.authed = false;
        scheduleReconnect();
      } else {
        throw e;
      }
    }
  }

  /** 注册：发邮箱验证码，进入验证码输入态 */
  async function registerAccount(username, password, email) {
    await request('register', { username, password, email }, 12000);
    // 注册受理，进入验证码区
    $('#verifyHint').textContent = `验证码已发到 ${email}，请查收后输入（10 分钟内有效）`;
    $('#verifySection').hidden = false;
    $('#inputVerify').value = '';
    $('#inputVerify').focus();
    state.pendingVerifyUser = username;
    toast('验证码已发送，请查收邮箱');
  }

  /** 提交邮箱验证码，通过后直接进入聊天 */
  async function verifyAccount(username, code) {
    const data = await request('verify_email', { username, code }, 12000);
    await enterChat(data);
    $('#verifySection').hidden = true;
  }

  /** 重发验证码 */
  async function resendCode() {
    const u = state.pendingVerifyUser || $('#inputUser').value.trim();
    if (!u) return;
    await request('resend_code', { username: u }, 12000);
    toast('验证码已重发，请查收');
  }

  /** 登录成功后进入聊天界面（供 auth 与 verify_email 复用） */
  async function enterChat(data) {
    state.user = data.user;
    state.avatar = data.avatar || null;
    state.serverName = data.server || 'Node Chat';
    state.rooms = data.rooms || [];
    state.authed = true;
    state.retry = 0;
    state.creds = { u: state.user, p: $('#inputPass').value };
    try {
      localStorage.setItem('nc.web.user', state.user);
    } catch (_) {}

    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#meName').textContent = state.user;
    $('#serverName').textContent = state.serverName;
    paintAvatar($('#meAvatar'), state.user);
    setConn('online', '已连接');

    renderSidebar();
    refreshWho();

    const last = loadLastConv();
    if (last && (last.kind === 'room' || last.kind === 'dm')) {
      openConv(last.kind, last.id, true).catch(() => {});
    }
  }

  function loadLastConv() {
    try {
      const raw = localStorage.getItem('nc.web.conv');
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function saveLastConv() {
    try {
      localStorage.setItem('nc.web.conv', JSON.stringify(state.conv));
    } catch (_) {}
  }

  // ================================================================ 会话
  async function openConv(kind, id, silent) {
    state.conv = { kind, id };
    saveLastConv();
    state.msgs = [];
    state.msgIds = new Set();
    state.lastDay = '';
    state.lastRow = null;
    state.unread[convKey(kind, id)] = 0;
    renderSidebar();
    showPlaceholder('正在加载…', '⏳');
    closeDrawers();

    const title = kind === 'room' ? '#' + id : id;
    $('#chatTitle').textContent = title;
    $('#chatSub').textContent = kind === 'room' ? '群聊' : '私聊';
    $('#input').disabled = false;
    $('#btnSend').disabled = false;
    $('#input').focus();

    try {
      if (kind === 'room') {
        // 进群（已在群里会报 already_in_room，忽略）
        await request('join', { room: id }).catch((e) => {
          if (e.code !== 'already_in_room') throw e;
        });
        await refreshMembers(id);
        await refreshRooms();
        const room = state.rooms.find((r) => r.name === id);
        if (room) {
          $('#chatSub').textContent = `群聊 · ${room.memberCount} 人`;
          $('#membersTitle').textContent = `成员 · ${room.memberCount}`;
        }
        const h = await request('history', { room: id, limit: 60 });
        renderHistory(h.messages || []);
      } else {
        const h = await request('history', { to: id, limit: 60 });
        renderHistory(h.messages || []);
        refreshMembersStateForDm();
      }
    } catch (e) {
      if (!silent) toast(e.message || '加载失败');
    }
  }

  function showPlaceholder(text, art) {
    const box = $('#messages');
    box.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'empty';
    const a = document.createElement('div');
    a.className = 'empty-art';
    a.textContent = art || '💬';
    const p = document.createElement('p');
    p.textContent = text;
    hint.appendChild(a);
    hint.appendChild(p);
    box.appendChild(hint);
  }

  function renderHistory(list) {
    state.msgs = [];
    state.msgIds = new Set();
    state.lastDay = '';
    state.lastRow = null;
    const box = $('#messages');
    box.innerHTML = '';
    if (!list.length) {
      showPlaceholder('还没有消息，说第一句吧', '👋');
      return;
    }
    for (const m of list) appendMessage(m, true);
    scrollBottom(true);
  }

  function appendMessage(m, quiet) {
    if (!m || !m.id) return;
    if (state.msgIds.has(m.id)) return;
    const day = dayOf(m.ts || Date.now());
    const dayChanged = day !== state.lastDay;
    const prev = state.lastRow;
    // 同一人 3 分钟内的连续发言合并成一组：省掉重复的头像和名字
    // 带图/带视频的消息不合并——媒体气泡和文字气泡贴在一起会糊成一坨
    const grouped =
      !dayChanged && prev && prev.from === m.from && (m.ts || 0) - prev.ts < 180000 &&
      !m.image && !m.video && !m.videoUrl && !prev.img && !prev.video && !prev.videoUrl;

    if (grouped && prev.timeEl) prev.timeEl.remove();
    state.msgIds.add(m.id);
    state.msgs.push(m);

    const box = $('#messages');
    const placeholder = box.querySelector('.empty');
    if (placeholder) placeholder.remove();

    if (dayChanged) {
      state.lastDay = day;
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = dayLabel(m.ts || Date.now());
      box.appendChild(sep);
    }

    const mine = m.from === state.user;
    const row = document.createElement('div');
    row.className = 'msg' + (mine ? ' mine' : '') + (grouped ? ' cont' : '');

    const av = document.createElement('div');
    av.className = 'msg-avatar';
    paintAvatar(av, m.from);

    const main = document.createElement('div');
    main.className = 'msg-main';

    // 群聊里别人发的消息才显示名字；私聊和「我」都不显示
    const showWho = !mine && state.conv && state.conv.kind === 'room';
    if (showWho) {
      const who = document.createElement('div');
      who.className = 'msg-who';
      who.textContent = m.from;
      main.appendChild(who);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.text) {
      const t = document.createElement('div');
      t.className = 'txt';
      t.textContent = m.text;
      bubble.appendChild(t);
    }
    if (m.image) {
      const img = document.createElement('img');
      img.src = m.image;
      img.alt = '图片消息';
      img.loading = 'lazy';
      img.addEventListener('click', () => showLightbox(m.image));
      img.addEventListener('load', () => {
        if (!quiet) scrollBottom(true);
      });
      bubble.appendChild(img);
    }
    if (m.video || m.videoUrl) {
      const vsrc = m.video || m.videoUrl;
      const v = document.createElement('video');
      v.src = vsrc;
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      v.title = '视频消息';
      v.addEventListener('click', () => showVideoLightbox(vsrc));
      bubble.appendChild(v);
    }
    main.appendChild(bubble);

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = timeOf(m.ts || Date.now());
    main.appendChild(time);

    if (!mine) row.appendChild(av);
    row.appendChild(main);
    box.appendChild(row);

    state.lastRow = { from: m.from, ts: m.ts || 0, timeEl: time, img: !!m.image, video: !!(m.video || m.videoUrl) };

    if (!quiet) scrollBottom();
  }

  function addSystemLine(text) {
    const box = $('#messages');
    const el = document.createElement('div');
    el.className = 'sys-line';
    el.textContent = text;
    box.appendChild(el);
    scrollBottom();
  }

  /** force=true 时无视「是否接近底部」，直接贴底（图片加载完、自己发消息时用） */
  function scrollBottom(force) {
    const box = $('#messages');
    if (!box) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 220;
    if (!near && !force) return;
    requestAnimationFrame(() => {
      box.scrollTo({ top: box.scrollHeight, behavior: force ? 'auto' : 'smooth' });
    });
  }

  function showLightbox(src) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    const img = document.createElement('img');
    img.src = src;
    box.appendChild(img);
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  function showVideoLightbox(src) {
    const box = document.createElement('div');
    box.className = 'lightbox lightbox-video';
    const v = document.createElement('video');
    v.src = src;
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    box.appendChild(v);
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  // ================================================================ 侧栏渲染
  function renderSidebar() {
    // 群聊
    const roomsUl = $('#roomList');
    roomsUl.innerHTML = '';
    for (const r of state.rooms) {
      roomsUl.appendChild(convNode('room', r.name, {
        meta: `${r.memberCount || 0} 人`,
        icon: '#',
      }));
    }
    if (!state.rooms.length) {
      const li = document.createElement('li');
      li.className = 'conv-meta';
      li.style.cssText = 'padding:8px 10px;font-size:12px;color:#9aa1ac';
      li.textContent = '还没有群，点右上角 ＋ 建一个';
      roomsUl.appendChild(li);
    }

    // 私聊：在线的人 + 聊过的人
    const dmUl = $('#dmList');
    dmUl.innerHTML = '';
    const set = new Set([...state.online, ...state.contacts]);
    set.delete(state.user);
    const list = [...set];
    // 在线的排前面
    list.sort((a, b) => {
      const oa = state.online.includes(a) ? 0 : 1;
      const ob = state.online.includes(b) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b, 'zh');
    });
    for (const name of list) {
      const online = state.online.includes(name);
      dmUl.appendChild(convNode('dm', name, {
        meta: online ? '在线' : '不在线',
        online,
        round: true,
      }));
    }
    if (!list.length) {
      const li = document.createElement('li');
      li.style.cssText = 'padding:8px 10px;font-size:12px;color:#9aa1ac';
      li.textContent = '暂时没有别的人在线';
      dmUl.appendChild(li);
    }
  }

  function convNode(kind, id, opt) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'conv' + (isActive(kind, id) ? ' active' : '');
    btn.dataset.kind = kind;
    btn.dataset.id = id;

    if (kind === 'dm') {
      const av = document.createElement('div');
      av.className = 'conv-avatar round';
      paintAvatar(av, id);
      btn.appendChild(av);
    } else {
      const av = document.createElement('div');
      av.className = 'conv-avatar';
      av.style.background = 'linear-gradient(135deg,#6366f1,#8b5cf6)';
      av.textContent = '#';
      btn.appendChild(av);
    }

    const body = document.createElement('div');
    body.className = 'conv-body';
    const name = document.createElement('div');
    name.className = 'conv-name';
    name.textContent = kind === 'room' ? id : id;
    const meta = document.createElement('div');
    meta.className = 'conv-meta';
    meta.textContent = opt.meta || '';
    body.appendChild(name);
    body.appendChild(meta);
    btn.appendChild(body);

    const n = state.unread[convKey(kind, id)] || 0;
    if (n > 0) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = n > 99 ? '99+' : String(n);
      btn.appendChild(b);
    }

    btn.addEventListener('click', () => openConv(kind, id));
    li.appendChild(btn);
    return li;
  }

  function bumpUnread(key) {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    const li = document.querySelector(`.conv[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    let badge = li.querySelector('.badge');
    const n = state.unread[key] || 0;
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge';
      li.appendChild(badge);
    }
    badge.textContent = n > 99 ? '99+' : String(n);
    if (!n) badge.remove();
  }

  // ================================================================ 成员栏
  function renderMembers() {
    const ul = $('#memberList');
    ul.innerHTML = '';
    const kind = state.conv ? state.conv.kind : null;

    let list;
    let title;
    if (kind === 'room') {
      list = state.members.slice();
      title = `成员 · ${list.length}`;
    } else {
      list = state.online.slice();
      title = `在线 · ${list.length}`;
    }
    $('#membersTitle').textContent = title;

    list.sort((a, b) => {
      const oa = state.online.includes(a) ? 0 : 1;
      const ob = state.online.includes(b) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b, 'zh');
    });

    for (const name of list) {
      const online = state.online.includes(name);
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'member';
      btn.title = name === state.user ? '这是你' : '点开私聊 ' + name;

      const av = document.createElement('div');
      av.className = 'conv-avatar round';
      paintAvatar(av, name);
      btn.appendChild(av);

      const nm = document.createElement('span');
      nm.className = 'member-name';
      nm.textContent = name === state.user ? name + '（我）' : name;
      btn.appendChild(nm);

      const st = document.createElement('span');
      st.className = 'member-state' + (online ? ' online' : '');
      st.textContent = online ? '在线' : '离线';
      btn.appendChild(st);

      if (name !== state.user) {
        btn.addEventListener('click', () => openConv('dm', name));
      } else {
        btn.disabled = true;
        btn.style.cursor = 'default';
      }
      li.appendChild(btn);
      ul.appendChild(li);
    }

    if (!list.length) {
      const li = document.createElement('li');
      li.style.cssText = 'padding:10px 8px;font-size:12px;color:#9aa1ac';
      li.textContent = kind === 'dm' ? '还没有人在线' : '空';
      ul.appendChild(li);
    }
  }

  function refreshMembersStateForDm() {
    renderMembers();
  }

  async function refreshMembers(room) {
    try {
      const d = await request('members', { room });
      state.members = d.members || [];
      renderMembers();
    } catch (_) {}
  }

  async function refreshRooms() {
    try {
      const d = await request('rooms', {});
      state.rooms = d.rooms || [];
      renderSidebar();
    } catch (_) {}
  }

  async function refreshWho() {
    try {
      const d = await request('who', {});
      state.online = d.users || [];
      state.avatars = Object.assign({}, state.avatars, d.avatars || {});
      renderSidebar();
      renderMembers();
      paintAvatar($('#meAvatar'), state.user);
    } catch (_) {}
  }

  // ================================================================ 发送
  async function sendMessage() {
    const box = $('#input');
    const text = box.value.trim();
    const image = state.attachImage;
    const video = state.attachVideo; // { url, name, size } 或旧的 data URL
    if (!text && !image && !video) return;
    if (!state.conv) {
      toast('先选一个会话');
      return;
    }
    if (text.length > MAX_TEXT) {
      toast(`一条消息最多 ${MAX_TEXT} 字`);
      return;
    }

    const payload = { text: text || '' };
    if (image) payload.image = image;
    if (video) {
      if (typeof video === 'object' && video.url) {
        payload.videoUrl = video.url;
      } else {
        payload.video = video; // 兼容旧的 data URL
      }
    }

    box.value = '';
    autoGrow(box);
    clearAttach();
    $('#btnSend').disabled = true;

    try {
      let data;
      if (state.conv.kind === 'room') {
        data = await request('group', Object.assign({ room: state.conv.id }, payload));
      } else {
        data = await request('msg', Object.assign({ to: state.conv.id }, payload));
      }
      if (data && data.message) {
        appendMessage(data.message);
        scrollBottom(true);
      }
      if (data && data.delivered === false) toast('对方不在线，消息已存入信箱');
      if (state.conv && state.conv.kind === 'room') refreshRooms();
    } catch (e) {
      box.value = text;
      autoGrow(box);
      if (image) {
        state.attachImage = image;
        showAttach(image);
      }
      if (video) {
        state.attachVideo = video;
        showVideoAttach(video);
      }
      toast(e.message || '发送失败');
    } finally {
      $('#btnSend').disabled = false;
      box.focus();
    }
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  // ================================================================ 图片 / GIF / 视频
  function showAttach(dataUrl) {
    $('#attachImg').src = dataUrl;
    $('#attachImg').hidden = false;
    $('#attachVideo').hidden = true;
    $('#attach').hidden = false;
  }

  function showVideoAttach(dataUrl) {
    $('#attachVideo').src = dataUrl;
    $('#attachVideo').hidden = false;
    $('#attachImg').hidden = true;
    $('#attach').hidden = false;
  }

  function clearAttach() {
    state.attachImage = null;
    state.attachVideo = null;
    $('#attach').hidden = true;
    $('#attachImg').removeAttribute('src');
    $('#attachVideo').removeAttribute('src');
    $('#fileImage').value = '';
    $('#fileVideo').value = '';
  }

  /** 读取本地文件为 data URL（保持原始编码，适合 GIF/视频这类不能重编码的） */
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('文件读不出来'));
      fr.readAsDataURL(file);
    });
  }

  /** 按最长边缩放并用 JPEG 压缩，直到体积小于上限 */
  function compress(file, maxSide, startQuality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let side = maxSide;
        let quality = startQuality;
        const draw = () => {
          const scale = Math.min(1, side / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          if (dataUrl.length <= MAX_IMAGE_CHARS) return resolve(dataUrl);
          if (quality > 0.45) {
            quality -= 0.12;
            return draw();
          }
          if (side > 480) {
            side = Math.round(side * 0.75);
            quality = startQuality;
            return draw();
          }
          reject(new Error('图片太大，压不下去，换一张吧'));
        };
        draw();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('这张图读不出来'));
      };
      img.src = url;
    });
  }

  async function pickImage(file) {
    if (!file) return;
    try {
      let dataUrl;
      if (file.type === 'image/gif') {
        // GIF 走原样内联，保持动画（重编码会变成静态 JPEG）
        dataUrl = await fileToDataUrl(file);
        if (dataUrl.length > MAX_MEDIA_CHARS) {
          toast('这张动图太大（上限约 1.1MB），换一个小点的吧');
          return;
        }
      } else {
        dataUrl = await compress(file, 1280, 0.82);
      }
      state.attachImage = dataUrl;
      showAttach(dataUrl);
      $('#input').focus();
    } catch (e) {
      toast(e.message);
    }
  }

    /** 分块上传视频/动图到网关，返回 { url, size, name } */
  async function uploadFile(file) {
    const CHUNK = 4 * 1024 * 1024; // 与网关 MAX_CHUNK_SIZE 一致
    const total = Math.max(1, Math.ceil(file.size / CHUNK));
    const qname = encodeURIComponent(file.name);
    let finalUrl = null;
    let lastTotal = total;
    for (let i = 0; i < total; i++) {
      const blob = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
      const res = await fetch('/upload?name=' + qname + '&chunk=' + i + '&total=' + total, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.ok === false) {
        throw new Error((json && json.message) || ('上传失败 chunk ' + (i + 1)));
      }
      lastTotal = json.total || total;
      if (json.url) finalUrl = json.url; // 最后一块返回完成 URL
    }
    if (!finalUrl) throw new Error('上传未完成');
    return { url: finalUrl, size: file.size, name: file.name };
  }

  async function pickVideo(file) {
    if (!file) return;
    try {
      toast('正在上传视频…');
      const up = await uploadFile(file);
      state.attachVideo = up; // { url, size, name }
      showVideoAttach(up.url);
      $('#input').focus();
    } catch (e) {
      toast(e.message || '上传失败');
    }
  }

// ================================================================ 抽屉
  function closeDrawers() {
    $('#sidebar').classList.remove('open');
    $('#membersPanel').classList.remove('open');
    $('#scrim').hidden = true;
  }

  function toggleDrawer(el) {
    const open = !el.classList.contains('open');
    closeDrawers();
    if (open) {
      el.classList.add('open');
      $('#scrim').hidden = false;
    }
  }

  // ================================================================ 绑定
  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const u = $('#inputUser').value.trim();
    const p = $('#inputPass').value;
    const err = $('#loginErr');
    err.textContent = '';
    if (!u || !p) {
      err.textContent = '用户名和密码都要填';
      return;
    }
    setBtnBusy('#btnLogin', true, '登录中…');
    try {
      await connect();
      await login(u, p, false);
    } catch (e) {
      if (e.code === 'not_verified') {
        // 账号已注册但还没通过邮箱验证，自动切到验证码态
        $('#verifyHint').textContent = `${u} 待邮箱验证，请先获取验证码`;
        $('#verifySection').hidden = false;
        $('#inputVerify').focus();
        err.textContent = '该账号尚未验证，请在下方输入邮箱验证码';
      } else {
        err.textContent = e.message || '登录失败';
        state.manualClose = true;
        try {
          state.ws && state.ws.close();
        } catch (_) {}
        state.manualClose = false;
      }
    } finally {
      setBtnBusy('#btnLogin', false, '登录');
    }
  });

  // 注册
  $('#btnRegister').addEventListener('click', async () => {
    const u = $('#inputUser').value.trim();
    const p = $('#inputPass').value;
    const e = $('#inputEmail').value.trim();
    const err = $('#loginErr');
    err.textContent = '';
    if (!u || !p || !e) {
      err.textContent = '注册需要填用户名、密码、邮箱';
      return;
    }
    setBtnBusy('#btnRegister', true, '发送中…');
    try {
      await connect();
      await registerAccount(u, p, e);
    } catch (ee) {
      err.textContent = ee.message || '注册失败';
      state.manualClose = true;
      try {
        state.ws && state.ws.close();
      } catch (_) {}
      state.manualClose = false;
    } finally {
      setBtnBusy('#btnRegister', false, '注册');
    }
  });

  // 确认验证
  $('#btnVerify').addEventListener('click', async () => {
    const u = $('#inputUser').value.trim() || state.pendingVerifyUser;
    const code = $('#inputVerify').value.trim();
    const err = $('#loginErr');
    err.textContent = '';
    if (!u || !code) {
      err.textContent = '请输入验证码';
      return;
    }
    setBtnBusy('#btnVerify', true, '验证中…');
    try {
      await connect();
      await verifyAccount(u, code);
    } catch (ee) {
      err.textContent = ee.message || '验证失败';
    } finally {
      setBtnBusy('#btnVerify', false, '确认验证');
    }
  });

  // 重发验证码
  $('#btnResend').addEventListener('click', async () => {
    const err = $('#loginErr');
    err.textContent = '';
    setBtnBusy('#btnResend', true, '重发中…');
    try {
      await connect();
      await resendCode();
    } catch (ee) {
      err.textContent = ee.message || '重发失败';
    } finally {
      setBtnBusy('#btnResend', false, '重发');
    }
  });

  /** 通用按钮忙碌态 */
  function setBtnBusy(sel, busy, text) {
    const b = $(sel);
    if (busy) {
      b.dataset.origText = text || b.textContent;
      b.disabled = true;
      b.textContent = text || '处理中…';
    } else {
      b.disabled = false;
      b.textContent = b.dataset.origText || b.textContent;
    }
  }

  $('#btnSend').addEventListener('click', sendMessage);

  const input = $('#input');
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', () => autoGrow(input));

  $('#btnImage').addEventListener('click', () => $('#fileImage').click());
  $('#fileImage').addEventListener('change', (ev) => pickImage(ev.target.files[0]));
  $('#btnVideo').addEventListener('click', () => $('#fileVideo').click());
  $('#fileVideo').addEventListener('change', (ev) => pickVideo(ev.target.files[0]));
  $('#btnAttachClear').addEventListener('click', clearAttach);

  $('#meAvatar').addEventListener('click', () => $('#fileAvatar').click());
  $('#fileAvatar').addEventListener('change', (ev) => pickAvatar(ev.target.files[0]));

  // 拖拽发图
  document.addEventListener('dragover', (ev) => {
    if (state.authed) ev.preventDefault();
  });
  document.addEventListener('drop', (ev) => {
    if (!state.authed) return;
    ev.preventDefault();
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) pickImage(f);
    else if (f && f.type.startsWith('video/')) pickVideo(f);
  });

  $('#btnNewRoom').addEventListener('click', async () => {
    const name = prompt('群名（1–32 位，中文 / 字母 / 数字 / _ . -）');
    if (!name) return;
    const clean = name.trim();
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5.\-]{1,32}$/.test(clean)) {
      toast('群名只能用中文、字母、数字、_ . -，1–32 位');
      return;
    }
    try {
      await request('join', { room: clean }).catch((e) => {
        if (e.code !== 'already_in_room') throw e;
      });
      await refreshRooms();
      await openConv('room', clean);
    } catch (e) {
      toast(e.message || '建群失败');
    }
  });

  $('#btnRefreshWho').addEventListener('click', refreshWho);
  $('#btnMembers').addEventListener('click', () => toggleDrawer($('#membersPanel')));
  $('#btnCloseMembers').addEventListener('click', closeDrawers);
  $('#btnMenu').addEventListener('click', () => toggleDrawer($('#sidebar')));
  $('#scrim').addEventListener('click', closeDrawers);

  $('#btnLogout').addEventListener('click', () => {
    state.manualClose = true;
    try {
      send({ type: 'quit' });
    } catch (_) {}
    try {
      state.ws.close();
    } catch (_) {}
    state.authed = false;
    state.ws = null;
    state.conv = null;
    state.creds = null;
    state.retry = 0;
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#inputPass').value = '';
    setTimeout(() => {
      state.manualClose = false;
    }, 300);
  });

  // ================================================================ 启动
  (function boot() {
    let last = '';
    try {
      last = localStorage.getItem('nc.web.user') || '';
    } catch (_) {}
    if (last) $('#inputUser').value = last;
    $('#inputPass').focus();
    if (last) $('#inputUser').blur(), $('#inputPass').focus();
  })();
})();
