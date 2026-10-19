import Foundation

struct GameDef {
    let id: String
    let title: String
    let markers: [String]          // files that must exist under the game root
    let installSubdir: String      // folder inside the PC install that is the web root
    let entry: String              // page to load, relative to the root
    let fsPrefix: String           // path prefix the game's fs calls use for files under the root
    let dataPath: String           // what nw.App.dataPath returns
    let desktopProcess: Bool       // CrossCode needs a `process` object; Alabaster Dawn must not have one
}

enum Games {
    static let all: [GameDef] = [
        GameDef(id: "alabaster", title: "Alabaster Dawn", markers: ["index.html", "dist/bundle.js"],
                installSubdir: "terra", entry: "index.html", fsPrefix: "", dataPath: "/data", desktopProcess: false),
        GameDef(id: "crosscode", title: "CrossCode", markers: ["node-webkit.html", "js/game.compiled.js"],
                installSubdir: "assets", entry: "node-webkit.html", fsPrefix: "assets/", dataPath: "/saves/Default", desktopProcess: true),
    ]
}

/// Locates game folders (bundled in the .app by tools/make-full-ipa.ps1, imported, or dropped into Documents),
/// builds the file manifest the JS shim needs, and persists save files per game.
final class GameStore {
    static let shared = GameStore()
    let fm = FileManager.default
    var docs: URL { fm.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    var importDir: URL { docs.appendingPathComponent("Game", isDirectory: true) }

    func savesDir(_ g: GameDef) -> URL {
        let u = docs.appendingPathComponent("SaveData/\(g.id)", isDirectory: true)
        try? fm.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    private func isRoot(_ u: URL, _ g: GameDef) -> Bool {
        g.markers.allSatisfy { fm.fileExists(atPath: u.appendingPathComponent($0).path) }
    }

    func findRoot(_ g: GameDef) -> URL? {
        if let b = Bundle.main.resourceURL?.appendingPathComponent("Game/\(g.id)"), isRoot(b, g) { return b }
        let imported = importDir.appendingPathComponent(g.id)
        if isRoot(imported, g) { return imported }
        func search(_ dir: URL, _ depth: Int) -> URL? {
            if isRoot(dir, g) { return dir }
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

    func available() -> [GameDef] { Games.all.filter { findRoot($0) != nil } }

    /// Accepts the picked folder: a PC install dir, or the web-root folder itself. Returns the imported game.
    func importFolder(_ picked: URL) throws -> GameDef {
        for g in Games.all {
            let src: URL
            if isRoot(picked, g) { src = picked }
            else if isRoot(picked.appendingPathComponent(g.installSubdir), g) { src = picked.appendingPathComponent(g.installSubdir) }
            else { continue }
            let dst = importDir.appendingPathComponent(g.id, isDirectory: true)
            try? fm.removeItem(at: dst)
            try fm.createDirectory(at: importDir, withIntermediateDirectories: true)
            try fm.copyItem(at: src, to: dst)
            return g
        }
        throw NSError(domain: "ada", code: 1, userInfo: [NSLocalizedDescriptionKey:
            "No Alabaster Dawn (terra) or CrossCode (assets) game folder found there."])
    }

    /// Relative file paths under root, for the sync existsSync()/lstatSync() the games use.
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
    private func fileFor(_ g: GameDef, _ key: String) -> URL {
        let enc = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "x"
        return savesDir(g).appendingPathComponent(enc)
    }
    func putSave(_ g: GameDef, key: String, data: String) {
        try? data.data(using: .utf8)?.write(to: fileFor(g, key), options: .atomic)
    }
    func delSave(_ g: GameDef, key: String) { try? fm.removeItem(at: fileFor(g, key)) }

    func loadSaves(_ g: GameDef) -> [String: [String: Any]] {
        var out: [String: [String: Any]] = [:]
        let files = (try? fm.contentsOfDirectory(at: savesDir(g), includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for f in files {
            guard let key = f.lastPathComponent.removingPercentEncoding,
                  let s = try? String(contentsOf: f, encoding: .utf8) else { continue }
            let m = (try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSince1970 ?? 0
            out[key] = ["data": s, "mtime": m * 1000]
        }
        return out
    }
}
