import Foundation

/// Locates the imported game folder (the one holding index.html + dist/bundle.js),
/// builds the file manifest the JS shim needs, and persists save files.
final class GameStore {
    static let shared = GameStore()
    let fm = FileManager.default
    var docs: URL { fm.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    var importDir: URL { docs.appendingPathComponent("Game", isDirectory: true) }
    var savesDir: URL {
        let u = docs.appendingPathComponent("SaveData", isDirectory: true)
        try? fm.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    private func isGameRoot(_ u: URL) -> Bool {
        fm.fileExists(atPath: u.appendingPathComponent("index.html").path) &&
        fm.fileExists(atPath: u.appendingPathComponent("dist/bundle.js").path)
    }

    /// Looks in Documents (depth <= 3) so both in-app import and Files/iTunes drag-in work.
    func findRoot() -> URL? {
        // Game injected into the .app by tools/make-full-ipa.ps1 takes priority.
        if let b = Bundle.main.resourceURL?.appendingPathComponent("Game/terra"), isGameRoot(b) { return b }
        func search(_ dir: URL, _ depth: Int) -> URL? {
            if isGameRoot(dir) { return dir }
            if depth == 0 { return nil }
            let kids = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
            for k in kids where (try? k.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                if k.lastPathComponent == "SaveData" { continue }
                if let r = search(k, depth - 1) { return r }
            }
            return nil
        }
        return search(docs, 3)
    }

    /// Accepts the picked folder: either the install dir (contains terra/) or terra itself.
    func importFolder(_ picked: URL, progress: (String) -> Void) throws {
        let src: URL
        if isGameRoot(picked) { src = picked }
        else if isGameRoot(picked.appendingPathComponent("terra")) { src = picked.appendingPathComponent("terra") }
        else {
            throw NSError(domain: "ada", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "That folder has no terra/index.html + terra/dist/bundle.js. Pick the Alabaster Dawn folder (or its terra folder)."])
        }
        let dst = importDir.appendingPathComponent("terra", isDirectory: true)
        try? fm.removeItem(at: importDir)
        try fm.createDirectory(at: importDir, withIntermediateDirectories: true)
        progress("Copying game files (~600 MB)...")
        try fm.copyItem(at: src, to: dst)
        try? fm.removeItem(at: dst.appendingPathComponent("greenworks/lib"))
    }

    /// Relative file paths under root, for the sync existsSync() the audio loader uses.
    func manifest(root: URL) -> [String] {
        var out: [String] = []
        let base = root.standardizedFileURL.path
        if let en = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) {
            for case let u as URL in en {
                if (try? u.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
                    let p = u.standardizedFileURL.path
                    if p.hasPrefix(base + "/") { out.append(String(p.dropFirst(base.count + 1))) }
                }
            }
        }
        return out
    }

    // MARK: saves (keyed by normalized virtual path)
    private func fileFor(_ key: String) -> URL {
        let enc = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "x"
        return savesDir.appendingPathComponent(enc)
    }
    func putSave(key: String, data: String) {
        try? data.data(using: .utf8)?.write(to: fileFor(key), options: .atomic)
    }
    func delSave(key: String) { try? fm.removeItem(at: fileFor(key)) }

    func loadSaves() -> [String: [String: Any]] {
        var out: [String: [String: Any]] = [:]
        let files = (try? fm.contentsOfDirectory(at: savesDir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for f in files {
            guard let key = f.lastPathComponent.removingPercentEncoding,
                  let s = try? String(contentsOf: f, encoding: .utf8) else { continue }
            let m = (try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSince1970 ?? 0
            out[key] = ["data": s, "mtime": m * 1000]
        }
        return out
    }
}
