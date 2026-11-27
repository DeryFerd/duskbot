import CryptoKit
import Foundation
import Security

/// Text sealed to this phone's X25519 key: ephemeral public key (32) | nonce (12) | AES-256-GCM ciphertext | tag (16),
/// base64url, the AES key HKDF-SHA256(X25519 shared secret, salt, info "seal"). The salt says what the text is for.
enum SealedText {
    static let turnLineSalt = "dusk-turn-line-v1"
    static let pushPreviewSalt = "dusk-push-preview-v1"

    static func open(_ sealed: String, with key: Curve25519.KeyAgreement.PrivateKey, salt: String) -> String? {
        guard let raw = unbase64url(sealed), raw.count > 60 else { return nil }
        do {
            let ephemeral = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw.prefix(32))
            let shared = try key.sharedSecretFromKeyAgreement(with: ephemeral)
            let symmetric = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(salt.utf8), sharedInfo: Data("seal".utf8), outputByteCount: 32)
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: raw.subdata(in: 32..<44)), ciphertext: raw.subdata(in: 44..<(raw.count - 16)), tag: raw.suffix(16))
            return String(data: try AES.GCM.open(box, using: symmetric), encoding: .utf8)
        } catch {
            return nil
        }
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func unbase64url(_ text: String) -> Data? {
        var value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while value.count % 4 != 0 { value += "=" }
        return Data(base64Encoded: value)
    }
}

/// The X25519 key a done reply's first line and a notification's preview are sealed to. It lives in the keychain group
/// the app, its Live Activity and its notification extension share, readable after the first unlock so a locked phone
/// can show the text.
enum TurnLineKey {
    private static let service = "bot.dusk.turn-line"
    private static let account = "line-key"
    private static var group: String? { Bundle.main.object(forInfoDictionaryKey: "DuskKeychainGroup") as? String }

    private static func query() -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let group, !group.hasPrefix("$(") { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    static func stored() -> Curve25519.KeyAgreement.PrivateKey? {
        var item = query()
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data)
    }

    static func storedOrNew() -> Curve25519.KeyAgreement.PrivateKey? {
        if let key = stored() { return key }
        let key = Curve25519.KeyAgreement.PrivateKey()
        var item = query()
        item[kSecValueData as String] = key.rawRepresentation
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess ? key : nil
    }

    static func publicKey() -> String? {
        storedOrNew().map { SealedText.base64url($0.publicKey.rawRepresentation) }
    }

    static func open(_ sealed: String, salt: String = SealedText.turnLineSalt) -> String? {
        guard let key = stored() else { return nil }
        return SealedText.open(sealed, with: key, salt: salt)
    }
}
