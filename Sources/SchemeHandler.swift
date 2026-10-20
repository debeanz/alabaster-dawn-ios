import WebKit

/// Serves ada://game/<path> from the imported game folder.
final class GameSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ada.scheme", qos: .userInitiated, attributes: .concurrent)

    let gameId: String
    private var patched: [String: Data] = [:]

    init(root: URL, gameId: String) {
        self.root = root.standardizedFileURL
        self.gameId = gameId
    }

    private static let adPixelOld = #""type":{"default":1,"list":[{"en_US":"640x360","langID":171},{"en_US":"1280x720","langID":172},{"en_US":"1920x1080","langID":173},{"en_US":"2560x1440","langID":203},{"en_US":"4096x2160","langID":204}],"type":"RADIO_GROUP"}"#
    private static let adPixelNew = #""type":{"default":0,"list":[{"en_US":"1280x720"},{"en_US":"1600x900"},{"en_US":"1920x1080"},{"en_US":"2106x1084"},{"en_US":"Native (max)"}],"type":"RADIO_GROUP"}"#
    private static let adScaling = #""screen-scaling":{"debug":false,"description":{"en_US":"Fit keeps the 16:9 picture with black bars. Stretch fills the whole screen."},"hidden":false,"inset":true,"label":{"en_US":"Screen Scaling"},"local":true,"type":{"default":0,"list":[{"en_US":"Fit"},{"en_US":"Stretch"}],"type":"RADIO_GROUP"},"category":"GRAPHICS"},"#
    private static let ccDefAnchor = #""display-type":{type:"BUTTON_GROUP",data:sc.DISPLAY_TYPE,init:sc.DISPLAY_TYPE.FIT,cat:sc.OPTION_CATEGORY.VIDEO},"#
    private static let ccResDef = #""ada-resolution":{type:"BUTTON_GROUP",data:{NATIVE:0,R2106:1,R1920:2,R1600:3,R1280:4},init:0,cat:sc.OPTION_CATEGORY.VIDEO,restart:true},"#

    /// Adds/changes in-game settings by patching the served data (the game files on disk are never edited).
    private func patch(_ rel: String, _ data: Data) -> Data {
        lock.lock(); let cached = patched[rel]; lock.unlock()
        if let c = cached { return c }
        var out = data
        if gameId == "alabaster", rel == "data/database/options.json", var str = String(data: data, encoding: .utf8) {
            // Resolution list tuned for iPhone (the stock 4096x2160 entry crashes WebKit), plus Fit/Stretch.
            str = str.replacingOccurrences(of: Self.adPixelOld, with: Self.adPixelNew)
            if let r = str.range(of: #""fullscreen":{"#) { str.insert(contentsOf: Self.adScaling, at: r.lowerBound) }
            out = str.data(using: .utf8) ?? data
        } else if gameId == "alabaster", rel == "dist/bundle.js", var str = String(data: data, encoding: .utf8) {
            // Render scale relative to the 640x360 base, matching the list above.
            str = str.replacingOccurrences(of: "const RESOLUTION_MAP = [1, 2, 3, 4, 6];",
                                           with: "const RESOLUTION_MAP = [2, 2.5, 3, 3, (window.__adaNativeScale || 3)];")
            out = str.data(using: .utf8) ?? data
        } else if gameId == "crosscode", rel == "js/game.compiled.js", var str = String(data: data, encoding: .utf8) {
            str = str.replacingOccurrences(of: Self.ccDefAnchor, with: Self.ccResDef + Self.ccDefAnchor)
            out = str.data(using: .utf8) ?? data
        } else if gameId == "crosscode", rel.hasPrefix("data/lang/sc/gui."), rel.hasSuffix(".json"),
                  var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  var labels = obj["labels"] as? [String: Any], var opts = labels["options"] as? [String: Any] {
            opts["ada-resolution"] = ["name": "Resolution",
                                      "group": ["Native", "2106x1084", "1920x1080", "1600x900", "1280x720"],
                                      "description": "Game resolution and aspect ratio. Wider resolutions show more of the world. Needs a restart (return to the game menu and start CrossCode again)."]
            labels["options"] = opts; obj["labels"] = labels
            out = (try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])) ?? data
        }
        lock.lock(); patched[rel] = out; lock.unlock()
        return out
    }

    private func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css"
        case "json": return "application/json"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ogg": return "audio/ogg"
        case "wav": return "audio/wav"
        case "ttf": return "font/ttf"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }

    private func isStopped(_ id: ObjectIdentifier) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped.contains(id)
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock(); stopped.remove(id); lock.unlock()
        queue.async { [self] in
            guard let url = task.request.url else { return }
            var rel = url.path.removingPercentEncoding ?? url.path
            if rel.hasPrefix("/") { rel.removeFirst() }
            if rel.isEmpty { rel = "index.html" }
            let file = root.appendingPathComponent(rel).standardizedFileURL
            var data: Data? = file.path.hasPrefix(root.path) ? try? Data(contentsOf: file, options: .mappedIfSafe) : nil
            if let d = data { data = patch(rel, d) }
            DispatchQueue.main.async {
                if self.isStopped(id) { return }
                var h = ["Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"]
                if let data = data {
                    h["Content-Type"] = self.mime(file.pathExtension)
                    h["Content-Length"] = String(data.count)
                    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: h)!)
                    task.didReceive(data)
                } else {
                    task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: h)!)
                }
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }
}
