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
  document.addEventListener('DOMContentLoaded', function () {
    document.head.appendChild(meta);
    var st = document.createElement('style');
    st.textContent = 'html,body{margin:0;padding:0;background:#000;overflow:hidden;touch-action:none;' +
      '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}';
    document.head.appendChild(st);
  });

  // ---------- fs (read-only game tree via manifest, saves via native) ----------
  var files = Object.create(null);
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
    if (files[n]) return fetch('ada://game/' + n.split('/').map(encodeURIComponent).join('/'))
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
            if (first && !seen[first]) { seen[first] = 1; res.push({ name: first, isDirectory: function () { return rest.indexOf('/') >= 0; }, isFile: function () { return rest.indexOf('/') < 0; } }); }
          }
        });
      });
      setTimeout(function () { cb(null, res); }, 0);
    },
    unlinkSync: rm,
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

  // process must stay undefined so the engine takes its browser platform path.
  delete window.process;
  window.require = function (name) {
    switch (name) {
      case 'fs': return fs;
      case 'path': return path;
      case 'vm': return { createContext: function () { return {}; }, runInContext: function () {}, runInNewContext: function () {}, isContext: function () { return true; } };
      case './greenworks/greenworks': return { init: function () { return false; }, isSteamRunning: function () { return false; }, activateGameOverlayToStore: function () {} };
      default: return {};
    }
  };

  var noop = function () {};
  var winStub = { on: noop, once: noop, off: noop, show: noop, hide: noop, enterFullscreen: noop, leaveFullscreen: noop,
    close: function () { post({ op: 'quit' }); }, resizeTo: noop, moveTo: noop, setPosition: noop, focus: noop, zoomLevel: 0, window: window };
  window.nw = {
    App: { argv: [], dataPath: '/data', quit: function () { post({ op: 'quit' }); }, clearCache: noop },
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
      var c = new (Function.prototype.bind.apply(Orig, [null].concat([].slice.call(arguments))))();
      ctxs.push(c); return c;
    };
    P.prototype = Orig.prototype; P.__ada = true;
    window[nm] = P;
  });
  var suspended = false;
  function resumeAll() { ctxs.forEach(function (c) { if (c.state !== 'running') c.resume().catch(noop); }); }
  ['touchstart', 'touchend', 'pointerdown', 'click', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, function () { if (!suspended) resumeAll(); }, true);
  });
  window.__adaSuspend = function () { suspended = true; ctxs.forEach(function (c) { c.suspend().catch(noop); }); };
  window.__adaResume = function () { suspended = false; resumeAll(); };

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
  function patched() {
    var real = [];
    try { real = [].slice.call(realGetGamepads()); } catch (e) {}
    hasReal = real.some(function (g) { return g; });
    var out = real.slice(0, 4);
    while (out.length < 4) out.push(null);
    if (!hasReal && overlayVisible) { vpad.timestamp = performance.now(); out.push(vpad); }
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

    var hide = mk('left:50%;top:60px;width:34px;height:34px;transform:translateX(-50%);font-size:12px;', '👁');
    hide.addEventListener('touchstart', function (e) {
      e.preventDefault(); overlayVisible = !overlayVisible;
      [].forEach.call(root.children, function (c) { if (c !== hide) c.style.display = overlayVisible ? '' : 'none'; });
      hide.style.opacity = overlayVisible ? 1 : 0.4;
    }, { passive: false });

    function sync() {
      try { hasReal = [].slice.call(realGetGamepads()).some(function (g) { return g && g.connected; }); } catch (e) {}
      root.style.display = hasReal ? 'none' : '';
      setTimeout(sync, 300);
    }
    sync();
  }
  document.addEventListener('DOMContentLoaded', buildOverlay);
})();
