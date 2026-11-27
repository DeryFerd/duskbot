import UIKit
import UserNotifications

/// Runs for each bot host push (mutable-content): the sealed preview becomes the body and the bot's avatar is attached.
/// Anything missing leaves that part as the push sent it.
final class NotificationService: UNNotificationServiceExtension {
    private var deliver: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        deliver = contentHandler
        original = request.content
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { return finish(request.content) }
        let info = content.userInfo
        if let sealed = NotificationPresentation.field("sealed", of: info), let preview = TurnLineKey.open(sealed, salt: SealedText.pushPreviewSalt) {
            let line = preview.trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty { content.body = line }
        }
        if content.threadIdentifier.isEmpty, let thread = NotificationPresentation.field("threadId", of: info) { content.threadIdentifier = thread }
        if let botId = NotificationPresentation.field("botId", of: info),
           let png = BotAvatars.png(for: botId) ?? LetterAvatar.png(name: content.title), let avatar = attachment(png) {
            content.attachments = [avatar]
        }
        finish(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let original { finish(original) }
    }

    private func finish(_ content: UNNotificationContent) {
        deliver?(content)
        deliver = nil
    }

    /// The system moves an attachment's file into its own store, so each push writes a fresh one.
    private func attachment(_ png: Data) -> UNNotificationAttachment? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("avatar-\(UUID().uuidString).png")
        do {
            try png.write(to: url)
            return try UNNotificationAttachment(identifier: "avatar", url: url, options: [UNNotificationAttachmentOptionsTypeHintKey: "public.png"])
        } catch {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }
}

/// A bot with no cached avatar: the first letter of its name on a neutral tonal circle.
enum LetterAvatar {
    static func png(name: String) -> Data? {
        guard let letter = name.trimmingCharacters(in: .whitespacesAndNewlines).first.map({ String($0).uppercased() }) else { return nil }
        let size = CGSize(width: 128, height: 128)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            UIColor(red: 0.894, green: 0.890, blue: 0.882, alpha: 1).setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
            let base = UIFont.systemFont(ofSize: 56, weight: .semibold)
            let font = base.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: 56) } ?? base
            let text = NSAttributedString(string: letter, attributes: [.font: font, .foregroundColor: UIColor(red: 0.290, green: 0.286, blue: 0.278, alpha: 1)])
            let bounds = text.size()
            text.draw(at: CGPoint(x: (size.width - bounds.width) / 2, y: (size.height - bounds.height) / 2))
        }
        return image.pngData()
    }
}
