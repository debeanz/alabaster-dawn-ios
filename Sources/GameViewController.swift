import UIKit
import WebKit
import UniformTypeIdentifiers
import GameController

final class GameViewController: UIViewController, WKScriptMessageHandler, UIDocumentPickerDelegate, WKNavigationDelegate {
    private var webView: WKWebView?
    private var current: GameDef?
    private let titleLabel = UILabel()
    private let status = UILabel()
    private let menu = UIStackView()
    private var padLink: CADisplayLink?
    private var lastPad = ""
    private var padFrames = 0
    /// Per-game display settings mirrored from the in-game options (resolution, screen scaling).
    private func settings(_ id: String) -> [String: Any] {
        UserDefaults.standard.dictionary(forKey: "settings.\(id)") ?? [:]
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        titleLabel.text = "Choose a game"
        titleLabel.textColor = .white
        titleLabel.font = .boldSystemFont(ofSize: 26)
        status.textColor = .lightGray
        status.numberOfLines = 0
        status.textAlignment = .center
        status.font = .systemFont(ofSize: 14)
        menu.axis = .vertical
        menu.spacing = 14
        menu.alignment = .center
        menu.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(menu)
        NSLayoutConstraint.activate([
            menu.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            menu.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            menu.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.85),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(appInactive), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        let nc = NotificationCenter.default
        nc.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { [weak self] n in
            let c = n.object as? GCController
            self?.appendLog("GC connected: \(c?.vendorName ?? "?") category=\(c?.productCategory ?? "?") extended=\(c?.extendedGamepad != nil)")
        }
        nc.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { [weak self] _ in self?.appendLog("GC disconnected") }
        GCController.startWirelessControllerDiscovery(completionHandler: {})
        showMenu()
    }

    // MARK: launcher
    private func makeButton(_ title: String, _ action: Selector, tag: Int = 0, prominent: Bool = true) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: prominent ? 22 : 16, weight: prominent ? .semibold : .regular)
        b.tag = tag
        if prominent {
            b.backgroundColor = UIColor(white: 1, alpha: 0.15)
            b.setTitleColor(.white, for: .normal)
            b.layer.cornerRadius = 12
            b.contentEdgeInsets = UIEdgeInsets(top: 12, left: 40, bottom: 12, right: 40)
        }
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    private func showMenu() {
        padLink?.invalidate(); padLink = nil
        webView?.removeFromSuperview(); webView = nil; current = nil
        menu.arrangedSubviews.forEach { $0.removeFromSuperview() }
        menu.addArrangedSubview(titleLabel)
        let avail = GameStore.shared.available()
        for g in avail {
            menu.addArrangedSubview(makeButton(g.title, #selector(playTapped(_:)), tag: Games.all.firstIndex { $0.id == g.id } ?? 0))
        }
        if avail.isEmpty {
            status.text = "No game files found.\nImport your PC install folder (or its terra / assets folder) from Files."
        } else {
            let missing = Games.all.filter { g in !avail.contains { $0.id == g.id } }.map { $0.title }
            status.text = missing.isEmpty ? "" : "Not installed: " + missing.joined(separator: ", ")
        }
        menu.addArrangedSubview(status)
        menu.addArrangedSubview(makeButton("Import game folder...", #selector(pickFolder), prominent: false))
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
    }

    @objc private func playTapped(_ b: UIButton) { launch(Games.all[b.tag]) }

    @objc private func pickFolder() {
        let p = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        p.delegate = self
        present(p, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        menu.arrangedSubviews.forEach { $0.removeFromSuperview() }
        status.text = "Copying game files (can take a few minutes), please wait..."
        menu.addArrangedSubview(status)
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = url.startAccessingSecurityScopedResource()
            defer { if ok { url.stopAccessingSecurityScopedResource() } }
            var msg = ""
            var coordErr: NSError?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordErr) { u in
                do { let g = try GameStore.shared.importFolder(u); msg = "Imported \(g.title)." }
                catch { msg = "Import failed: \(error.localizedDescription)" }
            }
            if let coordErr = coordErr { msg = "Import failed: \(coordErr.localizedDescription)" }
            DispatchQueue.main.async {
                self.showMenu()
                self.status.text = msg + "\n" + (self.status.text ?? "")
            }
        }
    }

    // MARK: game
    private func launch(_ game: GameDef) {
        guard let root = GameStore.shared.findRoot(game) else { showMenu(); return }
        current = game
        menu.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let store = GameStore.shared
        let manifest = store.manifest(root: root)
        startGameLog(game, root: root, files: manifest.count)
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(GameSchemeHandler(root: root, gameId: game.id), forURLScheme: "ada")
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.userContentController.add(self, name: "ada")
        // Let requestAnimationFrame follow the display (120 Hz on ProMotion); the in-game Frame Rate option
        // caps it to 60 in JavaScript.
        unlockHighFrameRate(cfg.preferences)

        // Low-memory audio only for the launch right after an out-of-memory kill.
        let lowMemory = UserDefaults.standard.bool(forKey: "lowmem.\(game.id)")
        UserDefaults.standard.removeObject(forKey: "lowmem.\(game.id)")
        if lowMemory { appendLog("previous run was killed by iOS: using low-memory audio this launch") }
        let boot: [String: Any] = [
            "manifest": manifest,
            "saves": store.loadSaves(game),
            "fsPrefix": game.fsPrefix,
            "dataPath": game.dataPath,
            "desktopProcess": game.desktopProcess,
            "gameId": game.id,
            "settings": settings(game.id),
            "lowMemory": lowMemory,
        ]
        let json = (try? JSONSerialization.data(withJSONObject: boot)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        var src = "window.__ADA_BOOT = \(json);\n"
        for name in ["ogg-vorbis-decoder", "shim"] {
            if let u = Bundle.main.url(forResource: name, withExtension: "js"),
               let s = try? String(contentsOf: u, encoding: .utf8) { src += s + "\n" }
        }
        cfg.userContentController.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.scrollView.isScrollEnabled = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.bounces = false
        wv.isOpaque = true
        wv.backgroundColor = .black
        wv.scrollView.backgroundColor = .black
        if #available(iOS 16.4, *) { wv.isInspectable = true }
        wv.navigationDelegate = self
        view.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: view.topAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        webView = wv
        lastPad = ""
        padLink?.invalidate()
        padLink = CADisplayLink(target: self, selector: #selector(pollPad))
        padLink?.add(to: .main, forMode: .common)
        wv.load(URLRequest(url: URL(string: "ada://game/\(game.entry)")!))
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let op = d["op"] as? String else { return }
        let store = GameStore.shared
        switch op {
        case "put": if let g = current, let k = d["key"] as? String, let s = d["data"] as? String { store.putSave(g, key: k, data: s) }
        case "del": if let g = current, let k = d["key"] as? String { store.delSave(g, key: k) }
        case "setting":
            if let g = current, let k = d["key"] as? String, let val = d["value"] {
                var s = settings(g.id); s[k] = val
                UserDefaults.standard.set(s, forKey: "settings.\(g.id)")
            }
        case "log": appendLog((d["msg"] as? String) ?? "")
        case "relaunch":
            if let g = current {
                appendLog("relaunching to apply display settings")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.showMenu(); self.launch(g) }
            }
        case "quit", "menu":
            // Give pending save messages a moment, then return to the launcher.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.showMenu() }
        default: break
        }
    }

    // MARK: logs — Documents/Logs/<game>.log (and launcher.log), visible in the Files app.
    // Each game launch moves the previous log to <game>.prev.log.
    private static let logQueue = DispatchQueue(label: "ada.log")
    private static var logsDir: URL {
        let u = GameStore.shared.docs.appendingPathComponent("Logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    private static let stamp: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; f.locale = Locale(identifier: "en_US_POSIX"); return f
    }()

    private func startGameLog(_ game: GameDef, root: URL, files: Int) {
        let dir = Self.logsDir
        let cur = dir.appendingPathComponent("\(game.id).log"), prev = dir.appendingPathComponent("\(game.id).prev.log")
        Self.logQueue.sync {
            try? FileManager.default.removeItem(at: prev)
            try? FileManager.default.moveItem(at: cur, to: prev)
            FileManager.default.createFile(atPath: cur.path, contents: nil)
        }
        var sys = utsname(); uname(&sys)
        let model = withUnsafeBytes(of: &sys.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        appendLog("=== \(game.title) launch | device \(model) iOS \(UIDevice.current.systemVersion) | app \(ver) | RAM \(ProcessInfo.processInfo.physicalMemory / 1_048_576) MB")
        appendLog("root \(root.path) | files \(files) | saves \(GameStore.shared.loadSaves(game).count) | settings \(settings(game.id))")
        appendLog("screen \(UIScreen.main.bounds.size) scale \(UIScreen.main.scale) native \(UIScreen.main.nativeBounds.size)")
        appendLog("controllers: " + GCController.controllers().map { "\($0.vendorName ?? "?") extended=\($0.extendedGamepad != nil)" }.joined(separator: ", "))
    }

    private func appendLog(_ msg: String) {
        let url = Self.logsDir.appendingPathComponent("\(current?.id ?? "launcher").log")
        let line = "[\(Self.stamp.string(from: Date()))] \(msg)\n"
        Self.logQueue.async {
            if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
            guard let data = line.data(using: .utf8), let h = try? FileHandle(forWritingTo: url) else { return }
            defer { try? h.close() }
            h.seekToEndOfFile()
            if h.offsetInFile < 5_000_000 { h.write(data) }
        }
    }

    /// Turns off WebKit's "Prefer Page Rendering Updates near 60fps" feature flag (the switch Safari lists
    /// under Feature Flags) so requestAnimationFrame can run at 120 Hz on ProMotion screens. Private API:
    /// every step is checked first, and the result is logged.
    private func unlockHighFrameRate(_ prefs: WKPreferences) {
        let target = "PreferPageRenderingUpdatesNear60FPSEnabled"
        let variants = [("_features", "_setEnabled:forFeature:"),
                        ("_experimentalFeatures", "_setEnabled:forExperimentalFeature:"),
                        ("_internalDebugFeatures", "_setEnabled:forInternalDebugFeature:")]
        typealias SetFn = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let cls: AnyObject = WKPreferences.self
        let keySel = NSSelectorFromString("key")
        var related: [String] = []
        for (listName, setterName) in variants {
            let listSel = NSSelectorFromString(listName), setSel = NSSelectorFromString(setterName)
            guard cls.responds(to: listSel), prefs.responds(to: setSel),
                  let list = cls.perform(listSel)?.takeUnretainedValue() as? [NSObject] else { continue }
            for f in list where f.responds(to: keySel) {
                guard let key = f.value(forKey: "key") as? String else { continue }
                if key.contains("60") || key.contains("FPS") || key.lowercased().contains("framerate") { related.append(key) }
                if key == target {
                    let fn = unsafeBitCast(prefs.method(for: setSel), to: SetFn.self)
                    fn(prefs, setSel, false, f)
                    appendLog("120 Hz: turned off \(key) via \(setterName) (display max \(UIScreen.main.maximumFramesPerSecond) Hz)")
                    return
                }
            }
        }
        appendLog("120 Hz: flag not found, page stays at 60 fps. Related flags: \(related)")
    }

    // MARK: WKNavigationDelegate
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { appendLog("page loaded: \(webView.url?.absoluteString ?? "?")") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { appendLog("NAVIGATION FAILED: \(error)") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { appendLog("PAGE LOAD FAILED: \(error)") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS killed the page's process (usually out of memory). Without this the screen just stays black.
        appendLog("WEB CONTENT PROCESS TERMINATED (likely out of memory). Next launch uses low-memory audio. Returning to the launcher.")
        if let g = current { UserDefaults.standard.set(true, forKey: "lowmem.\(g.id)") }
        let title = current?.title ?? "The game"
        showMenu()
        status.text = "\(title) stopped: iOS closed the game's web process (likely out of memory). Details are in Files > Logs."
    }

    /// Forwards a physical controller (GameController framework) to the shim as a standard-layout pad.
    @objc private func pollPad() {
        guard let wv = webView else { return }
        var json = "{\"c\":0}"
        if let gp = GCController.controllers().compactMap({ $0.extendedGamepad }).first {
            let btns: [GCControllerButtonInput?] = [gp.buttonA, gp.buttonB, gp.buttonX, gp.buttonY, gp.leftShoulder, gp.rightShoulder,
                gp.leftTrigger, gp.rightTrigger, gp.buttonOptions, gp.buttonMenu, gp.leftThumbstickButton, gp.rightThumbstickButton,
                gp.dpad.up, gp.dpad.down, gp.dpad.left, gp.dpad.right, gp.buttonHome]
            let b = btns.map { String(format: "%.2f", $0?.value ?? 0) }.joined(separator: ",")
            let a = [gp.leftThumbstick.xAxis.value, -gp.leftThumbstick.yAxis.value,
                     gp.rightThumbstick.xAxis.value, -gp.rightThumbstick.yAxis.value].map { String(format: "%.2f", $0) }.joined(separator: ",")
            json = "{\"c\":1,\"b\":[\(b)],\"a\":[\(a)]}"
        }
        // Resend every ~0.5s too: the first sends can land before the page (and the shim) exists.
        padFrames += 1
        if json == lastPad && padFrames % 30 != 0 { return }
        lastPad = json
        wv.evaluateJavaScript("window.__adaN&&window.__adaN(\(json))")
    }

    @objc private func appInactive() { webView?.evaluateJavaScript("window.__adaSuspend && window.__adaSuspend()") }
    @objc private func appActive() { webView?.evaluateJavaScript("window.__adaResume && window.__adaResume()") }
}
