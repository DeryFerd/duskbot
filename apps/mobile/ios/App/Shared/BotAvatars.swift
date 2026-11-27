import Foundation
import Security

/// Each bot's avatar (a small PNG) in the keychain group the app and its notification extension share, readable after
/// the first unlock so a push on a locked phone, with the app not running, can show it.
enum BotAvatars {
    private static let service = "bot.dusk.avatar"
    private static var group: String? { Bundle.main.object(forInfoDictionaryKey: "DuskKeychainGroup") as? String }

    private static func query(_ botId: String? = nil) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let botId { query[kSecAttrAccount as String] = botId }
        if let group, !group.hasPrefix("$(") { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    static func png(for botId: String) -> Data? {
        guard !botId.isEmpty else { return nil }
        var item = query(botId)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    /// keeps exactly these bots' avatars
    static func replace(with avatars: [String: Data]) {
        for botId in storedIds() where avatars[botId] == nil { SecItemDelete(query(botId) as CFDictionary) }
        for (botId, png) in avatars where !botId.isEmpty {
            let update: [String: Any] = [kSecValueData as String: png]
            if SecItemUpdate(query(botId) as CFDictionary, update as CFDictionary) == errSecItemNotFound {
                var item = query(botId)
                item[kSecValueData as String] = png
                item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                SecItemAdd(item as CFDictionary, nil)
            }
        }
    }

    private static func storedIds() -> [String] {
        var item = query()
        item[kSecReturnAttributes as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &out) == errSecSuccess, let list = out as? [[String: Any]] else { return [] }
        return list.compactMap { $0[kSecAttrAccount as String] as? String }
    }
}
