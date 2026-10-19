# Alabaster Dawn iOS port - status

## Findings (from F:\SteamLibrary\steamapps\common\Alabaster Dawn)
- NW.js shell; `package.json` main = `terra/index.html`. Everything the game needs is in `terra/` (data, media, dist/bundle.js, page); ~2668 loose files, no packed archive, no encryption (only .eab audio = XOR, handled by the game itself).
- Node usage is tiny: `require('fs'|'path'|'vm'|'./greenworks/greenworks')`, `nw.App.dataPath/quit/argv`, `nw.Window.get()`, `nw.Screen`, `nw.Clipboard`. `process` must stay undefined so the engine takes its browser path (same trick as the Android port).
- fs is used for: (a) sync `existsSync` on audio files (-> manifest), (b) async saves via `fs.promises` readFile/writeFile/stat/rm/rename under `<dataPath>\Saves\{Default,Backups,Backups2}\` (-> shim in-memory map persisted natively), (c) debug-only stuff.
- Gamepad: engine polls `navigator.getGamepads()` and merges all pads, so a virtual touch pad can sit beside real ones.

## Done (code written, NOT yet built or run)
- XcodeGen project (`project.yml`), Swift shell: `GameViewController` (import UI, WKWebView, lifecycle), `SchemeHandler` (`ada://game/...`), `GameStore` (find/import game, manifest, saves).
- `Resources/shim.js`: Node/NW shims, audio unlock + suspend/resume, virtual gamepad + touch overlay (hidden when a real pad is connected).
- `.github/workflows/build.yml`: macOS runner, unsigned IPA artifact.

## Distribution plan (decided with user)
- Public GitHub repo (user has no private Actions minutes), code only, no game files. CI builds the game-less unsigned IPA.
- `tools/make-full-ipa.ps1` injects the user's own `terra/` into the IPA locally (Payload/AlabasterDawn.app/Game/terra); app prefers the bundled copy, falls back to in-app folder import. Full IPA is personal-use only, never uploaded.

## Next
1. Ask user OK to: init git repo (propose branch `ios-port`), create private GitHub repo, push; run workflow; fix compile errors from the log.
2. User copies the `terra` folder (or whole install) to the phone (Files / iTunes file sharing -> app Documents), installs the IPA via SideStore/LiveContainer, launches, and reports.
3. Likely tuning after first run: canvas sizing/scale, WebGL shader issues (Android needed uniform-limit fixes; unknown on iOS), touch layout, performance.
