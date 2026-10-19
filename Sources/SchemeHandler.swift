import WebKit

/// Serves ada://game/<path> from the imported game folder.
final class GameSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ada.scheme", qos: .userInitiated, attributes: .concurrent)

    init(root: URL) { self.root = root.standardizedFileURL }

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
            let data: Data? = file.path.hasPrefix(root.path) ? try? Data(contentsOf: file, options: .mappedIfSafe) : nil
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
