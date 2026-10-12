/* global Peer */
(() => {
  'use strict';

  const ID_PREFIX = 'nebula-share-v1-';
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
  const JOIN_TIMEOUT_MS = 20000;

  // Where the hosted web app lives; invite links point here so phones can join.
  const PUBLIC_WEB_URL = 'https://mvpfishstick.github.io/ScreenShare/';

  const $ = (id) => document.getElementById(id);
  const api = window.nebula || createWebApi();
  const peerOptions = api.signal ? { ...api.signal } : {};

  // Browser stand-in for the Electron preload bridge.
  function createWebApi() {
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return {
      isWeb: true,
      ios,
      platform: 'web',
      canShare: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !ios,
      copy: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
      },
      minimize() {},
      maximize() {},
      close() {},
      signal: webSignalConfig(),
    };
  }

  // A local signaling server can be picked with ?signal=http://127.0.0.1:9000/path
  // (development only; other hosts are ignored so links can't redirect signaling).
  function webSignalConfig() {
    const raw = new URLSearchParams(location.search).get('signal');
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (!['localhost', '127.0.0.1'].includes(url.hostname)) return null;
      const secure = url.protocol === 'https:';
      return { host: url.hostname, port: Number(url.port) || (secure ? 443 : 80), path: url.pathname || '/', secure };
    } catch (_) {
      return null;
    }
  }

  document.documentElement.classList.add(api.isWeb ? 'is-web' : 'is-desktop');
  if (api.ios) document.documentElement.classList.add('is-ios');
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    document.documentElement.classList.add('is-standalone');
  }

  // ---------- State ----------
  let idlePeer = null; // anonymous peer used for watching + connectivity status
  let hostPeer = null; // peer with our share code as its id
  let localStream = null;
  let shareCode = null;
  let viewers = new Map(); // peerId -> { conn, call, label }
  let viewerSeq = 0;

  let pendingJoinCode = null; // from an invite link, joined once we're online
  let watchConn = null;
  let watchCall = null;
  let joinTimer = null;

  let pickerTab = 'screen';
  let pickerSources = [];
  let selectedSourceId = null;
  let selectedSourceName = '';

  // ---------- Helpers ----------
  function showView(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
    document.body.classList.toggle('watching', id === 'viewWatch');
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function setNetStatus(state, text) {
    const el = $('netStatus');
    el.classList.remove('online', 'offline');
    if (state) el.classList.add(state);
    el.querySelector('span').textContent = text;
  }

  function randomCode() {
    const buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
  }

  const formatCode = (raw) => (raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw);
  const normalizeCode = (input) => input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  // ---------- Window controls ----------
  $('btnMin').onclick = () => api.minimize();
  $('btnMax').onclick = () => api.maximize();
  $('btnClose').onclick = () => api.close();

  // ---------- Idle peer (connectivity + viewing) ----------
  let reconnectDelay = 1000;
  function scheduleReconnect() {
    setTimeout(() => {
      if (!idlePeer) return;
      if (idlePeer.destroyed) initIdlePeer();
      else if (idlePeer.disconnected) idlePeer.reconnect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function initIdlePeer() {
    setNetStatus(null, 'Connecting…');
    idlePeer = new Peer(peerOptions);
    idlePeer.on('open', () => {
      reconnectDelay = 1000;
      setNetStatus('online', 'Online');
      if (pendingJoinCode) {
        const code = pendingJoinCode;
        pendingJoinCode = null;
        startWatch(code);
      }
    });
    idlePeer.on('disconnected', () => {
      setNetStatus('offline', 'Reconnecting…');
      scheduleReconnect();
    });
    idlePeer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        if (watchConn) {
          endWatch();
          toast('No one is sharing with that code.', true);
        }
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        setNetStatus('offline', 'Offline');
        if (idlePeer.destroyed) scheduleReconnect();
      }
      console.warn('Peer error', err.type, err);
    });
    idlePeer.on('call', (call) => {
      // Only accept a stream from the host we're currently watching.
      if (!watchConn || call.peer !== watchConn.peer) {
        call.close();
        return;
      }
      watchCall = call;
      call.answer();
      call.on('stream', (stream) => {
        clearTimeout(joinTimer);
        playRemote(stream);
        $('watchWaiting').classList.add('hidden');
      });
      call.on('close', () => {
        if (watchConn) {
          endWatch();
          toast('The stream has ended.');
        }
      });
    });
  }

  // ---------- Source picker ----------
  function positionTabIndicator() {
    const active = document.querySelector('.tab.active');
    const ind = document.querySelector('.tab-indicator');
    ind.style.left = `${active.offsetLeft}px`;
    ind.style.width = `${active.offsetWidth}px`;
  }

  function renderSources() {
    const grid = $('sourceGrid');
    grid.innerHTML = '';
    const list = pickerSources.filter((s) => s.type === pickerTab);
    if (!list.length) {
      grid.innerHTML = `<div class="grid-empty">No ${pickerTab === 'screen' ? 'screens' : 'windows'} found</div>`;
      return;
    }
    list.forEach((s, i) => {
      const el = document.createElement('button');
      el.className = 'source' + (s.id === selectedSourceId ? ' selected' : '');
      el.style.animationDelay = `${i * 30}ms`;

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'thumb-wrap';
      if (s.thumbnail) {
        const img = document.createElement('img');
        img.src = s.thumbnail;
        thumbWrap.appendChild(img);
      } else {
        thumbWrap.innerHTML = '<span class="no-thumb">No preview</span>';
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      if (s.icon) {
        const icon = document.createElement('img');
        icon.src = s.icon;
        meta.appendChild(icon);
      }
      const name = document.createElement('span');
      name.textContent = s.type === 'screen' ? prettyScreenName(s, list) : s.name;
      name.title = s.name;
      meta.appendChild(name);

      const check = document.createElement('div');
      check.className = 'check';
      check.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>';

      el.append(thumbWrap, meta, check);
      el.onclick = () => {
        selectedSourceId = s.id;
        selectedSourceName = name.textContent;
        grid.querySelectorAll('.source').forEach((n) => n.classList.remove('selected'));
        el.classList.add('selected');
        $('btnPickerShare').disabled = false;
      };
      el.ondblclick = () => confirmPicker();
      grid.appendChild(el);
    });
  }

  function prettyScreenName(s, screens) {
    if (screens.length === 1) return 'Entire screen';
    const idx = screens.indexOf(s) + 1;
    return /screen/i.test(s.name) ? `Display ${idx}` : s.name;
  }

  async function loadSources() {
    const btn = $('btnRefresh');
    btn.classList.add('spinning');
    try {
      pickerSources = await api.listSources();
      if (selectedSourceId && !pickerSources.some((s) => s.id === selectedSourceId)) {
        selectedSourceId = null;
        $('btnPickerShare').disabled = true;
      }
      renderSources();
    } catch (e) {
      toast('Could not list screens: ' + e.message, true);
    } finally {
      btn.classList.remove('spinning');
    }
  }

  function openPicker() {
    selectedSourceId = null;
    $('btnPickerShare').disabled = true;
    $('sourceGrid').innerHTML =
      '<div class="source skeleton"><div class="thumb-wrap"></div><div class="meta"><span></span></div></div>'.repeat(3);
    $('picker').classList.add('open');
    requestAnimationFrame(positionTabIndicator);
    loadSources();
  }

  function closePicker() {
    $('picker').classList.remove('open');
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      pickerTab = tab.dataset.tab;
      positionTabIndicator();
      renderSources();
    };
  });
  $('btnRefresh').onclick = loadSources;
  $('btnPickerClose').onclick = closePicker;
  $('btnPickerCancel').onclick = closePicker;
  $('btnPickerShare').onclick = () => confirmPicker();
  $('picker').addEventListener('mousedown', (e) => {
    if (e.target.id === 'picker') closePicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('picker').classList.contains('open')) closePicker();
  });
  if (api.platform !== 'win32') {
    // System audio loopback is a Windows-only capability.
    $('chkAudio').closest('.toggle').style.display = 'none';
  }

  async function confirmPicker() {
    if (!selectedSourceId) return;
    const wantAudio = $('chkAudio').checked && api.platform === 'win32';
    closePicker();
    try {
      await api.selectSource(selectedSourceId, selectedSourceName, wantAudio);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: wantAudio,
      });
      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack) videoTrack.contentHint = pickerTab === 'window' ? 'detail' : 'motion';
      await useStream(stream, selectedSourceName);
    } catch (e) {
      console.error(e);
      toast('Could not capture that source.', true);
    }
  }

  // ---------- Hosting ----------
  async function useStream(stream, label) {
    const previous = localStream;
    localStream = stream;
    $('localVideo').srcObject = stream;
    $('sourceLabel').textContent = label;

    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => {
      if (localStream === stream) stopSharing('Capture ended.');
    }));

    if (hostPeer) {
      // Switching source while live: swap tracks on every existing call.
      for (const v of viewers.values()) replaceTracks(v.call, stream);
    } else {
      startHosting();
    }
    if (previous && previous !== stream) previous.getTracks().forEach((t) => t.stop());
    showView('viewHost');
  }

  function replaceTracks(call, stream) {
    const pc = call && call.peerConnection;
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const next = stream.getTracks().find((t) => t.kind === sender.track.kind);
      if (next) sender.replaceTrack(next).catch(() => {});
    }
  }

  function tuneSenders(call) {
    const pc = call.peerConnection;
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) continue;
      params.encodings[0].maxBitrate = 8_000_000;
      params.degradationPreference = 'maintain-resolution';
      sender.setParameters(params).catch(() => {});
    }
  }

  function startHosting() {
    shareCode = randomCode();
    $('shareCode').textContent = '···-···';
    $('viewerCount').textContent = '0';
    $('viewerList').innerHTML = '';
    viewers = new Map();
    viewerSeq = 0;

    const peer = new Peer(ID_PREFIX + shareCode, peerOptions);
    hostPeer = peer;

    peer.on('open', () => {
      $('shareCode').textContent = formatCode(shareCode);
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        if (!localStream) {
          conn.close();
          return;
        }
        const label = `Viewer ${++viewerSeq}`;
        const call = peer.call(conn.peer, localStream);
        viewers.set(conn.peer, { conn, call, label });
        call.on('iceStateChanged', (state) => {
          if (state === 'connected') tuneSenders(call);
        });
        updateViewers();
        toast(`${label} joined`);
      });
      const drop = () => {
        const v = viewers.get(conn.peer);
        if (!v) return;
        viewers.delete(conn.peer);
        v.call && v.call.close();
        updateViewers();
        toast(`${v.label} left`);
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });

    let hostRetryDelay = 1000;
    peer.on('open', () => (hostRetryDelay = 1000));
    peer.on('disconnected', () => {
      if (hostPeer !== peer || peer.destroyed) return;
      setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), hostRetryDelay);
      hostRetryDelay = Math.min(hostRetryDelay * 2, 30000);
    });

    peer.on('error', (err) => {
      if (hostPeer !== peer) return;
      if (err.type === 'unavailable-id') {
        // Code collision – pick another one.
        peer.destroy();
        hostPeer = null;
        startHosting();
        return;
      }
      console.warn('Host peer error', err.type, err);
      if (['network', 'server-error', 'socket-error'].includes(err.type)) {
        toast('Connection problem – retrying…', true);
      }
    });
  }

  function updateViewers() {
    $('viewerCount').textContent = String(viewers.size);
    const list = $('viewerList');
    list.innerHTML = '';
    for (const v of viewers.values()) {
      const li = document.createElement('li');
      li.textContent = v.label;
      list.appendChild(li);
    }
  }

  function stopSharing(message) {
    for (const v of viewers.values()) {
      try { v.conn.send({ type: 'bye' }); } catch (_) { /* ignore */ }
      v.call && v.call.close();
      v.conn.close();
    }
    viewers.clear();
    if (hostPeer) {
      const p = hostPeer;
      hostPeer = null;
      setTimeout(() => p.destroy(), 300); // let the "bye" messages flush
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    $('localVideo').srcObject = null;
    shareCode = null;
    showView('viewHome');
    if (message) toast(message);
  }

  // In a browser the system's own picker replaces ours.
  async function shareFromBrowser() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: true,
      });
      const [videoTrack] = stream.getVideoTracks();
      const surface = videoTrack && videoTrack.getSettings().displaySurface;
      if (videoTrack) videoTrack.contentHint = surface === 'monitor' ? 'motion' : 'detail';
      const label = surface === 'monitor' ? 'Entire screen' : (videoTrack && videoTrack.label) || 'Shared screen';
      await useStream(stream, label);
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') toast('Could not start screen capture.', true);
    }
  }

  const beginShare = () => (api.isWeb ? shareFromBrowser() : openPicker());
  $('btnStart').onclick = () => {
    if (!api.isWeb || api.canShare) beginShare();
  };
  $('btnSwitch').onclick = beginShare;

  if (api.isWeb && !api.canShare) {
    $('btnStart').disabled = true;
    $('shareBlurb').textContent = api.ios
      ? 'iPhone and iPad can watch screens but can\'t share them. Start sharing from a PC.'
      : 'This browser can\'t share its screen. Use the desktop app or a desktop browser.';
  }

  const inviteLink = (code) => `${api.isWeb ? location.origin + location.pathname : PUBLIC_WEB_URL}#join=${code}`;
  $('btnCopyLink').onclick = async () => {
    if (!shareCode || !hostPeer || !hostPeer.open) return;
    await api.copy(inviteLink(shareCode));
    const label = $('btnCopyLink').querySelector('span');
    label.textContent = 'Link copied!';
    setTimeout(() => (label.textContent = 'Copy invite link'), 1600);
  };
  $('btnStop').onclick = () => stopSharing('Sharing stopped.');
  $('btnCopy').onclick = async () => {
    if (!shareCode || !hostPeer || !hostPeer.open) return;
    await api.copy(formatCode(shareCode));
    const label = $('btnCopy').querySelector('span');
    label.textContent = 'Copied!';
    setTimeout(() => (label.textContent = 'Copy code'), 1600);
  };

  // ---------- Watching ----------
  const joinInput = $('joinCode');
  joinInput.addEventListener('input', () => {
    joinInput.value = formatCode(normalizeCode(joinInput.value));
  });

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode(joinInput.value);
    if (code.length !== 6) {
      toast('Share codes are 6 characters, like ABC-123.', true);
      joinInput.focus();
      return;
    }
    startWatch(code);
  });

  function startWatch(code) {
    if (!idlePeer || idlePeer.destroyed || idlePeer.disconnected || !idlePeer.open) {
      toast('Still connecting to the network – try again in a moment.', true);
      return;
    }
    $('watchCode').textContent = formatCode(code);
    $('watchStatus').textContent = 'Connecting to host…';
    $('watchWaiting').classList.remove('hidden');
    $('remoteVideo').srcObject = null;
    showView('viewWatch');

    const conn = idlePeer.connect(ID_PREFIX + code, { reliable: true });
    watchConn = conn;
    conn.on('open', () => {
      $('watchStatus').textContent = 'Waiting for video…';
    });
    conn.on('data', (msg) => {
      if (msg && msg.type === 'bye' && watchConn === conn) {
        endWatch();
        toast('The host stopped sharing.');
      }
    });
    conn.on('close', () => {
      if (watchConn === conn) {
        endWatch();
        toast('Disconnected from host.');
      }
    });

    clearTimeout(joinTimer);
    joinTimer = setTimeout(() => {
      if (watchConn === conn && !$('remoteVideo').srcObject) {
        endWatch();
        toast('Could not reach that host.', true);
      }
    }, JOIN_TIMEOUT_MS);
  }

  // Browsers (iOS Safari especially) block autoplay with sound until the user
  // taps, so fall back to muted playback and offer a one-tap unmute.
  function playRemote(stream) {
    const v = $('remoteVideo');
    v.srcObject = stream;
    v.muted = false;
    $('btnUnmute').hidden = true;
    $('btnMute').classList.remove('muted');
    v.play().catch(() => {
      v.muted = true;
      $('btnMute').classList.add('muted');
      v.play().catch(() => {});
      if (stream.getAudioTracks().length) $('btnUnmute').hidden = false;
    });
  }

  $('btnUnmute').onclick = () => {
    const v = $('remoteVideo');
    v.muted = false;
    v.play().catch(() => {});
    $('btnMute').classList.remove('muted');
    $('btnUnmute').hidden = true;
  };

  function endWatch() {
    clearTimeout(joinTimer);
    const conn = watchConn;
    const call = watchCall;
    watchConn = null;
    watchCall = null;
    if (call) call.close();
    if (conn) conn.close();
    $('remoteVideo').srcObject = null;
    $('btnUnmute').hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    showView('viewHome');
  }

  $('btnLeave').onclick = () => endWatch();

  $('btnMute').onclick = () => {
    const v = $('remoteVideo');
    v.muted = !v.muted;
    if (!v.muted) v.play().catch(() => {});
    $('btnMute').classList.toggle('muted', v.muted);
    $('btnUnmute').hidden = true;
  };

  $('btnFull').onclick = () => {
    const wrap = $('watchWrap');
    const video = $('remoteVideo');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  };
  $('remoteVideo').ondblclick = () => $('btnFull').click();

  // Hide the viewer toolbar when the mouse is idle; on touch screens a tap
  // on the video toggles it.
  let idleTimer = null;
  function wakeToolbar() {
    const wrap = $('watchWrap');
    wrap.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!$('watchWaiting').classList.contains('hidden')) return;
      wrap.classList.add('idle');
    }, 3000);
  }
  $('watchWrap').addEventListener('mousemove', wakeToolbar);
  $('remoteVideo').addEventListener('touchend', (e) => {
    const wrap = $('watchWrap');
    if (wrap.classList.contains('idle')) {
      e.preventDefault();
      wakeToolbar();
    } else {
      wrap.classList.add('idle');
    }
  });

  window.addEventListener('resize', () => {
    if ($('picker').classList.contains('open')) positionTabIndicator();
  });

  window.addEventListener('beforeunload', () => {
    if (hostPeer) stopSharing();
    if (idlePeer) idlePeer.destroy();
  });

  // Invite links look like …/#join=ABC123.
  function readInviteHash() {
    const m = location.hash.match(/join=([A-Za-z0-9-]+)/);
    if (!m) return;
    const code = normalizeCode(m[1]);
    if (code.length !== 6) return;
    joinInput.value = formatCode(code);
    if (idlePeer && idlePeer.open && !watchConn) startWatch(code);
    else pendingJoinCode = code;
  }
  window.addEventListener('hashchange', readInviteHash);

  if (api.isWeb && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  initIdlePeer();
  readInviteHash();
})();
