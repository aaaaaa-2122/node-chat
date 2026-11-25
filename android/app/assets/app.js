/**
 * Node Chat 安卓端
 * ---------------------------------------------------------------
 * 运行在 WebView 里，通过 Java 桥（AndroidBridge）收发 TCP 帧：
 *   JS --AndroidBridge.send(json)--> LocalChatClient --TCP--> 服务端
 *   服务端 --TCP--> LocalChatClient --window.__onFrame(json)--> JS
 *
 * 本次改进：
 *   · 会话列表（群聊 / 私聊 / 在线）代替原来的「群条 + 输入对方用户名」
 *   · 登录页记住用过的服务器地址，点一下即可回填
 *   · 与桌面端一致的浅色卡片风格、消息气泡、图片预览与头像
 */
(function () {
  'use strict';

  var BRIDGE = (typeof AndroidBridge !== 'undefined') ? AndroidBridge : null;

  // ------------------------------------------------------------ 协议
  var C2S = {
    AUTH: 'auth', MSG: 'msg', GROUP: 'group', JOIN: 'join', LEAVE: 'leave',
    ROOMS: 'rooms', MEMBERS: 'members', WHO: 'who', HISTORY: 'history',
    PROFILE: 'profile', PING: 'ping'
  };
  var S2C = {
    AUTH_OK: 'auth_ok', AUTH_ERR: 'auth_err', MSG: 'msg', GROUP: 'group',
    JOIN_OK: 'join_ok', LEAVE_OK: 'leave_ok', ROOMS: 'rooms', MEMBERS: 'members',
    WHO: 'who', HISTORY: 'history', PROFILE: 'profile', ACK: 'ack', ERROR: 'error',
    PONG: 'pong', SYSTEM: 'system', PRESENCE: 'presence'
  };

  var IMAGE_MAX_SIDE = 1280;
  var IMAGE_QUALITY = 0.78;
  var AVATAR_MAX_SIDE = 160;
  var AVATAR_QUALITY = 0.8;
  var MAX_DATA_URL = 550 * 1000;
  var SRV_KEY = 'nc.servers.v1';
  var LAST_KEY = 'nc.last.v1';

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ 状态
  var state = {
    connected: false,
    me: '',
    serverName: '',
    isLocal: true,
    rooms: [],
    convs: {},
    current: null,
    tab: 'group',
    online: {},
    avatars: {},
    members: [],
    joined: {},
    pendingAvatar: {},
    localPort: 9099,
    localOnline: 0,
    pendingLogin: null,
    chatPushed: false
  };

  // ------------------------------------------------------------ 客户端
  var client = {
    seq: 0,
    pending: {},

    request: function (type, data, timeout) {
      var self = this;
      if (!BRIDGE) return Promise.reject(new Error('当前环境不支持网络连接'));
      var id = 'r' + (++this.seq) + '_' + Date.now().toString(36);
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          delete self.pending[id];
          reject(new Error('请求超时，请检查服务端'));
        }, timeout || 12000);
        self.pending[id] = { resolve: resolve, reject: reject, timer: timer };
        try {
          BRIDGE.send(JSON.stringify({ type: type, id: id, data: data || {} }));
        } catch (e) {
          clearTimeout(timer);
          delete self.pending[id];
          reject(e);
        }
      });
    },

    send: function (type, data) {
      if (!BRIDGE) return;
      try { BRIDGE.send(JSON.stringify({ type: type, data: data || {} })); } catch (e) { }
    },

    /** 掉线时立刻让所有挂起的请求失败，别让界面等 12 秒超时 */
    failAll: function (msg) {
      var self = this;
      Object.keys(this.pending).forEach(function (id) {
        var p = self.pending[id];
        delete self.pending[id];
        clearTimeout(p.timer);
        p.reject(new Error(msg || '连接已断开'));
      });
    },

    handle: function (frame) {
      var id = frame.id;
      if (id && this.pending[id]) {
        var p = this.pending[id];
        delete this.pending[id];
        clearTimeout(p.timer);
        if (frame.type === S2C.ERROR) {
          p.reject(new Error((frame.data && frame.data.message) || '服务端返回错误'));
        } else {
          p.resolve(frame.data || {});
        }
        return;
      }
      var d = frame.data || {};
      switch (frame.type) {
        case S2C.AUTH_OK: onAuthOk(d); break;
        case S2C.AUTH_ERR: onAuthErr(d); break;
        case S2C.MSG: onIncoming(d, false); break;
        case S2C.GROUP: onIncoming(d, true); break;
        case S2C.SYSTEM: onSystem(d); break;
        case S2C.PRESENCE: onPresence(d); break;
        case S2C.WHO: onWho(d); break;
        case S2C.ROOMS: onRooms(d); break;
        case S2C.MEMBERS: onMembers(d); break;
        case S2C.HISTORY: onHistory(d); break;
        case S2C.PROFILE: onProfile(d); break;
        case S2C.JOIN_OK: onJoinOk(d); break;
        case S2C.ERROR: toast((d && d.message) || '服务端错误'); break;
        default: break;
      }
    }
  };

  window.__onFrame = function (frame) {
    try { client.handle(frame); } catch (e) { console.error('frame error', e); }
  };

  window.__onStatus = function (info) {
    if (info && info.connected) {
      state.connected = true;
      $('dot').classList.add('on');
      return;
    }
    state.connected = false;
    $('dot').classList.remove('on');
    if (state.me) client.failAll('连接已断开');
    if (info && info.error) {
      // 认证失败时服务端会先回 auth_err 再断开，别让「连接已断开」盖掉更具体的原因
      if (Date.now() - (state.authErrAt || 0) > 1500) setLoginMsg(info.error, false);
      var bt = $('btnConnect');
      bt.disabled = false;
      bt.textContent = '连　接';
      if (!$('app').classList.contains('hidden')) {
        toast(state.me ? '网络中断，正在自动重连…' : ('连接已断开：' + info.error));
      }
    }
    // 已登录状态下掉线（锁屏、被系统冻结、切后台都可能）→ 自动重连
    if (!$('app').classList.contains('hidden')) scheduleReconnect(false);
  };

  // ------------------------------------------------------------ 断线重连
  var reconnectTimer = null;
  var reconnectTry = 0;

  function scheduleReconnect(immediate) {
    if (state.loggingOut || !state.me || !state.pendingLogin) return;
    if (state.connected) return;
    if (immediate) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    } else if (reconnectTimer) {
      return;
    }
    var delay = immediate ? 0 : Math.min(8000, 700 * (reconnectTry + 1));
    reconnectTry++;
    setConnBanner('已断开，' + (delay ? Math.round(delay / 100) / 10 + ' 秒后重连…' : '正在重连…'));
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (state.loggingOut || state.connected) return;
      var p = state.pendingLogin;
      try { BRIDGE.connect(p.host, p.port, p.user, p.pass); } catch (e) { }
    }, delay);
  }

  function setConnBanner(text) {
    var el = $('meSub');
    if (el && !$('app').classList.contains('hidden')) el.textContent = text || '';
  }

  // 从后台切回前台时立刻补一次重连（系统冻结进程后 socket 往往是死的）
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.me && !state.connected && !state.loggingOut) scheduleReconnect(true);
  });

  window.__onServerInfo = function (info) {
    if (!info) return;
    if (info.running) {
      state.localPort = info.port || 9099;
      state.localOnline = info.online || 0;
      $('tip').textContent = '内置服务端 127.0.0.1:' + state.localPort +
        '（在线 ' + state.localOnline + ' 人）· 首次登录自动注册';
      renderServers();
    }
  };

  // ------------------------------------------------------------ 登录
  function loadServers() {
    try {
      var v = JSON.parse(localStorage.getItem(SRV_KEY) || '[]');
      return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
    } catch (e) { return []; }
  }

  function saveServers(list) {
    try { localStorage.setItem(SRV_KEY, JSON.stringify(list.slice(0, 8))); } catch (e) { }
  }

  function rememberServer(host, port, user) {
    if (!host) return;
    host = host.trim();
    if (!host || host === '127.0.0.1' || host === 'localhost') return;
    var list = loadServers().filter(function (x) {
      return !(x.host === host && String(x.port) === String(port));
    });
    list.unshift({ host: host, port: String(port || 9099), user: user || '', last: Date.now() });
    saveServers(list);
  }

  function whenText(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    if (now - d < 86400000 * 2) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function renderServers() {
    var wrap = $('serverChips');
    wrap.innerHTML = '';

    var local = document.createElement('button');
    local.className = 'schip local';
    local.innerHTML = '<b>本机 · 127.0.0.1</b><small>内置服务端 :' + state.localPort + '</small>';
    local.onclick = function () {
      $('host').value = '';
      $('port').value = '';
      $('username').focus();
    };
    wrap.appendChild(local);

    var list = loadServers();
    if (!list.length) {
      var hint = document.createElement('div');
      hint.className = 'chips-empty';
      hint.textContent = '还没有记录，登录一次后会自动记住';
      wrap.appendChild(hint);
      return;
    }

    list.forEach(function (item) {
      var b = document.createElement('button');
      b.className = 'schip';
      var b1 = document.createElement('b');
      b1.textContent = item.host + ':' + item.port;
      var b2 = document.createElement('small');
      b2.textContent = (item.user || '未知用户') + ' · ' + whenText(item.last);
      b.appendChild(b1);
      b.appendChild(b2);
      b.onclick = function () {
        $('host').value = item.host;
        $('port').value = item.port;
        $('username').value = item.user || '';
        $('password').focus();
      };
      var del = document.createElement('span');
      del.className = 'del';
      del.textContent = '×';
      del.onclick = function (ev) {
        ev.stopPropagation();
        saveServers(loadServers().filter(function (x) {
          return !(x.host === item.host && String(x.port) === String(item.port));
        }));
        renderServers();
        toast('已删除该记录');
      };
      b.appendChild(del);
      wrap.appendChild(b);
    });
  }

  function setLoginMsg(text, ok) {
    var el = $('loginMsg');
    el.textContent = text || '';
    el.className = 'login-msg' + (ok ? ' ok' : '');
  }

  function restoreLast() {
    var last = null;
    try { last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) { }
    if (last && last.user) {
      $('host').value = last.host || '';
      $('port').value = last.port || '';
      $('username').value = last.user;
    }
  }

  $('btnConnect').onclick = function () {
    if (!BRIDGE) { setLoginMsg('当前环境缺少 AndroidBridge，请用 App 打开', false); return; }
    var host = $('host').value.trim();
    var port = $('port').value.trim();
    var user = $('username').value.trim();
    var pass = $('password').value;

    // 支持直接粘贴 host:port
    if (host.indexOf(':') > 0 && host.indexOf('://') < 0) {
      var idx = host.lastIndexOf(':');
      var p = host.slice(idx + 1);
      if (/^\d+$/.test(p)) { port = p; host = host.slice(0, idx); }
    }
    if (!user) { setLoginMsg('请填写用户名', false); $('username').focus(); return; }
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5.\-]{1,24}$/.test(user)) {
      setLoginMsg('用户名 1~24 位，支持字母/数字/中文/下划线', false);
      return;
    }
    // 密码可选：服务端开启 requirePassword 才必须填，局域网默认留空即可登录
    if (port && !/^\d{1,5}$/.test(port)) { setLoginMsg('端口格式不正确', false); return; }

    state.pendingLogin = { host: host, port: port, user: user, pass: pass };
    state.isLocal = !host || host === '127.0.0.1' || host === 'localhost';

    var btn = $('btnConnect');
    btn.disabled = true;
    btn.textContent = '连接中…';
    setLoginMsg('正在连接 ' + (host || '127.0.0.1') + ':' + (port || state.localPort) + ' …', true);

    BRIDGE.connect(host, port, user, pass);
    setTimeout(function () {
      if (!state.connected) {
        btn.disabled = false;
        btn.textContent = '连　接';
        setLoginMsg('连接超时：请确认服务端已启动、手机与电脑在同一网络', false);
      }
    }, 6500);
  };

  // ------------------------------------------------------------ 认证
  function onAuthOk(d) {
    state.connected = true;
    state.loggingOut = false;
    reconnectTry = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    state.me = d.user || '';
    state.serverName = d.server || '';
    state.rooms = d.rooms || [];
    if (d.avatar) state.avatars[state.me] = d.avatar;

    var p = state.pendingLogin || { host: '', port: '', user: state.me };
    if ($('remember').checked) {
      rememberServer(p.host, p.port, state.me);
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({
          host: p.host, port: p.port, user: state.me
        }));
      } catch (e) { }
    }

    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('meName').textContent = state.me;
    $('meSub').textContent = state.isLocal ? '内置服务端 · 在线 1 人' : (p.host + ':' + p.port);
    renderMyAvatar();
    renderServers();
    setLoginMsg('', true);

    // 加入所有群，保证任何群的新消息都能收到
    state.rooms.forEach(function (r) {
      if (!r || !r.name) return;
      state.joined[r.name] = true;
      client.send(C2S.JOIN, { room: r.name });
    });

    client.send(C2S.WHO, {});
    renderLists();

    var lastKey = '';
    try { lastKey = localStorage.getItem('nc.lastRoom') || ''; } catch (e) { }
    var first = '';
    if (state.rooms.length) first = 'room:' + state.rooms[0].name;
    if (lastKey && (/^room:/.test(lastKey) || /^dm:/.test(lastKey))) first = lastKey;
    // 断线重连时保持在原来那个会话，不要跳回列表第一个群
    if (state.current) first = state.current;
    if (first) openChat(first, true, true);

    toast('已登录：' + state.me);
  }

  function onAuthErr(d) {
    state.connected = false;
    state.authErrAt = Date.now();
    var btn = $('btnConnect');
    btn.disabled = false;
    btn.textContent = '连　接';
    setLoginMsg((d && d.message) || '认证失败', false);
  }

  // ------------------------------------------------------------ 会话数据
  function ensureConv(key) {
    var c = state.convs[key];
    if (c) return c;
    var isRoom = key.indexOf('room:') === 0;
    c = {
      key: key,
      isRoom: isRoom,
      name: key.slice(isRoom ? 5 : 3),
      messages: [],
      unread: 0,
      preview: '',
      lastTs: 0,
      loaded: false
    };
    state.convs[key] = c;
    return c;
  }

  function norm(m, isRoom) {
    var ts = m.ts || Date.now();
    return {
      id: m.id || ('x' + ts + Math.random()),
      room: m.room || '',
      from: m.from || '',
      to: m.to || '',
      text: m.text || '',
      image: m.image || '',
      file: m.file || null,
      mentions: m.mentions || null,
      ts: ts,
      mine: (m.from || '') === state.me,
      system: false,
      notice: false,
      offline: !!m.offline
    };
  }

  function previewOf(m) {
    if (m.text) return m.text.replace(/\s+/g, ' ');
    if (m.file) return '[文件] ' + (m.file.name || '');
    if (m.image) return '[图片]';
    return '';
  }

  function put(c, m, countUnread) {
    if (m.id) {
      for (var i = c.messages.length - 1; i >= 0; i--) {
        if (c.messages[i].id === m.id) return false;
      }
    }
    c.messages.push(m);
    if (c.messages.length > 400) c.messages.splice(0, c.messages.length - 400);
    c.lastTs = m.ts;
    c.preview = previewOf(m);
    if (countUnread) c.unread = (c.unread || 0) + 1;
    else if (state.current === c.key) c.unread = 0;
    return true;
  }

  // ------------------------------------------------------------ 收消息
  function onIncoming(d, isRoom) {
    var m = norm(d, isRoom);
    var key = isRoom ? 'room:' + m.room : 'dm:' + (m.mine ? m.to : m.from);
    var c = ensureConv(key);
    if (!isRoom) c.name = m.mine ? m.to : m.from;

    var isCurrent = state.current === key;
    if (put(c, m, !m.mine && !isCurrent)) {
      if (isCurrent) appendMessageNode(c, m);
      ensureAvatar(m.from);
      renderLists();
      if (!m.mine) {
        if (!isCurrent) toast(d.offline ? ('离线留言 · ' + m.from + '：' + previewOf(m)) : (m.from + '：' + previewOf(m)));
      }
    }
  }

  function onSystem(d) {
    if (!d) return;
    switch (d.event) {
      case 'welcome':
        state.serverName = d.server || state.serverName;
        break;
      case 'announcement':
        addSystem('公告 · ' + (d.text || ''), true);
        toast('公告：' + (d.text || ''));
        break;
      case 'avatar':
        if (d.user) {
          state.avatars[d.user] = d.avatar || '';
          if (d.user === state.me) renderMyAvatar();
          refreshAvatars();
        }
        break;
      case 'member_joined':
      case 'member_left':
        if (state.current === 'room:' + d.room) {
          client.send(C2S.MEMBERS, { room: d.room });
        }
        refreshRooms();
        break;
      case 'user_joined':
      case 'user_left':
        scheduleWho();
        break;
      default:
        break;
    }
  }

  function addSystem(text, notice) {
    if (!state.current) return;
    var c = ensureConv(state.current);
    var m = {
      id: 's' + Date.now() + Math.random(),
      ts: Date.now(),
      system: true,
      notice: !!notice,
      text: text,
      from: '',
      to: '',
      room: c.isRoom ? c.name : '',
      image: '',
      mine: false
    };
    c.messages.push(m);
    appendMessageNode(c, m);
  }

  function onPresence(p) {
    if (!p || !p.user) return;
    state.online[p.user] = !!p.online;
    scheduleWho();
  }

  var whoTimer = null;
  function scheduleWho() {
    if (whoTimer) return;
    whoTimer = setTimeout(function () {
      whoTimer = null;
      client.send(C2S.WHO, {});
    }, 700);
  }

  function onWho(d) {
    var map = {};
    (d.users || []).forEach(function (u) { if (u) map[u] = true; });
    state.online = map;
    var av = d.avatars || {};
    for (var u in av) {
      if (Object.prototype.hasOwnProperty.call(av, u)) state.avatars[u] = av[u];
    }
    renderMyAvatar();
    $('meSub').textContent = state.isLocal
      ? ('内置服务端 · 在线 ' + (d.users || []).length + ' 人')
      : ((state.pendingLogin && state.pendingLogin.host ? state.pendingLogin.host + ':' + state.pendingLogin.port + ' · ' : '') + '在线 ' + (d.users || []).length + ' 人');
    renderLists();
    updateChatSub();
    refreshAvatars();
  }

  function onRooms(d) {
    state.rooms = d.rooms || [];
    renderLists();
  }

  function onMembers(d) {
    if (!d || state.current !== 'room:' + d.room) return;
    state.members = d.members || [];
    updateChatSub();
  }

  function onJoinOk(d) {
    if (!d || !d.room) return;
    state.joined[d.room] = true;
    var exists = false;
    state.rooms.forEach(function (r) { if (r.name === d.room) exists = true; });
    if (!exists) {
      state.rooms.push({ name: d.room, memberCount: (d.members || []).length });
      state.rooms.sort(function (a, b) { return a.name.localeCompare(b.name); });
      renderLists();
    }
    if (state.current === 'room:' + d.room) openChat('room:' + d.room, false, true);
  }

  function onProfile(d) {
    if (!d || !d.user) return;
    state.avatars[d.user] = d.avatar || '';
    if (d.user === state.me) renderMyAvatar();
    refreshAvatars();
  }

  function onHistory(d) {
    var key = d.scope === 'room' ? 'room:' + d.room : 'dm:' + d.with;
    var c = ensureConv(key);
    var list = d.messages || [];
    var merged = [];
    var seen = {};

    list.forEach(function (raw) {
      var m = norm(raw, d.scope === 'room');
      if (m.id && seen[m.id]) return;
      if (m.id) seen[m.id] = true;
      merged.push(m);
    });
    c.messages.forEach(function (m) {
      if (m.system) { merged.push(m); return; }
      if (m.id && seen[m.id]) return;
      if (m.id) seen[m.id] = true;
      merged.push(m);
    });
    merged.sort(function (a, b) { return a.ts - b.ts; });
    c.messages = merged;
    c.loaded = true;
    if (merged.length) {
      c.lastTs = merged[merged.length - 1].ts;
      c.preview = previewOf(merged[merged.length - 1]);
    }
    merged.forEach(function (m) { if (!m.system) ensureAvatar(m.from); });
    if (state.current === key) renderMessages();
    renderLists();
  }

  // ------------------------------------------------------------ 列表渲染
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var PALETTE = ['#5e81f4', '#5bbf9c', '#f49c5c', '#d676bf', '#68b2dc', '#e88282', '#9689ea', '#efb054'];

  function colorOf(name) {
    var sum = 0;
    name = name || '?';
    for (var i = 0; i < name.length; i++) sum = (sum * 31 + name.charCodeAt(i)) & 0x7fffffff;
    return PALETTE[sum % PALETTE.length];
  }

  function avatarHtml(user) {
    var url = state.avatars[user];
    if (url) return '<img src="' + url + '" alt="">';
    return '<span class="initial" style="background:' + colorOf(user) + '">' +
      (user || '?').charAt(0).toUpperCase() + '</span>';
  }

  function avatarNode(user, round) {
    var box = el('div', 'row-avatar' + (round ? ' round avatar' : ''));
    box.innerHTML = avatarHtml(user);
    return box;
  }

  function renderLists() {
    renderRooms();
    renderDms();
    renderOnline();
    updateTabBadges();
  }

  /** 底部标签上的未读合计：切到别的标签时也能看到有多少条没读 */
  function sumUnread(prefix) {
    var n = 0;
    for (var k in state.convs) {
      if (Object.prototype.hasOwnProperty.call(state.convs, k) && k.indexOf(prefix) === 0) {
        n += (state.convs[k].unread || 0);
      }
    }
    return n;
  }

  function updateTabBadges() {
    var map = { group: sumUnread('room:'), dm: sumUnread('dm:') };
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var old = tab.querySelector('.badge');
      if (old) tab.removeChild(old);
      var n = map[tab.getAttribute('data-tab')] || 0;
      if (n > 0) tab.appendChild(el('span', 'badge', n > 99 ? '99+' : String(n)));
    }
  }

  function emptyNode(icon, title, sub) {
    var box = el('div', 'empty');
    var ic = el('div', 'big-icon', icon);
    box.appendChild(ic);
    box.appendChild(el('b', '', title));
    var s = el('span', '', sub);
    box.appendChild(s);
    return box;
  }

  function renderRooms() {
    var list = $('roomList');
    list.innerHTML = '';
    if (!state.rooms.length) {
      list.appendChild(emptyNode('💬', '还没有群聊', '点右下角 ＋ 建一个'));
      return;
    }
    state.rooms.forEach(function (r) {
      var c = state.convs['room:' + r.name] || null;
      var row = el('button', 'row-item');
      row.appendChild(avatarNode('#' + r.name, false));
      var main = el('div', 'row-main');
      var title = el('div', 'row-title');
      title.appendChild(el('span', '', r.name));
      if (c && c.unread > 0) title.appendChild(el('span', 'badge', c.unread > 99 ? '99+' : String(c.unread)));
      main.appendChild(title);
      main.appendChild(el('div', 'row-sub', c && c.preview ? c.preview : (r.memberCount ? r.memberCount + ' 位成员' : '暂无消息')));
      row.appendChild(main);
      var side = el('div', 'row-side');
      side.appendChild(el('div', 'row-time', c && c.lastTs ? whenText(c.lastTs) : ''));
      row.appendChild(side);
      row.onclick = function () { openChat('room:' + r.name); };
      list.appendChild(row);
    });
  }

  function renderDms() {
    var list = $('dmList');
    list.innerHTML = '';
    var arr = [];
    for (var k in state.convs) {
      if (Object.prototype.hasOwnProperty.call(state.convs, k) && k.indexOf('dm:') === 0) arr.push(state.convs[k]);
    }
    arr.sort(function (a, b) { return b.lastTs - a.lastTs; });
    if (!arr.length) {
      list.appendChild(emptyNode('✉️', '还没有私聊', '去「在线」里点一个用户开始'));
      return;
    }
    arr.forEach(function (c) {
      var row = el('button', 'row-item');
      row.appendChild(avatarNode(c.name, true));
      var main = el('div', 'row-main');
      var title = el('div', 'row-title');
      title.appendChild(el('span', '', c.name));
      if (c.unread > 0) title.appendChild(el('span', 'badge', c.unread > 99 ? '99+' : String(c.unread)));
      main.appendChild(title);
      main.appendChild(el('div', 'row-sub', c.preview || '开始聊天'));
      row.appendChild(main);
      var side = el('div', 'row-side');
      if (state.online[c.name]) side.appendChild(el('div', 'online-dot'));
      side.appendChild(el('div', 'row-time', c.lastTs ? whenText(c.lastTs) : ''));
      row.appendChild(side);
      row.onclick = function () { openChat('dm:' + c.name); };
      list.appendChild(row);
    });
  }

  function renderOnline() {
    var list = $('onlineList');
    list.innerHTML = '';
    var users = Object.keys(state.online).sort(function (a, b) { return a.localeCompare(b); });
    if (!users.length) {
      list.appendChild(emptyNode('👤', '暂无在线用户', '等服务端有人上线后刷新'));
      return;
    }
    users.forEach(function (u) {
      var row = el('button', 'row-item');
      row.appendChild(avatarNode(u, true));
      var main = el('div', 'row-main');
      var title = el('div', 'row-title');
      title.appendChild(el('span', '', u + (u === state.me ? '（我）' : '')));
      main.appendChild(title);
      main.appendChild(el('div', 'row-sub', u === state.me ? '这是你' : '点击发私聊'));
      row.appendChild(main);
      var side = el('div', 'row-side');
      side.appendChild(el('div', 'online-dot'));
      row.appendChild(side);
      row.onclick = function () {
        if (u === state.me) { openProfile(); return; }
        openChat('dm:' + u);
      };
      list.appendChild(row);
    });
  }

  function refreshRooms() {
    client.send(C2S.ROOMS, {});
  }

  function refreshAvatars() {
    renderLists();
    var box = $('messages');
    if (!box) return;
    var nodes = box.querySelectorAll('.msg[data-user]');
    for (var i = 0; i < nodes.length; i++) {
      var user = nodes[i].getAttribute('data-user');
      var slot = nodes[i].querySelector('.avatar-slot');
      if (slot) slot.innerHTML = avatarHtml(user);
    }
  }

  function renderMyAvatar() {
    var url = state.avatars[state.me];
    var box = $('meAvatar');
    box.innerHTML = '';
    if (url) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = '';
      box.appendChild(img);
    } else {
      box.textContent = (state.me || '?').charAt(0).toUpperCase();
    }
  }

  function ensureAvatar(user) {
    if (!user || user === state.me) return;
    if (state.avatars[user] || state.pendingAvatar[user]) return;
    state.pendingAvatar[user] = true;
    client.request(C2S.PROFILE, { action: 'get', user: user }).then(function (res) {
      state.avatars[res.user] = res.avatar || '';
      if (state.current) renderMessages();
      renderLists();
    }).catch(function () { }).then(function () {
      delete state.pendingAvatar[user];
    });
  }

  // ------------------------------------------------------------ 聊天窗口
  function openChat(key, noPush, silent) {
    var c = ensureConv(key);
    state.current = key;
    c.unread = 0;
    state.members = [];
    $('chatName').textContent = c.isRoom ? '#' + c.name : c.name;
    updateChatSub();
    renderMessages();
    $('chat').classList.add('open');
    $('attachBar').classList.add('hidden');
    clearAttach();

    if (!state.chatPushed && noPush !== false) {
      try { history.pushState({ chat: 1 }, ''); state.chatPushed = true; } catch (e) { }
    }

    if (c.isRoom) {
      if (!state.joined[c.name]) {
        state.joined[c.name] = true;
        client.send(C2S.JOIN, { room: c.name });
      }
      client.send(C2S.MEMBERS, { room: c.name });
      client.send(C2S.HISTORY, { room: c.name, limit: 80 });
    } else {
      client.send(C2S.HISTORY, { to: c.name, limit: 80 });
    }
    renderLists();
    if (!silent) setTimeout(scrollBottom, 40);
  }

  function updateChatSub() {
    var c = state.current ? state.convs[state.current] : null;
    if (!c) { $('chatSub').textContent = ''; return; }
    if (c.isRoom) {
      var onlineCount = 0;
      state.members.forEach(function (u) { if (state.online[u]) onlineCount++; });
      $('chatSub').textContent = (state.members.length ? state.members.length + ' 位成员' : '群聊') +
        (onlineCount ? ' · ' + onlineCount + ' 人在线' : '');
    } else {
      $('chatSub').textContent = state.online[c.name] ? '私聊 · 在线' : '私聊 · 离线';
    }
  }

  function closeChat() {
    if (state.chatPushed) {
      try { history.back(); return; } catch (e) { }
    }
    hideChat();
  }

  function hideChat() {
    $('chat').classList.remove('open');
    state.chatPushed = false;
    state.current = null;
    renderLists();
  }

  window.addEventListener('popstate', function () {
    if ($('chat').classList.contains('open')) hideChat();
  });

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  function dayLabel(ts) {
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return '今天';
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function hhmm(ts) {
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // ------------------------------------------------------------ @ 提及
  var MENTION_RE = /@([A-Za-z0-9_\u4e00-\u9fa5.-]{1,24})/g;

  function parseMentions(text) {
    var out = [];
    if (!text) return out;
    MENTION_RE.lastIndex = 0;
    var m;
    while ((m = MENTION_RE.exec(text))) {
      var name = m[1].replace(/[.-]+$/, '');
      if (name && name !== state.me && out.indexOf(name) < 0) out.push(name);
      if (out.length >= 32) break;
    }
    return out;
  }

  function renderText(node, text, mentions) {
    var names = (mentions && mentions.length) ? mentions : parseMentions(text);
    if (!names.length) { node.textContent = text; return; }
    var set = {};
    names.forEach(function (n) { set[n] = true; });
    MENTION_RE.lastIndex = 0;
    var last = 0;
    var m;
    while ((m = MENTION_RE.exec(text))) {
      var name = m[1].replace(/[.-]+$/, '');
      if (!set[name]) continue;
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      var at = el('span', 'at', '@' + name);
      node.appendChild(at);
      var tail = m[0].slice(1 + name.length);
      if (tail) node.appendChild(document.createTextNode(tail));
      last = m.index + m[0].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }

  function insertMention(name) {
    var box = $('inputText');
    if (!box) return;
    var token = '@' + name + ' ';
    var start = box.selectionStart == null ? box.value.length : box.selectionStart;
    var before = box.value.slice(0, start);
    var needSpace = before && !/\s$/.test(before);
    box.value = before + (needSpace ? ' ' : '') + token + box.value.slice(box.selectionEnd);
    autoGrow();
    box.focus();
  }

  /** 长按（手机上就是「右键」）→ 插入 @某人 */
  function bindMention(node, name) {
    if (!name) return;
    var timer = null;
    function clear() { if (timer) { clearTimeout(timer); timer = null; } }
    node.addEventListener('touchstart', function () {
      clear();
      timer = setTimeout(function () {
        timer = null;
        insertMention(name);
        if (window.navigator && navigator.vibrate) navigator.vibrate(12);
      }, 480);
    }, { passive: true });
    node.addEventListener('touchend', clear);
    node.addEventListener('touchmove', clear);
    node.addEventListener('touchcancel', clear);
    node.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      insertMention(name);
    });
  }

  /** 文件气泡：图片给缩略图，其余给「图标 + 名字 + 大小」卡片 */
  function fileCard(f) {
    var wrap = el('div', 'file-wrap');
    var url = fileUrl(f.url);
    var name = f.name || '文件';
    if (isImageFile(name, f.mime)) {
      var img = document.createElement('img');
      img.className = 'photo';
      img.src = url;
      img.alt = name;
      img.onclick = function () { openViewer(url); };
      wrap.appendChild(img);
    }
    var a = document.createElement('a');
    a.className = 'file-card';
    a.href = url;
    a.setAttribute('download', name);
    a.target = '_blank';
    var ico = el('span', 'file-ico', iconOf(name, f.mime));
    a.appendChild(ico);
    var body = el('span', 'file-body');
    body.appendChild(el('b', '', name));
    var meta = fmtSize(f.size);
    body.appendChild(el('span', 'file-meta', (meta ? meta + ' · ' : '') + '点击下载'));
    a.appendChild(body);
    wrap.appendChild(a);
    return wrap;
  }

  function msgNode(m) {
    if (m.system) {
      var s = el('div', 'sys' + (m.notice ? ' notice' : ''), m.text);
      return s;
    }
    var wrap = el('div', 'msg' + (m.mine ? ' me' : ''));
    wrap.setAttribute('data-user', m.from || '');
    if (!m.mine && m.mentions && m.mentions.length && m.mentions.indexOf(state.me) >= 0) {
      wrap.classList.add('at-me');
    }

    if (!m.mine) {
      var slot = el('div', 'row-avatar round avatar avatar-slot');
      slot.innerHTML = avatarHtml(m.from);
      bindMention(slot, m.from);
      wrap.appendChild(slot);
    }

    var col = el('div', 'bubble-wrap');
    if (!m.mine) col.appendChild(el('div', 'who', m.from + ' · ' + hhmm(m.ts)));

    var bubble = el('div', 'bubble');
    if (m.file) bubble.classList.add('has-file');
    if (m.file) bubble.appendChild(fileCard(m.file));
    if (m.image) bubble.classList.add('photo-only');
    if (m.image) {
      var img = document.createElement('img');
      img.className = 'photo';
      img.src = m.image;
      img.alt = '图片';
      img.onclick = function () { openViewer(m.image); };
      bubble.appendChild(img);
    }
    if (m.text) {
      var span = document.createElement('span');
      span.className = (m.image || m.file) ? 'cap' : '';
      renderText(span, m.text, m.mentions);
      bubble.appendChild(span);
    }
    if (m.offline) bubble.appendChild(el('span', 'cap', '（离线补发）'));
    col.appendChild(bubble);

    if (m.mine) col.appendChild(el('div', 'who', hhmm(m.ts)));
    wrap.appendChild(col);
    return wrap;
  }

  function renderMessages() {
    var box = $('messages');
    box.innerHTML = '';
    var c = state.current ? state.convs[state.current] : null;
    if (!c) return;
    if (!c.messages.length) {
      box.appendChild(emptyNode('💬', '还没有消息', '从下面输入第一条吧'));
      return;
    }
    var lastDay = '';
    c.messages.forEach(function (m) {
      if (!m.system) {
        var dk = dayKey(m.ts);
        if (dk !== lastDay) {
          var dnode = el('div', 'day', dayLabel(m.ts));
          dnode.setAttribute('data-day', dk);
          box.appendChild(dnode);
          lastDay = dk;
        }
      }
      box.appendChild(msgNode(m));
    });
    scrollBottom();
  }

  function appendMessageNode(c, m) {
    var box = $('messages');
    if (!box) return;
    var empty = box.querySelector('.empty');
    if (empty) box.removeChild(empty);

    if (!m.system) {
      var nodes = box.querySelectorAll('.day');
      var lastDay = nodes.length ? nodes[nodes.length - 1].getAttribute('data-day') : '';
      var dk = dayKey(m.ts);
      if (dk !== lastDay) {
        var d = el('div', 'day', dayLabel(m.ts));
        d.setAttribute('data-day', dk);
        box.appendChild(d);
      }
    }
    box.appendChild(msgNode(m));
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (nearBottom || m.mine) scrollBottom();
  }

  function scrollBottom() {
    var box = $('messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  // ------------------------------------------------------------ 发送
  var pendingFile = null; // { url, name, size, mime }

  function clearAttach() {
    pendingFile = null;
    $('attachBar').classList.add('hidden');
    $('attachName').textContent = '';
    $('attachIco').textContent = '📄';
    $('attachSub').textContent = '点发送随消息一起发出';
  }

  function setAttach(f) {
    pendingFile = f;
    $('attachIco').textContent = iconOf(f.name, f.mime);
    $('attachName').textContent = f.name;
    $('attachSub').textContent = fmtSize(f.size) + ' · 已上传';
    $('attachBar').classList.remove('hidden');
  }

  function sendCurrent() {
    var c = state.current ? state.convs[state.current] : null;
    if (!c) { toast('请先选择一个会话'); return; }
    var input = $('inputText');
    var text = input.value.replace(/\s+$/, '');
    if (!text && !pendingFile) return;

    var payload = { text: text };
    if (pendingFile) {
      payload.file = { url: pendingFile.url, name: pendingFile.name, size: pendingFile.size, mime: pendingFile.mime };
    }
    var mentions = parseMentions(text);
    if (mentions.length) payload.mentions = mentions;
    var type;
    if (c.isRoom) { payload.room = c.name; type = C2S.GROUP; }
    else { payload.to = c.name; type = C2S.MSG; }

    input.value = '';
    autoGrow();
    clearAttach();

    client.request(type, payload).then(function (res) {
      if (res && res.message) {
        var m = norm(res.message, c.isRoom);
        m.mine = true;
        if (put(c, m, false)) {
          if (state.current === c.key) appendMessageNode(c, m);
          renderLists();
        }
      }
      if (res && res.delivered === false) toast('对方离线，消息已存入信箱');
    }).catch(function (e) {
      toast(e.message || '发送失败');
    });
  }

  function autoGrow() {
    var t = $('inputText');
    t.style.height = 'auto';
    t.style.height = Math.min(108, Math.max(40, t.scrollHeight)) + 'px';
  }

  $('btnSend').onclick = sendCurrent;
  $('inputText').addEventListener('input', autoGrow);

  // ------------------------------------------------------------ 图片
  function compressOnce(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('图片解析失败')); };
        img.onload = function () {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) { reject(new Error('图片尺寸异常')); return; }
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          try { resolve(canvas.toDataURL('image/jpeg', quality)); }
          catch (e) { reject(new Error('图片处理失败')); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function compressImage(file, maxSide, quality, budget) {
    var levels = [
      { side: maxSide, q: quality },
      { side: Math.round(maxSide * 0.75), q: Math.min(quality, 0.62) },
      { side: Math.round(maxSide * 0.5), q: 0.55 },
      { side: Math.round(maxSide * 0.34), q: 0.45 }
    ];
    function attempt(i) {
      if (i >= levels.length) return Promise.reject(new Error('图片过大，请换一张'));
      return compressOnce(file, levels[i].side, levels[i].q).then(function (url) {
        if (url.length <= budget) return url;
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  // ------------------------------------------------------------ 通用文件（走网关 HTTP 上传）
  var FILE_PORT = 8080; // 网页网关默认端口（和服务端在同一台机器上起）
  var FILE_CHUNK = 4 * 1024 * 1024;

  function gatewayHost() {
    var h = (state.pendingLogin && state.pendingLogin.host) || '127.0.0.1';
    if (!h || h === 'localhost') h = '127.0.0.1';
    return 'http://' + h + ':' + FILE_PORT;
  }

  /** 相对路径 /files/xxx 补成绝对地址（手机端不在网关同源下） */
  function fileUrl(u) {
    u = String(u || '');
    return /^https?:\/\//.test(u) ? u : gatewayHost() + u;
  }

  var FILE_ICONS = {
    png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', webp: '🖼', bmp: '🖼', avif: '🖼',
    mp4: '🎬', mov: '🎬', mkv: '🎬', webm: '🎬', avi: '🎬', m4v: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵', m4a: '🎵',
    pdf: '📕', doc: '📝', docx: '📝', txt: '📃', md: '📃', log: '📃',
    xls: '📊', xlsx: '📊', csv: '📊', ppt: '📽', pptx: '📽',
    zip: '🗜', rar: '🗜', '7z': '🗜', tar: '🗜', gz: '🗜',
    exe: '⚙️', apk: '📦', iso: '💽', js: '💻', py: '💻', json: '🧾', html: '🧾'
  };

  function extOf(name) {
    var m = /\.([A-Za-z0-9]{1,12})$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function iconOf(name, mime) {
    var e = extOf(name);
    if (FILE_ICONS[e]) return FILE_ICONS[e];
    var t = String(mime || '');
    if (t.indexOf('image/') === 0) return '🖼';
    if (t.indexOf('video/') === 0) return '🎬';
    if (t.indexOf('audio/') === 0) return '🎵';
    return '📄';
  }

  function fmtSize(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function isImageFile(name, mime) {
    if (String(mime || '').indexOf('image/') === 0) return true;
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].indexOf(extOf(name)) >= 0;
  }

  /** 分块上传到网关，返回 Promise<{url,name,size,mime}> */
  function uploadFile(file) {
    var qname = encodeURIComponent(file.name || 'file');
    var qmime = encodeURIComponent(file.type || '');
    var uploadId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).replace(/[^A-Za-z0-9]/g, '');
    var total = Math.max(1, Math.ceil(file.size / FILE_CHUNK));
    var base = gatewayHost() + '/upload?name=' + qname + '&mime=' + qmime + '&uploadId=' + uploadId;
    var finalUrl = null;

    function postChunk(i) {
      var blob = file.slice(i * FILE_CHUNK, Math.min(file.size, (i + 1) * FILE_CHUNK));
      var url = base + '&chunk=' + i + '&total=' + total;
      return new Promise(function (resolve, reject) {
        if (typeof fetch === 'function') {
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob
          }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (j) {
              if (!res.ok || !j || j.ok === false) {
                reject(new Error((j && (j.message || j.error)) || ('上传失败（第 ' + (i + 1) + '/' + total + ' 块）')));
                return;
              }
              if (j.url) finalUrl = j.url;
              resolve();
            });
          }).catch(function (e) { reject(new Error('连不上文件服务：' + (e.message || e))); });
          return;
        }
        // 老 WebView 没有 fetch，用 XHR
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.onload = function () {
          var j = null;
          try { j = JSON.parse(xhr.responseText); } catch (e) { }
          if (xhr.status < 200 || xhr.status >= 300 || !j || j.ok === false) {
            reject(new Error((j && (j.message || j.error)) || ('上传失败（第 ' + (i + 1) + '/' + total + ' 块）')));
            return;
          }
          if (j.url) finalUrl = j.url;
          resolve();
        };
        xhr.onerror = function () { reject(new Error('连不上文件服务')); };
        xhr.send(blob);
      });
    }

    var chain = Promise.resolve();
    for (var i = 0; i < total; i += 1) {
      (function (idx) { chain = chain.then(function () { return postChunk(idx); }); })(i);
    }
    return chain.then(function () {
      if (!finalUrl) throw new Error('上传未完成');
      return { url: finalUrl, name: file.name, size: file.size, mime: file.type || '' };
    });
  }

  $('btnPickFile').onclick = function () { $('filePick').click(); };
  $('filePick').onchange = function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.size) { toast('空文件就不用发了'); return; }
    toast('正在上传 ' + file.name + '（' + fmtSize(file.size) + '）…', 60000);
    uploadFile(file).then(function (f) {
      setAttach(f);
      toast('已就绪，点发送即可');
    }).catch(function (err) {
      toast((err && err.message) || '上传失败');
      setTimeout(function () {
        toast('文件上传需要电脑上开着网页网关（默认 8080 端口）', 4500);
      }, 1500);
    });
  };

  $('attachRemove').onclick = function () { clearAttach(); };

  // ------------------------------------------------------------ 我的资料
  function openProfile() {
    showSheet('我的资料', function (content) {
      var row = el('div', 'profile-row');
      var av = avatarNode(state.me, true);
      av.style.width = '58px';
      av.style.height = '58px';
      av.style.fontSize = '22px';
      row.appendChild(av);

      var info = el('div', '');
      info.appendChild(el('div', 'profile-name', state.me));
      var sub = el('div', 'profile-sub', (state.isLocal ? '内置服务端' : (state.pendingLogin ? state.pendingLogin.host + ':' + state.pendingLogin.port : '远程服务端')) +
        (state.serverName ? ' · ' + state.serverName : ''));
      info.appendChild(sub);
      row.appendChild(info);
      content.appendChild(row);

      var actions = el('div', 'sheet-actions');
      var b1 = el('button', '', '更换头像');
      b1.onclick = function () { $('avatarFile').click(); };
      actions.appendChild(b1);

      var b2 = el('button', '', '刷新会话与在线列表');
      b2.onclick = function () {
        client.send(C2S.WHO, {});
        client.send(C2S.ROOMS, {});
        toast('已刷新');
        closeSheet();
      };
      actions.appendChild(b2);

      if (state.isLocal) {
        var b3 = el('button', '', '向所有在线用户发公告');
        b3.onclick = function () {
          closeSheet();
          setTimeout(function () {
            promptSheet('发公告', '公告内容', '', function (text) {
              if (BRIDGE && BRIDGE.broadcast) { BRIDGE.broadcast(text); toast('公告已广播'); }
            });
          }, 120);
        };
        actions.appendChild(b3);
      }

      var b4 = el('button', 'danger', '退出登录');
      b4.onclick = function () {
        closeSheet();
        setTimeout(logout, 120);
      };
      actions.appendChild(b4);
      content.appendChild(actions);
    });
  }

  $('meAvatar').onclick = openProfile;

  $('avatarFile').onchange = function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    closeSheet();
    if (!file) return;
    toast('头像处理中…');
    compressImage(file, AVATAR_MAX_SIDE, AVATAR_QUALITY, 100 * 1000).then(function (url) {
      return client.request(C2S.PROFILE, { action: 'set', avatar: url });
    }).then(function (res) {
      state.avatars[state.me] = (res && res.avatar) || '';
      renderMyAvatar();
      refreshAvatars();
      toast('头像已更新');
    }).catch(function (err) { toast(err.message || '设置头像失败'); });
  };

  // ------------------------------------------------------------ 菜单 / 弹层
  $('btnMenu').onclick = function () {
    showSheet('Node Chat', function (content) {
      var actions = el('div', 'sheet-actions');
      var b1 = el('button', '', '我的资料 / 更换头像');
      b1.onclick = function () { closeSheet(); setTimeout(openProfile, 100); };
      actions.appendChild(b1);

      var b2 = el('button', '', '新建群聊');
      b2.onclick = function () { closeSheet(); setTimeout(newRoom, 100); };
      actions.appendChild(b2);

      var b3 = el('button', '', '断开并返回登录');
      b3.onclick = function () { closeSheet(); setTimeout(logout, 120); };
      actions.appendChild(b3);
      content.appendChild(actions);
    });
  };

  $('btnChatMenu').onclick = function () {
    var c = state.current ? state.convs[state.current] : null;
    if (!c) return;
    showSheet(c.isRoom ? '#' + c.name : c.name, function (content) {
      var actions = el('div', 'sheet-actions');

      var b1 = el('button', '', '查看成员 / 在线情况');
      b1.onclick = function () {
        closeSheet();
        setTab('online');
        closeChat();
      };
      actions.appendChild(b1);

      if (c.isRoom) {
        var b2 = el('button', '', '刷新群成员');
        b2.onclick = function () {
          client.send(C2S.MEMBERS, { room: c.name });
          client.send(C2S.HISTORY, { room: c.name, limit: 80 });
          toast('已刷新');
          closeSheet();
        };
        actions.appendChild(b2);
      } else {
        var b3 = el('button', '', '清空本地显示');
        b3.onclick = function () {
          c.messages = [];
          renderMessages();
          renderLists();
          closeSheet();
        };
        actions.appendChild(b3);
      }
      content.appendChild(actions);
    });
  };

  function showSheet(title, build) {
    $('sheetTitle').textContent = title;
    var content = $('sheetContent');
    content.innerHTML = '';
    build(content);
    $('sheet').classList.remove('hidden');
  }

  function closeSheet() {
    $('sheet').classList.add('hidden');
  }

  /** WebView 里 window.prompt 不可用，用底部面板代替 */
  function promptSheet(title, placeholder, initial, onOk) {
    showSheet(title, function (content) {
      var input = document.createElement('input');
      input.className = 'sheet-input';
      input.placeholder = placeholder || '';
      input.value = initial || '';
      content.appendChild(input);

      var ok = el('button', 'primary big', '确 定');
      ok.style.marginTop = '12px';
      ok.onclick = function () {
        var v = input.value.trim();
        if (!v) { toast('内容不能为空'); return; }
        closeSheet();
        onOk(v);
      };
      content.appendChild(ok);
      setTimeout(function () { try { input.focus(); } catch (e) { } }, 220);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (n) {
    n.onclick = closeSheet;
  });

  function openViewer(src) {
    $('viewerImg').src = src;
    $('viewer').classList.remove('hidden');
  }
  $('viewer').onclick = function () { $('viewer').classList.add('hidden'); };

  var toastTimer = null;
  function toast(text, ms) {
    if (!text) return;
    var t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2400);
  }

  // ------------------------------------------------------------ 导航
  $('btnBack').onclick = closeChat;

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.onclick = function () { setTab(t.getAttribute('data-tab')); };
  });

  function setTab(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === tab);
    });
    $('paneGroup').classList.toggle('hidden', tab !== 'group');
    $('paneDm').classList.toggle('hidden', tab !== 'dm');
    $('paneOnline').classList.toggle('hidden', tab !== 'online');
    $('btnNewRoom').classList.toggle('hidden', tab !== 'group');
  }

  function newRoom() {
    promptSheet('新建群聊', '群名称，例如 design', '', function (name) {
      client.request(C2S.JOIN, { room: name }).then(function () {
        toast('已加入群「' + name + '」');
        openChat('room:' + name);
        client.send(C2S.ROOMS, {});
      }).catch(function (e) { toast(e.message); });
    });
  }

  $('btnNewRoom').onclick = newRoom;

  function logout() {
    state.loggingOut = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectTry = 0;
    if (BRIDGE && BRIDGE.disconnect) { try { BRIDGE.disconnect(); } catch (e) { } }
    state.connected = false;
    state.me = '';
    state.current = null;
    state.convs = {};
    state.online = {};
    state.joined = {};
    state.avatars = {};
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('chat').classList.remove('open');
    $('password').value = '';
    $('btnConnect').disabled = false;
    $('btnConnect').textContent = '连　接';
    setLoginMsg('', true);
    renderServers();
  }

  // ------------------------------------------------------------ 初始化
  setTab('group');
  renderServers();
  restoreLast();
  if (BRIDGE && BRIDGE.serverInfo) {
    try { window.__onServerInfo(JSON.parse(BRIDGE.serverInfo())); } catch (e) { }
  }

  setInterval(function () {
    if (state.connected) client.send(C2S.PING, {});
  }, 25000);
})();
