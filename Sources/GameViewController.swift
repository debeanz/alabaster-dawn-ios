import UIKit
import WebKit
import UniformTypeIdentifiers

final class GameViewController: UIViewController, WKScriptMessageHandler, UIDocumentPickerDelegate {
    private var webView: WKWebView?
    private let status = UILabel()
    private let button = UIButton(type: .system)

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        status.textColor = .white
        status.numberOfLines = 0
        status.textAlignment = .center
        status.font = .systemFont(ofSize: 16)
        button.setTitle("Import game folder", for: .normal)
        button.addTarget(self, action: #selector(pickFolder), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [status, button])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.8),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(appInactive), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        startIfPossible()
    }

    private func startIfPossible() {
        if let root = GameStore.shared.findRoot() {
            launch(root: root)
        } else {
            status.text = "Alabaster Dawn game files not found.\nPick your PC install folder (or its \"terra\" folder) from Files."
            button.isHidden = false
        }
    }

    @objc private func pickFolder() {
        let p = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        p.delegate = self
        present(p, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        button.isHidden = true
        status.text = "Copying game files (~600 MB), please wait..."
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = url.startAccessingSecurityScopedResource()
            defer { if ok { url.stopAccessingSecurityScopedResource() } }
            var err: Error?
            // Coordinate so iCloud-backed folders are downloaded first.
            var coordErr: NSError?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordErr) { u in
                do { try GameStore.shared.importFolder(u) { _ in } } catch { err = error }
            }
            if let coordErr = coordErr { err = coordErr }
            DispatchQueue.main.async {
                if let err = err {
                    self.status.text = "Import failed: \(err.localizedDescription)"
                    self.button.isHidden = false
                } else {
                    self.startIfPossible()
                }
            }
        }
    }

    private func launch(root: URL) {
        status.isHidden = true
        button.isHidden = true
        let store = GameStore.shared
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(GameSchemeHandler(root: root), forURLScheme: "ada")
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.userContentController.add(self, name: "ada")

        let manifest = store.manifest(root: root)
        let saves = store.loadSaves()
        let boot: [String: Any] = ["manifest": manifest, "saves": saves]
        let json = (try? JSONSerialization.data(withJSONObject: boot)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        var src = "window.__ADA_BOOT = \(json);\n"
        if let u = Bundle.main.url(forResource: "shim", withExtension: "js"),
           let s = try? String(contentsOf: u, encoding: .utf8) { src += s }
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
        view.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: view.topAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        webView = wv
        wv.load(URLRequest(url: URL(string: "ada://game/index.html")!))
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let op = d["op"] as? String else { return }
        let store = GameStore.shared
        switch op {
        case "put": if let k = d["key"] as? String, let s = d["data"] as? String { store.putSave(key: k, data: s) }
        case "del": if let k = d["key"] as? String { store.delSave(key: k) }
        case "log": NSLog("[ada-js] %@", (d["msg"] as? String) ?? "")
        case "quit": break // iOS apps do not self-terminate
        case "reimport":
            try? FileManager.default.removeItem(at: store.importDir)
            webView?.removeFromSuperview(); webView = nil
            status.isHidden = false
            startIfPossible()
        default: break
        }
    }

    @objc private func appInactive() { webView?.evaluateJavaScript("window.__adaSuspend && window.__adaSuspend()") }
    @objc private func appActive() { webView?.evaluateJavaScript("window.__adaResume && window.__adaResume()") }
}
