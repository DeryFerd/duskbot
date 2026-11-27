import Foundation
import UserNotifications

/// What a notification shows while the app is open: the system's own banner, sound and list entry, except for the
/// conversation on screen, which shows nothing.
enum NotificationPresentation {
    static func options(threadId: String?, viewing: String?) -> UNNotificationPresentationOptions {
        if let threadId, !threadId.isEmpty, threadId == viewing { return [] }
        return [.banner, .sound, .list]
    }

    /// One field of the bot host's block on a push: `dusk`, or `omb` from older relays.
    static func field(_ name: String, of userInfo: [AnyHashable: Any]) -> String? {
        let block = (userInfo["dusk"] as? [AnyHashable: Any]) ?? (userInfo["omb"] as? [AnyHashable: Any])
        guard let value = block?[name] as? String, !value.isEmpty else { return nil }
        return value
    }

    /// The conversation a notification is about: the bot host's `threadId`, else the APNs `thread-id`.
    static func threadId(of content: UNNotificationContent) -> String? {
        field("threadId", of: content.userInfo) ?? (content.threadIdentifier.isEmpty ? nil : content.threadIdentifier)
    }
}
