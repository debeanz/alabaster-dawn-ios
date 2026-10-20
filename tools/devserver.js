// Desktop test harness: serves a game folder like the iOS app does (same served-file patches,
// same shim injected at document start) so changes can be checked in a desktop browser.
// Usage: node tools/devserver.js <alabaster|crosscode> <gameRoot> [port] [settingsJSON]
//   gameRoot = .../Alabaster Dawn/terra  or  .../CrossCode/assets
const http = require('http');
const fs = require('fs');
const path = require('path');

const [, , gameId, rootArg, portArg, settingsArg] = process.argv;
const root = path.resolve(rootArg);
const port = Number(portArg || 8123);
const repo = path.join(__dirname, '..');
const swift = fs.readFileSync(path.join(repo, 'Sources/SchemeHandler.swift'), 'utf8');
const raw = (name) => swift.match(new RegExp('let ' + name + ' = #"(.*)"#'))[1];
const GAMES = {
  alabaster: { entry: 'index.html', fsPrefix: 'terra/', dataPath: '/data', desktopProcess: false },
  crosscode: { entry: 'node-webkit.html', fsPrefix: 'assets/', dataPath: '/saves/Default', desktopProcess: true },
};
const game = GAMES[gameId];
let settings = settingsArg ? JSON.parse(settingsArg) : {};

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
const manifest = walk(root, root, []);
const saves = {};

// Mirrors GameSchemeHandler.patch in Sources/SchemeHandler.swift.
function patch(rel, buf) {
  if (gameId === 'alabaster' && rel === 'data/database/options.json') {
    let s = buf.toString('utf8').replace(raw('adPixelOld'), raw('adPixelNew'));
    s = s.replace('"hidden":false,"label":{"en_US":"Resolution","langID":170}', '"hidden":true,"label":{"en_US":"Resolution","langID":170}');
    const i = s.indexOf('"fullscreen":{');
    return Buffer.from(s.slice(0, i) + raw('adAspect') + raw('adScaling') + raw('adFps') + s.slice(i));
  }
  if (gameId === 'alabaster' && rel === 'dist/bundle.js') {
    const m = swift.match(/with: "(const RESOLUTION_MAP = .*?;)"\)/);
    return Buffer.from(buf.toString('utf8').replace('const RESOLUTION_MAP = [1, 2, 3, 4, 6];', m[1])
      .replace('system/* SYSTEM_CONF */.BD.SCREEN_WIDTH = 640;', 'system/* SYSTEM_CONF */.BD.SCREEN_WIDTH = (window.__adaScreenWidth || 640);')
      .replace('game_config/* GAME_CONF */.a.TRI_INIT = function (weltmeister) {', 'game_config/* GAME_CONF */.a.TRI_INIT = function (weltmeister) { window.__adaAtlasMgr = atlas_manager/* g_atlasManager */.vH;'));
  }
  if (gameId === 'crosscode' && rel === 'js/game.compiled.js') {
    return Buffer.from(buf.toString('utf8').replace(raw('ccDefAnchor'), raw('ccResDef') + raw('ccFpsDef') + raw('ccDefAnchor')).replace(raw('ccPixelSizeDef'), ''));
  }
  if (gameId === 'crosscode' && /^data\/lang\/sc\/gui\..*\.json$/.test(rel)) {
    const o = JSON.parse(buf.toString('utf8'));
    o.labels.options['ada-frame-rate'] = { name: 'Frame Rate', group: ['60 FPS', '120 FPS'], description: 'test' };
    o.labels.options['ada-show-fps'] = { name: 'Show FPS', description: 'test' };
    o.labels.options['ada-aspect'] = { name: 'Aspect Ratio', group: ['16:9', 'Full Screen', '1.943:1'], description: 'test' };
    return Buffer.from(JSON.stringify(o));
  }
  return buf;
}

const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css', json: 'application/json', png: 'image/png', ogg: 'audio/ogg' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__ada') { // shim bridge (webkit.messageHandlers stand-in)
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = JSON.parse(body);
      if (m.op === 'put') saves[m.key] = { data: m.data, mtime: Date.now() };
      else if (m.op === 'del') delete saves[m.key];
      else if (m.op === 'setting') { settings[m.key] = m.value; console.log('setting', m.key, m.value); }
      else if (m.op === 'log') console.log('[js]', m.msg.slice(0, 200));
      else console.log('op', m.op);
      res.end();
    });
    return;
  }
  if (url.pathname === '/__ada_decoder.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return res.end(fs.readFileSync(path.join(repo, 'Resources/ogg-vorbis-decoder.js')));
  }
  const rel = decodeURIComponent(url.pathname.slice(1)) || game.entry;
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
  let data = patch(rel, fs.readFileSync(file));
  if (rel === game.entry) {
    const boot = { manifest, saves, fsPrefix: game.fsPrefix, dataPath: game.dataPath, desktopProcess: game.desktopProcess, gameId, settings };
    const bridge = 'window.webkit={messageHandlers:{ada:{postMessage:function(m){navigator.sendBeacon("/__ada",JSON.stringify(m))}}}};';
    // HARNESS_RAF: drive frames with a timer so the game runs while the browser pane is hidden.
    const shim = (process.env.HARNESS_RAF ? 'window.requestAnimationFrame=function(cb){return setTimeout(function(){cb(performance.now())},16)};window.cancelAnimationFrame=clearTimeout;\n' : '') + (process.env.FORCE_WASM_OGG ? 'window.__ADA_FORCE_WASM_OGG=true;\n' : '') +
      fs.readFileSync(path.join(repo, 'Resources/shim.js'), 'utf8');
    // Decoder served as an external file: inline, the HTML parser would alter its embedded WASM data.
    const inject = '<script src="/__ada_decoder.js"></script><script>' + bridge + 'window.__ADA_BOOT=' + JSON.stringify(boot) + ';\n' + shim + '</script>';
    data = Buffer.from(data.toString('utf8').replace(/<head[^>]*>/i, (h) => h + inject));
  }
  res.setHeader('Content-Type', MIME[path.extname(rel).slice(1)] || 'application/octet-stream');
  res.end(data);
}).listen(port, () => console.log(gameId + ' on http://localhost:' + port));
