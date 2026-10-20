// Alabaster Dawn iOS shim: NW.js/Node surface + touch pad + audio unlock.
// Injected at document start; window.__ADA_BOOT = {manifest:[relpaths], saves:{key:{data,mtime}}}.
(function () {
  'use strict';
  var boot = window.__ADA_BOOT || { manifest: [], saves: {} };
  var post = function (m) {
    try { window.webkit.messageHandlers.ada.postMessage(m); } catch (e) {}
  };
  var log = function (s) { post({ op: 'log', msg: String(s) }); };
  window.addEventListener('error', function (e) { log('JS error: ' + e.message + ' @' + e.filename + ':' + e.lineno); });
  window.addEventListener('unhandledrejection', function (e) { log('Unhandled rejection: ' + (e.reason && (e.reason.stack || e.reason))); });

  // ---------- on-screen debug log (remove once stable) ----------
  var dbgLines = [], dbgEl = null;
  function dbg(s) {
    s = String(s).slice(0, 160); log(s);
    dbgLines.push(s); if (dbgLines.length > 14) dbgLines.shift();
    if (!window.__ADA_DEBUG) return;
    if (!dbgEl && document.body) {
      dbgEl = document.createElement('pre');
      dbgEl.style.cssText = 'position:fixed;left:4px;top:4px;right:4px;z-index:100000;margin:0;pointer-events:none;' +
        'color:#0f0;background:rgba(0,0,0,.6);font:10px/1.2 monospace;white-space:pre-wrap;max-height:60%;overflow:hidden';
      document.body.appendChild(dbgEl);
    }
    if (dbgEl) dbgEl.textContent = dbgLines.join('\n');
  }
  window.addEventListener('error', function (e) { dbg('ERR ' + e.message + ' @' + String(e.filename).split('/').pop() + ':' + e.lineno); });
  window.addEventListener('unhandledrejection', function (e) { dbg('REJ ' + (e.reason && (e.reason.message || e.reason))); });
  ['error', 'warn'].forEach(function (k) {
    var o = console[k]; console[k] = function () { dbg(k + ': ' + [].slice.call(arguments).join(' ')); o.apply(console, arguments); };
  });
  var oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.addEventListener('loadend', function () { if (this.status !== 200) dbg('XHR ' + this.status + ' ' + u); });
    return oOpen.apply(this, arguments);
  };
  var oFetch = window.fetch;
  window.fetch = function (u) {
    return oFetch.apply(this, arguments).then(function (r) { if (!r.ok) dbg('FETCH ' + r.status + ' ' + u); return r; },
      function (e) { dbg('FETCH FAIL ' + u + ' ' + e); throw e; });
  };
  document.addEventListener('DOMContentLoaded', function () {
    dbg('boot ok, files=' + boot.manifest.length + ' saves=' + Object.keys(boot.saves || {}).length);
    var gl = document.createElement('canvas').getContext('webgl2');
    dbg('webgl2=' + !!gl + ' win=' + innerWidth + 'x' + innerHeight + ' dpr=' + devicePixelRatio);
    setTimeout(function () {
      var c = document.querySelector('canvas');
      dbg('canvas=' + (c ? c.width + 'x' + c.height + ' css ' + c.style.width + 'x' + c.style.height : 'none') +
        ' boot=' + (window.g && window.g.resource && window.g.resource.bootTracker ? 'tracker' : 'n/a'));
    }, 8000);
  });

  // WebKit has no navigator.keyboard; the engine calls getLayoutMap() unguarded.
  if (!navigator.keyboard) {
    try {
      Object.defineProperty(navigator, 'keyboard', { configurable: true, value: {
        getLayoutMap: function () { return Promise.resolve(new Map()); },
        lock: function () { return Promise.resolve(); }, unlock: function () {}
      } });
    } catch (e) {}
  }

  // ---------- viewport / page CSS ----------
  var head = document.documentElement;
  var meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  // CrossCode's page ships "initial-scale=0.5", which doubles the CSS window size and breaks its
  // Fit/Stretch maths; rewrite any page viewport tag the moment the parser inserts it.
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      [].forEach.call(m.addedNodes, function (n) {
        if (n.tagName === 'META' && n.name === 'viewport' && n !== meta) n.content = meta.content;
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', function () {
    [].forEach.call(document.querySelectorAll('meta[name=viewport]'), function (m) { m.remove(); });
    document.head.appendChild(meta);
    var st = document.createElement('style');
    st.textContent = 'html,body{margin:0;padding:0;background:#000;overflow:hidden;touch-action:none;' +
      '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}';
    document.head.appendChild(st);
  });

  // ---------- fs (read-only game tree via manifest, saves via native) ----------
  var files = Object.create(null);
  var PFX = boot.fsPrefix || '';
  boot.manifest = boot.manifest.map(function (p) { return PFX + p; });
  boot.manifest.forEach(function (p) { files[p] = true; });
  var dirs = Object.create(null);
  boot.manifest.forEach(function (p) {
    var parts = p.split('/'); parts.pop();
    var acc = '';
    parts.forEach(function (s) { acc = acc ? acc + '/' + s : s; dirs[acc] = true; });
  });
  var saves = Object.create(null);
  Object.keys(boot.saves || {}).forEach(function (k) { saves[k] = boot.saves[k]; });
  var saveDirs = Object.create(null);

  function norm(p) {
    p = String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
    var out = [];
    p.split('/').forEach(function (s) {
      if (s === '' || s === '.') return;
      if (s === '..') out.pop(); else out.push(s);
    });
    return out.join('/');
  }
  function isSave(n) { return n.indexOf('data/Saves') === 0 || n.indexOf('Saves') === 0; }
  function enoent(p) { var e = new Error("ENOENT: no such file or directory, '" + p + "'"); e.code = 'ENOENT'; return e; }
  function mkStat(size, mtime, dir) {
    return {
      size: size, mtimeMs: mtime, mtime: new Date(mtime), ctime: new Date(mtime), birthtime: new Date(mtime),
      atime: new Date(mtime), mode: 0, isFile: function () { return !dir; }, isDirectory: function () { return !!dir; },
      isSymbolicLink: function () { return false; }
    };
  }
  function statSync(p) {
    var n = norm(p);
    if (saves[n]) return mkStat(saves[n].data.length, saves[n].mtime, false);
    if (files[n]) return mkStat(0, 0, false);
    if (dirs[n] || saveDirs[n]) return mkStat(0, 0, true);
    throw enoent(p);
  }
  function putSave(n, data) {
    saves[n] = { data: String(data), mtime: Date.now() };
    post({ op: 'put', key: n, data: String(data) });
  }
  function delSave(n) { delete saves[n]; post({ op: 'del', key: n }); }
  function readFileData(p) {
    var n = norm(p);
    if (saves[n]) return Promise.resolve(saves[n].data);
    if (files[n]) return fetch(n.slice(PFX.length).split('/').map(encodeURIComponent).join('/'))
      .then(function (r) { return r.text(); });
    return Promise.reject(enoent(p));
  }
  function wrap(fn) {
    return function () {
      try { return Promise.resolve(fn.apply(null, arguments)); } catch (e) { return Promise.reject(e); }
    };
  }
  function rm(p) {
    var n = norm(p);
    if (!saves[n]) throw enoent(p);
    delSave(n);
  }
  function rename(a, b) {
    var na = norm(a), nb = norm(b);
    if (!saves[na]) throw enoent(a);
    putSave(nb, saves[na].data);
    delSave(na);
  }
  var fs = {
    existsSync: function (p) { var n = norm(p); return !!(saves[n] || files[n] || dirs[n] || saveDirs[n]); },
    statSync: statSync,
    lstatSync: statSync,
    mkdirSync: function (p) { var n = norm(p); saveDirs[n] = true; },
    readdir: function (p, o, cb) {
      if (typeof o === 'function') cb = o;
      var n = norm(p), seen = Object.create(null), res = [];
      [files, saves].forEach(function (src) {
        Object.keys(src).forEach(function (k) {
          if (n === '' || k.indexOf(n + '/') === 0) {
            var rest = k.slice(n ? n.length + 1 : 0), first = rest.split('/')[0];
            if (first && !seen[first]) {
              seen[first] = 1;
              res.push(o && o.withFileTypes ? { name: first, isDirectory: function () { return rest.indexOf('/') >= 0; }, isFile: function () { return rest.indexOf('/') < 0; } } : first);
            }
          }
        });
      });
      setTimeout(function () { cb(null, res); }, 0);
    },
    unlinkSync: rm,
    readFile: function (p, o, cb) {
      if (typeof o === 'function') cb = o;
      readFileData(p).then(function (d) { cb(null, d); }, function (e) { cb(e); });
    },
    rename: function (a, b, cb) {
      try { rename(a, b); cb && cb(null); } catch (e) { cb && cb(e); }
    },
    exists: function (p, cb) { var n = norm(p); cb(!!(saves[n] || files[n] || dirs[n] || saveDirs[n])); },
    writeFile: function (p, d, o, cb) {
      if (typeof o === 'function') cb = o;
      try { putSave(norm(p), d); cb && cb(null); } catch (e) { cb && cb(e); }
    },
    watch: function () { return { close: function () {} }; },
    promises: {
      readFile: readFileData,
      stat: wrap(statSync),
      rm: wrap(rm),
      rename: wrap(rename),
      writeFile: wrap(function (p, d) { putSave(norm(p), d); }),
      unlink: wrap(rm),
      mkdir: wrap(function (p) { saveDirs[norm(p)] = true; })
    }
  };

  var path = {
    sep: '/', delimiter: ':',
    join: function () { return norm([].slice.call(arguments).join('/')); },
    resolve: function () { return norm([].slice.call(arguments).join('/')); },
    normalize: norm,
    dirname: function (p) { var n = norm(p).split('/'); n.pop(); return n.join('/'); },
    basename: function (p, ext) { var b = norm(p).split('/').pop(); return ext && b.slice(-ext.length) === ext ? b.slice(0, -ext.length) : b; },
    extname: function (p) { var b = path.basename(p), i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }
  };

  // Alabaster Dawn: process must stay undefined so the engine takes its browser platform path.
  // CrossCode: needs a desktop-style process object.
  var noop = function () {};
  if (boot.desktopProcess) {
    window.process = { platform: 'linux', arch: 'x64', argv: ['crosscode'], pid: 1, title: 'node', browser: false,
      versions: { 'node-webkit': '0.86.0', nw: '0.86.0', node: '21.1.0', chrome: '123.0.6312.87' },
      env: { HOME: '/saves', TMPDIR: '/tmp' }, cwd: function () { return ''; },
      nextTick: function (f) { setTimeout(f, 0); }, exit: noop, on: noop, once: noop, off: noop, removeListener: noop, removeAllListeners: noop };
  } else {
    delete window.process;
  }
  var greenStub = { init: function () { return false; }, isSteamRunning: function () { return false; }, activateGameOverlayToStore: function () {} };
  window.require = function (name) {
    switch (name) {
      case 'fs': return fs;
      case 'path': return path;
      case 'vm': return { createContext: function () { return {}; }, runInContext: function () {}, runInNewContext: function () {}, isContext: function () { return true; } };
      case 'nw.gui': return window.nw;
      default:
        if (/greenworks/.test(name)) return greenStub;
        return {};
    }
  };

  var winStub = { on: noop, once: noop, off: noop, show: noop, hide: noop, enterFullscreen: noop, leaveFullscreen: noop,
    close: function () { post({ op: 'quit' }); }, resizeTo: noop, moveTo: noop, setPosition: noop, focus: noop, zoomLevel: 0, window: window };
  window.nw = {
    App: { argv: [], dataPath: boot.dataPath || '/data', quit: function () { post({ op: 'quit' }); }, clearCache: noop },
    Window: { get: function () { return winStub; }, open: noop, getAll: function () { return []; } },
    Screen: { screens: [{ bounds: { x: 0, y: 0, width: screen.width, height: screen.height } }] },
    Clipboard: { get: function () { return { set: noop, get: function () { return ''; } }; } },
    Shell: { openExternal: noop, openItem: noop, showItemInFolder: noop }
  };

  // ---------- audio unlock + suspend/resume ----------
  var ctxs = [];
  ['AudioContext', 'webkitAudioContext'].forEach(function (nm) {
    var Orig = window[nm];
    if (!Orig || Orig.__ada) return;
    var P = function () {
      // The games ship 44.1 kHz audio: run the context at 44.1 kHz so decoded sounds are not
      // resampled to 48 kHz (less memory and CPU). Falls back to the default rate if refused.
      var args = [].slice.call(arguments), c;
      if (!args.length) {
        // After an out-of-memory kill, the app sets lowMemory: 22.05 kHz halves decoded-audio memory.
        try { c = new Orig({ sampleRate: boot.lowMemory ? 22050 : 44100 }); } catch (e) { c = null; }
      }
      if (!c) c = new (Function.prototype.bind.apply(Orig, [null].concat(args)))();
      log('AudioContext ' + c.sampleRate + ' Hz');
      ctxs.push(c); return c;
    };
    P.prototype = Orig.prototype; P.__ada = true;
    window[nm] = P;
  });
  // Ogg Vorbis fallback: WebKit on iOS may not decode Vorbis, and both games ship only .ogg audio.
  // Alabaster Dawn never finishes booting when a decode fails (black screen). Try WebKit's decoder
  // first; after the first Ogg failure, decode Ogg with the bundled WASM decoder in worker threads.
  (function () {
    var BAC = window.BaseAudioContext || window.AudioContext || window.webkitAudioContext;
    var OV = window['ogg-vorbis-decoder'];
    if (!BAC || !BAC.prototype.decodeAudioData || !OV) return;
    var nativeDecode = BAC.prototype.decodeAudioData;
    var nativeOggBroken = !!window.__ADA_FORCE_WASM_OGG, pool = [], next = 0, okCount = 0, failCount = 0, pcmBytes = 0;
    function decoder() {
      if (!pool.length) {
        for (var i = 0; i < 3; i++) {
          try { pool.push({ d: new OV.OggVorbisDecoderWebWorker(), q: Promise.resolve() }); }
          catch (e) { if (!pool.length) pool.push({ d: new OV.OggVorbisDecoder(), q: Promise.resolve() }); break; }
        }
      }
      return pool[next++ % pool.length];
    }
    function wasmDecode(ctx, bytes) {
      var slot = decoder();
      var job = slot.q.then(function () { return slot.d.ready; })
        .then(function () { return slot.d.decodeFile(bytes); })
        .then(function (r) { return slot.d.reset().then(function () { return r; }); });
      slot.q = job.catch(noop);
      return job.then(function (r) {
        if (!r || !r.samplesDecoded || !r.channelData.length) throw new Error('empty vorbis decode');
        var buf = ctx.createBuffer(r.channelData.length, r.samplesDecoded, r.sampleRate);
        for (var c = 0; c < r.channelData.length; c++) buf.getChannelData(c).set(r.channelData[c].subarray(0, r.samplesDecoded));
        return buf;
      });
    }
    function isOgg(b) { return b.length > 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53; }
    // At most 4 decodes at a time: the games start hundreds at once during boot, and the
    // transient memory got WebKit's page process killed on iPhone (Alabaster Dawn black screen).
    var MAX_DECODES = 4, active = 0, waiting = [], nativeOggOK = false;
    function runQueued(job) {
      return new Promise(function (resolve, reject) {
        waiting.push(function () {
          active++;
          job().then(resolve, reject).then(function () {
            active--;
            if (waiting.length) waiting.shift()();
          });
        });
        if (active < MAX_DECODES) waiting.shift()();
      });
    }
    function decodeOne(ctx, data) {
      var bytes = new Uint8Array(data);
      if (!isOgg(bytes)) return nativeDecode.call(ctx, data);
      if (nativeOggBroken) return wasmDecode(ctx, bytes);
      // Keep a copy for the WASM fallback only until WebKit has proven it can decode Ogg.
      var copy = nativeOggOK ? null : bytes.slice();
      return Promise.resolve().then(function () { return nativeDecode.call(ctx, data); }).then(function (b) {
        nativeOggOK = true; return b;
      }, function (e) {
        if (!copy) throw e;
        if (!nativeOggBroken) { nativeOggBroken = true; log('WebKit cannot decode Ogg (' + e + '), using WASM Vorbis decoder'); }
        return wasmDecode(ctx, copy);
      });
    }
    BAC.prototype.decodeAudioData = function (data, ok, err) {
      var ctx = this;
      var p = runQueued(function () { return decodeOne(ctx, data); });
      p = p.then(function (b) { okCount++; if (b) pcmBytes += b.length * b.numberOfChannels * 4; return b; }, function (e) {
        if (++failCount <= 5) log('audio decode failed: ' + e);
        throw e;
      });
      p.then(function (b) { ok && ok(b); }, function (e) { err && err(e); });
      return p;
    };
    window.__adaAudioStats = function () {
      return { ok: okCount, fail: failCount, wasm: nativeOggBroken, mb: Math.round(pcmBytes / 1048576), queued: waiting.length };
    };
  })();

  // CrossCode picks its sound format with new Audio().canPlayType(); WebKit answers inconsistently for
  // Ogg (seen: "" after a relaunch, which crashes the game). Ogg is decoded through Web Audio above
  // (native or WASM), so report it as playable.
  var oCanPlay = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (t) {
    return /ogg|vorbis/i.test(String(t)) ? 'probably' : oCanPlay.call(this, t);
  };

  var suspended = false;
  function resumeAll() { ctxs.forEach(function (c) { if (c.state !== 'running') c.resume().catch(noop); }); }
  ['touchstart', 'touchend', 'pointerdown', 'click', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, function () { if (!suspended) resumeAll(); }, true);
  });
  // Both engines pause while the window is unfocused (Alabaster Dawn shows a black screen), and a
  // WKWebView often never receives window focus. Report focus at all times except while the app is in
  // the background (the native side calls __adaSuspend/__adaResume).
  document.hasFocus = function () { return !suspended; };
  window.addEventListener('blur', function (e) { if (!suspended) e.stopImmediatePropagation(); }, true);
  function kickFocus() { if (!suspended) window.dispatchEvent(new Event('focus')); }
  window.addEventListener('load', function () { kickFocus(); setInterval(kickFocus, 2000); });
  window.__adaSuspend = function () { suspended = true; window.dispatchEvent(new Event('blur')); ctxs.forEach(function (c) { c.suspend().catch(noop); }); };
  window.__adaResume = function () { suspended = false; resumeAll(); kickFocus(); };

  // ---------- virtual gamepad + touch overlay ----------
  var vpad = {
    id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 4, connected: true,
    mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: []
  };
  for (var i = 0; i < 17; i++) vpad.buttons.push({ pressed: false, touched: false, value: 0 });
  function setBtn(i, down) { var b = vpad.buttons[i]; b.pressed = b.touched = down; b.value = down ? 1 : 0; }

  var realGetGamepads = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : function () { return []; };
  var overlayVisible = true, hasReal = false;
  // Native GameController fallback: Swift polls GCController and pushes state here, so a physical
  // pad works (and the touch overlay hides) even if WebKit has not exposed it via the Gamepad API.
  var nativeConnected = false, nativeState = null;
  window.__adaN = function (s) { nativeConnected = !!(s && s.c); nativeState = nativeConnected ? s : null; };
  function applyNative() {
    for (var i = 0; i < 17; i++) setBtn(i, (nativeState.b[i] || 0) > 0.3);
    for (var b = 6; b <= 7; b++) vpad.buttons[b].value = nativeState.b[b] || 0;
    for (var a = 0; a < 4; a++) vpad.axes[a] = nativeState.a[a] || 0;
  }

  // ---------- diagnostics heartbeat (goes to Documents/Logs/<game>.log) ----------
  var frames = 0, oRAF = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { return oRAF.call(window, function (t) { frames++; cb(t); }); };
  var lastErrCount = 0, hbStart = Date.now();
  (function hbLoop() { setTimeout(function () { hb(); hbLoop(); }, Date.now() - hbStart < 30000 ? 1000 : 3000); })();
  var hbLast = Date.now();
  function hb() {
    var dt = (Date.now() - hbLast) / 1000; hbLast = Date.now();
    var parts = ['t=' + Math.round((Date.now() - hbStart) / 1000) + 's', 'fps=' + Math.round(frames / dt)];
    frames = 0;
    try {
      parts.push('vis=' + document.visibilityState + (suspended ? '/suspended' : ''));
      var a = window.__adaAudioStats && __adaAudioStats();
      if (a) parts.push('audio ok=' + a.ok + ' queued=' + a.queued + ' fail=' + a.fail + ' wasm=' + a.wasm + ' pcm=' + a.mb + 'MB');
      parts.push('ctx=' + ctxs.map(function (c) { return c.state; }).join(','));
      var c = document.querySelector('canvas');
      if (c) parts.push('canvas=' + c.width + 'x' + c.height + ' css=' + c.clientWidth + 'x' + c.clientHeight);
      if (window.g && g.resource) {
        var bt = g.resource.bootTracker;
        if (bt) parts.push('boot state=' + bt.state + ' max=' + bt.maxResource);
        var errs = g.resource.errors || [];
        parts.push('resErrors=' + errs.length);
        for (; lastErrCount < errs.length && lastErrCount < 40; lastErrCount++) {
          var er = errs[lastErrCount];
          log('RESOURCE ERROR ' + (er && (er.message || er.error && er.error.message || (er.resource && er.resource.path) || String(er))).toString().slice(0, 200));
        }
      }
      if (window.ig && ig.system) parts.push('ig=' + ig.system.width + 'x' + ig.system.height + 'x' + ig.system.scale + (window.sc && sc.model ? ' title=' + (sc.model.isTitle && sc.model.isTitle()) : ''));
      parts.push('pads real=' + hasReal + ' native=' + nativeConnected);
    } catch (e) { parts.push('hb error ' + e); }
    log('HB ' + parts.join(' | '));
  }
  document.addEventListener('visibilitychange', function () { log('visibility ' + document.visibilityState); });
  window.addEventListener('load', function () { log('window load event'); });
  document.addEventListener('DOMContentLoaded', function () { log('DOMContentLoaded'); });
  ['log', 'info'].forEach(function (k) {
    var o = console[k], n = 0;
    console[k] = function () {
      if (n++ < 150) log(k + ': ' + [].map.call(arguments, function (x) { return typeof x === 'string' ? x.replace(/%c/g, '') : (x && x.message) || String(x); }).join(' ').slice(0, 200));
      return o.apply(console, arguments);
    };
  });

  // ---------- display settings (in-game options, mirrored to native so they survive restarts) ----------
  var settings = boot.settings || {};
  function saveSetting(k, v) {
    if (settings[k] === v) return;
    settings[k] = v; post({ op: 'setting', key: k, value: v });
  }
  var dpr = window.devicePixelRatio || 1;
  var nativeW = Math.round(Math.max(screen.width, screen.height) * dpr);
  var nativeH = Math.round(Math.min(screen.width, screen.height) * dpr);
  // Alabaster Dawn: "Native" entry of the patched Resolution list (render scale vs. the 640x360 base).
  // Multiple of 1/40 so 640*s x 360*s stays a whole-pixel framebuffer (e.g. 1179 lines -> 2096x1179).
  window.__adaNativeScale = Math.min(4, Math.floor(nativeH / 9) / 40);

  var aspectMode = 'fit';
  function applyAspect() {
    var st = document.getElementById('__ada_aspect');
    if (!st && document.head) { st = document.createElement('style'); st.id = '__ada_aspect'; document.head.appendChild(st); }
    if (!st) return;
    if (aspectMode !== 'fill') { st.textContent = ''; return; }
    st.textContent = 'canvas.xgCanvas,#game canvas{position:fixed!important;left:0!important;top:0!important;width:100vw!important;' +
      'height:100vh!important;object-fit:fill!important;margin:0!important;transform:none!important;max-width:none!important;max-height:none!important}';
  }
  document.addEventListener('DOMContentLoaded', function () { applyAspect(); setInterval(applyAspect, 1000); });
  window.addEventListener('resize', applyAspect);

  // Aspect ratio = how wide the game's view is (a real wider view, not a stretch). Height stays fixed.
  var ASPECTS = [16 / 9, nativeW / nativeH, 1.943];
  var ASPECT_NAMES = ['16:9', 'Full Screen', '1.943:1'];
  function toast(msg) {
    var t = document.getElementById('__ada_toast');
    if (!t) {
      t = document.createElement('div'); t.id = '__ada_toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100001;color:#fff;' +
        'font:600 15px -apple-system,sans-serif;background:rgba(0,0,0,.75);padding:8px 14px;border-radius:10px;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, 4000);
  }

  if (boot.gameId === 'alabaster') {
    var AD_KEYS = ['pixel-size', 'screen-scaling', 'screen-aspect'];
    // Seed the engine's local options from the native copy, and drop out-of-range values.
    try {
      var lo = JSON.parse(localStorage.getItem('xg_local_options') || '{}');
      AD_KEYS.forEach(function (k) { if (typeof settings[k] === 'number') lo[k] = settings[k]; });
      if (typeof lo['pixel-size'] === 'number' && (lo['pixel-size'] < 0 || lo['pixel-size'] > 4)) lo['pixel-size'] = 0;
      if (typeof lo['screen-aspect'] !== 'number' || lo['screen-aspect'] < 0 || lo['screen-aspect'] > 2) lo['screen-aspect'] = 1;
      localStorage.setItem('xg_local_options', JSON.stringify(lo));
      aspectMode = lo['screen-scaling'] === 1 ? 'fill' : 'fit';
      var adAspect = lo['screen-aspect'];
      // Patched SYSTEM_CONF.SCREEN_WIDTH reads this at startup (base 640x360); keep it even.
      window.__adaScreenWidth = Math.round(360 * ASPECTS[adAspect] / 2) * 2;
      log('alabaster view ' + window.__adaScreenWidth + 'x360 (' + ASPECT_NAMES[adAspect] + '), pixel-size ' + lo['pixel-size'] +
        ', scaling ' + aspectMode + ', native scale ' + window.__adaNativeScale);
    } catch (e) { log('alabaster settings seed failed: ' + e); }
    setInterval(function () {
      try {
        var o = JSON.parse(localStorage.getItem('xg_local_options') || '{}');
        AD_KEYS.forEach(function (k) { if (typeof o[k] === 'number' && settings[k] !== o[k]) { log('option ' + k + ' -> ' + o[k]); saveSetting(k, o[k]); } });
        var m = o['screen-scaling'] === 1 ? 'fill' : 'fit';
        if (m !== aspectMode) { aspectMode = m; applyAspect(); }
        if (typeof o['screen-aspect'] === 'number' && o['screen-aspect'] !== adAspect) {
          adAspect = o['screen-aspect'];
          toast('Aspect ratio ' + ASPECT_NAMES[adAspect] + ': restart the game to apply (⌂ menu, then start again)');
        }
      } catch (e) {}
    }, 500);
  }

  if (boot.gameId === 'crosscode') {
    // Patched options: "Aspect Ratio" sets the logical view width (height stays 320, the game's native
    // height), "Resolution" only sets the render sharpness (integer pixel scale, as CrossCode requires).
    var RES_H = [nativeH, 1084, 1080, 900, 720];
    var fixed = {};
    var curRes = typeof settings['ada-resolution'] === 'number' ? settings['ada-resolution'] : 0;
    var curAsp = typeof settings['ada-aspect'] === 'number' ? settings['ada-aspect'] : 1;
    var computeCC = function () {
      fixed.IG_HEIGHT = 320;
      fixed.IG_WIDTH = curAsp === 0 ? 568 : Math.round(320 * ASPECTS[curAsp]);
      fixed.IG_GAME_SCALE = Math.max(1, Math.min(4, Math.round((RES_H[curRes] || nativeH) / 320)));
      log('crosscode view ' + fixed.IG_WIDTH + 'x320 (' + ASPECT_NAMES[curAsp] + ') render x' + fixed.IG_GAME_SCALE +
        ' = ' + fixed.IG_WIDTH * fixed.IG_GAME_SCALE + 'x' + 320 * fixed.IG_GAME_SCALE);
    };
    computeCC();
    ['IG_WIDTH', 'IG_HEIGHT', 'IG_GAME_SCALE'].forEach(function (k) {
      Object.defineProperty(window, k, { configurable: true, get: function () { return fixed[k]; }, set: function () {} });
    });
    // The title-screen artwork is 568x320. At wider aspect ratios, scale it up to cover the screen
    // (cropping a little) instead of leaving black on the right.
    var titleFix = setInterval(function () {
      if (!(window.ig && ig.ParallaxGui && ig.ParallaxGui.inject)) return;
      clearInterval(titleFix);
      ig.ParallaxGui.inject({
        init: function (b, a) {
          this.parent(b, a);
          this.adaTitle = !!(b && b.parallax === 'title');
        },
        update: function () {
          if (this.adaTitle) {
            // The GUI system scales a hook and its whole subtree by currentState.scaleX/Y around hook.pivot.
            var W = ig.system.width, H = ig.system.height, k = Math.max(W / 568, H / 320, 1);
            this.hook.size.x = Math.ceil(W / k); this.hook.size.y = Math.ceil(H / k);
            this.hook.pivot.x = 0; this.hook.pivot.y = 0;
            this.hook.currentState.scaleX = k; this.hook.currentState.scaleY = k;
          }
          this.parent();
        }
      });
    }, 20);
    setInterval(function () {
      try {
        var vals = window.sc && sc.options && sc.options.values;
        if (!vals || !window.ig || !ig.system) return;
        var r = vals['ada-resolution'], a = vals['ada-aspect'];
        if (typeof r === 'number' && r !== curRes) {
          // Render scale only: safe to apply live.
          curRes = r; saveSetting('ada-resolution', r); computeCC();
          ig.system.resize(ig.system.width, ig.system.height, fixed.IG_GAME_SCALE);
          sc.options._setDisplaySize();
        }
        if (typeof a === 'number' && a !== curAsp) {
          curAsp = a; saveSetting('ada-aspect', a); computeCC();
          // Menus are laid out for the old width, so restart the game (from disk, keeping saves).
          if (sc.model && sc.model.isTitle && sc.model.isTitle()) {
            try { sc.options.persistOptions(); } catch (e) {}
            log('aspect changed on title screen: relaunching');
            setTimeout(function () { post({ op: 'relaunch' }); }, 600);
          } else {
            toast('Aspect ratio ' + ASPECT_NAMES[a] + ': applies after restarting the game');
          }
        }
      } catch (e) { log('display option change failed: ' + e); }
    }, 500);
  }
  function patched() {
    var real = [];
    try { real = [].slice.call(realGetGamepads()); } catch (e) {}
    hasReal = real.some(function (g) { return g; });
    var out = real.slice(0, 4);
    while (out.length < 4) out.push(null);
    if (!hasReal && (nativeConnected || overlayVisible)) {
      if (nativeConnected) applyNative();
      vpad.timestamp = performance.now(); out.push(vpad);
    }
    return out;
  }
  try { Object.defineProperty(navigator, 'getGamepads', { value: patched, configurable: true }); } catch (e) { navigator.getGamepads = patched; }

  function buildOverlay() {
    var root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;touch-action:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(root);

    function mk(css, text) {
      var d = document.createElement('div');
      d.style.cssText = 'position:absolute;pointer-events:auto;touch-action:none;color:#fff;font:600 16px -apple-system,sans-serif;' +
        'display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,255,255,.18);' +
        'border:2px solid rgba(255,255,255,.35);-webkit-user-select:none;' + css;
      if (text) d.textContent = text;
      root.appendChild(d); return d;
    }
    function button(css, text, idx) {
      var el = mk(css, text), ids = {};
      function upd() { setBtn(idx, Object.keys(ids).length > 0); el.style.background = Object.keys(ids).length ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.18)'; }
      el.addEventListener('touchstart', function (e) { e.preventDefault(); for (var t of e.changedTouches) ids[t.identifier] = 1; upd(); }, { passive: false });
      var end = function (e) { e.preventDefault(); for (var t of e.changedTouches) delete ids[t.identifier]; upd(); };
      el.addEventListener('touchend', end, { passive: false });
      el.addEventListener('touchcancel', end, { passive: false });
      return el;
    }
    function stick(css, ax, ay, pressIdx) {
      var base = mk(css), knob = document.createElement('div'), tid = null;
      knob.style.cssText = 'width:44%;height:44%;border-radius:50%;background:rgba(255,255,255,.5);pointer-events:none';
      base.appendChild(knob);
      function move(t) {
        var r = base.getBoundingClientRect(), R = r.width / 2;
        var dx = (t.clientX - (r.left + R)) / R, dy = (t.clientY - (r.top + R)) / R;
        var m = Math.sqrt(dx * dx + dy * dy); if (m > 1) { dx /= m; dy /= m; }
        vpad.axes[ax] = dx; vpad.axes[ay] = dy;
        knob.style.transform = 'translate(' + dx * R * 0.5 + 'px,' + dy * R * 0.5 + 'px)';
      }
      function reset() { tid = null; vpad.axes[ax] = 0; vpad.axes[ay] = 0; knob.style.transform = ''; }
      base.addEventListener('touchstart', function (e) { e.preventDefault(); if (tid === null) { tid = e.changedTouches[0].identifier; move(e.changedTouches[0]); } }, { passive: false });
      base.addEventListener('touchmove', function (e) { e.preventDefault(); for (var t of e.changedTouches) if (t.identifier === tid) move(t); }, { passive: false });
      var end = function (e) { e.preventDefault(); for (var t of e.changedTouches) if (t.identifier === tid) reset(); };
      base.addEventListener('touchend', end, { passive: false });
      base.addEventListener('touchcancel', end, { passive: false });
    }
    var S = 'width:130px;height:130px;';
    stick('left:28px;bottom:28px;' + S, 0, 1);
    stick('right:250px;bottom:20px;width:90px;height:90px;', 2, 3);
    var B = 'width:58px;height:58px;';
    button('right:30px;bottom:75px;' + B, 'A', 0);
    button('right:90px;bottom:30px;' + B, 'B', 1);
    button('right:90px;bottom:120px;' + B, 'X', 2);
    button('right:150px;bottom:75px;' + B, 'Y', 3);
    var SM = 'width:50px;height:34px;border-radius:17px;font-size:13px;';
    button('left:28px;top:14px;' + SM, 'LB', 4);
    button('left:84px;top:14px;' + SM, 'LT', 6);
    button('right:28px;top:14px;' + SM, 'RB', 5);
    button('right:84px;top:14px;' + SM, 'RT', 7);
    button('left:calc(50% - 60px);top:14px;' + SM, 'Sel', 8);
    button('left:calc(50% + 10px);top:14px;' + SM, 'Start', 9);
    // D-pad as four buttons next to the left stick
    var DP = 'width:40px;height:40px;border-radius:10px;font-size:14px;';
    button('left:230px;bottom:110px;' + DP, '▲', 12);
    button('left:230px;bottom:26px;' + DP, '▼', 13);
    button('left:188px;bottom:68px;' + DP, '◀', 14);
    button('left:272px;bottom:68px;' + DP, '▶', 15);

    var home = mk('left:50%;top:100px;width:34px;height:34px;transform:translateX(-50%);font-size:16px;', '⌂');
    home.addEventListener('touchstart', function (e) {
      e.preventDefault();
      post({ op: 'menu' });
    }, { passive: false });
    var hide = mk('left:50%;top:60px;width:34px;height:34px;transform:translateX(-50%);font-size:12px;', '👁');
    hide.addEventListener('touchstart', function (e) {
      e.preventDefault(); overlayVisible = !overlayVisible;
      [].forEach.call(root.children, function (c) { if (c !== hide) c.style.display = overlayVisible ? '' : 'none'; });
      hide.style.opacity = overlayVisible ? 1 : 0.4;
    }, { passive: false });

    // System buttons (display mode / hide pad / game menu) live outside `root` so they stay reachable
    // with a controller: they show whenever the touch pad shows, or for 3s after any touch.
    var sys = document.createElement('div');
    sys.style.cssText = 'position:fixed;top:calc(8px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:99999;' +
      'display:flex;gap:10px;pointer-events:none;align-items:center';
    [home, hide].forEach(function (b) {
      b.style.position = 'static'; b.style.left = b.style.top = ''; b.style.transform = '';
      b.style.width = b.style.height = '38px'; b.style.fontSize = '17px'; b.style.flex = 'none';
      sys.appendChild(b);
    });
    document.body.appendChild(sys);
    var sysUntil = 0;
    window.addEventListener('touchstart', function () { sysUntil = Date.now() + 3000; }, { capture: true, passive: true });

    function sync() {
      sys.style.display = (!(hasReal || nativeConnected) || Date.now() < sysUntil) ? 'flex' : 'none';
      try { hasReal = [].slice.call(realGetGamepads()).some(function (g) { return g && g.connected; }); } catch (e) {}
      root.style.display = (hasReal || nativeConnected) ? 'none' : '';
      setTimeout(sync, 300);
    }
    sync();
  }
  document.addEventListener('DOMContentLoaded', buildOverlay);
})();
