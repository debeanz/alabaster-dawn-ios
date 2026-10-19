import WebKit

/// Serves ada://game/<path> from the imported game folder.
final class GameSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ada.scheme", qos: .userInitiated, attributes: .concurrent)

    let gameId: String
    let aspectIndex: Int
    private var patched: [String: Data] = [:]

    init(root: URL, gameId: String, aspectIndex: Int) {
        self.root = root.standardizedFileURL
        self.gameId = gameId
        self.aspectIndex = aspectIndex
    }

    /// Adds in-game settings entries by patching the served data (the game files on disk are never edited).
    private func patch(_ rel: String, _ data: Data) -> Data {
        lock.lock(); let cached = patched[rel]; lock.unlock()
        if let c = cached { return c }
        var out = data
        if gameId == "alabaster", rel == "data/database/options.json", var str = String(data: data, encoding: .utf8) {
            let entry = "\"display-aspect\":{\"debug\":false,\"description\":{\"en_US\":\"Original keeps the 16:9 picture. Full and 1.943:1 stretch the image to fill the screen.\"},\"hidden\":false,\"label\":{\"en_US\":\"Screen Aspect\"},\"local\":true,\"type\":{\"default\":\(aspectIndex),\"list\":[{\"en_US\":\"16:9\"},{\"en_US\":\"Full\"},{\"en_US\":\"1.943:1\"}],\"type\":\"RADIO_GROUP\"},\"category\":\"GRAPHICS\"},"
            if let r = str.range(of: "\"fullscreen\":{") { str.insert(contentsOf: entry, at: r.lowerBound); out = str.data(using: .utf8) ?? data }
        } else if gameId == "crosscode", rel == "js/game.compiled.js", var str = String(data: data, encoding: .utf8) {
            str = str.replacingOccurrences(of: "STRETCH:3}", with: "STRETCH:3,WIDE:4}")
            str = str.replacingOccurrences(of: "case sc.DISPLAY_TYPE.STRETCH:k=true;a=b;b=i;j=true;break;",
                with: "case sc.DISPLAY_TYPE.STRETCH:k=true;a=b;b=i;j=true;break;case sc.DISPLAY_TYPE.WIDE:k=true;a=Math.min(b,i*1.943);b=i;j=true;break;")
            out = str.data(using: .utf8) ?? data
        } else if gameId == "crosscode", rel.hasPrefix("data/lang/sc/gui."), rel.hasSuffix(".json"),
                  var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  var labels = obj["labels"] as? [String: Any], var opts = labels["options"] as? [String: Any],
                  var dt = opts["display-type"] as? [String: Any], var group = dt["group"] as? [Any] {
            group.append("1.943:1"); dt["group"] = group; opts["display-type"] = dt; labels["options"] = opts; obj["labels"] = labels
            out = (try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])) ?? data
        }
        lock.lock(); patched[rel] = out; lock.unlock()
        return out
    }

    private func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html"
        case "js": return "text/javascript"
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
