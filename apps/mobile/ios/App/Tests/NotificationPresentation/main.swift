// Run by apps/mobile/ios/notification-presentation.node-test.mjs, which builds it with the app's NotificationPresentation.swift
// and Shared/TurnLineKey.swift.
import CryptoKit
import Foundation
import UserNotifications

var failures = 0
func check(_ ok: Bool, _ what: String) {
    if !ok { failures += 1; print("FAIL: \(what)") }
}

let banner: UNNotificationPresentationOptions = [.banner, .sound, .list]
check(NotificationPresentation.options(threadId: "t1", viewing: "t1") == [], "the conversation on screen shows nothing")
check(NotificationPresentation.options(threadId: "t1", viewing: "t2") == banner, "another conversation shows the system banner")
check(NotificationPresentation.options(threadId: "t1", viewing: nil) == banner, "the chat list or a sheet shows the system banner")
check(NotificationPresentation.options(threadId: nil, viewing: nil) == banner, "a notification about no conversation shows the banner")
check(NotificationPresentation.options(threadId: "", viewing: "") == banner, "an empty id never matches")

let fromHost = UNMutableNotificationContent()
fromHost.threadIdentifier = "aps-thread"
fromHost.userInfo = ["dusk": ["threadId": "t9", "id": "n1"]]
check(NotificationPresentation.threadId(of: fromHost) == "t9", "the bot host's own thread id comes first")
let apsOnly = UNMutableNotificationContent()
apsOnly.threadIdentifier = "t3"
check(NotificationPresentation.threadId(of: apsOnly) == "t3", "else the APNs thread-id")
check(NotificationPresentation.threadId(of: UNMutableNotificationContent()) == nil, "none at all is nil")

let fromOlderRelay = UNMutableNotificationContent()
fromOlderRelay.threadIdentifier = "aps-thread"
fromOlderRelay.userInfo = ["omb": ["threadId": "t7", "id": "n2", "botId": "b1"]]
check(NotificationPresentation.threadId(of: fromOlderRelay) == "t7", "an older relay's omb block gives the thread")
check(NotificationPresentation.field("id", of: fromOlderRelay.userInfo) == "n2", "and the notification id")
check(NotificationPresentation.field("botId", of: ["dusk": ["botId": ""]]) == nil, "an empty field is nil")

// sealed by Node (crypto x25519 + hkdf + aes-256-gcm, as the bot host does) to the key 32 bytes of 0x07
let previewKey = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
check(SealedText.base64url(previewKey.publicKey.rawRepresentation) == "E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20", "the vector's public key")
let sealedPreview = "4kOxLgUQ2idqnH5NCyffTjFipy1t8pwo06G2wRdMa2lFrAWOCyjCu3xUq1nV20-BHrDv-jybqowGU9nvJePsirlXPYF89ew1K5nobV1877qf8k6pXQWTNyMwG25fA2A"
check(SealedText.open(sealedPreview, with: previewKey, salt: SealedText.pushPreviewSalt) == "Your flight moves to 6:40, gate B12", "a sealed preview opens")
check(SealedText.open(sealedPreview, with: previewKey, salt: SealedText.turnLineSalt) == nil, "the Live Activity salt does not open it")
check(SealedText.open(sealedPreview, with: Curve25519.KeyAgreement.PrivateKey(), salt: SealedText.pushPreviewSalt) == nil, "another phone's key does not open it")
check(SealedText.open("not-sealed", with: previewKey, salt: SealedText.pushPreviewSalt) == nil, "garbage is nil")

if failures > 0 { exit(1) }
print("ok")
