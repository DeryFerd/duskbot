import ActivityKit
import AppIntents
import Foundation

/// A bot's turn on the lock screen and in the Dynamic Island. The bot host pushes the same JSON (content-state,
/// attributes), so a field here is a field there.
struct DuskTurnAttributes: ActivityAttributes {
    struct Ask: Codable, Hashable {
        /// "approve" or "answer"
        var kind: String
        var requestId: String
    }

    struct ContentState: Codable, Hashable {
        /// "working", "needs-you", "done" or "stopped"
        var phase: String
        /// what the running step does: write, edit, command, web, read, fetch, search, tool; nil while thinking
        var step: String?
        var steps: Int
        /// epoch seconds: a pushed Date would be read from 2001
        var startedAt: Double
        var ask: Ask?
        /// the reply's first line, sealed to this phone's line key
        var sealed: String?
        /// the reply's first line, set by the app itself
        var line: String?
    }

    var botId: String
    var botName: String
    var threadId: String
    var groupId: String?
    var color: String
    var body: String
}

extension DuskTurnAttributes.ContentState {
    var started: Date { Date(timeIntervalSince1970: startedAt) }
    var ended: Bool { phase == "done" || phase == "stopped" }

    /// the line under "Done": the app's own, else the sealed one opened with this phone's key
    var doneLine: String? {
        if let line, !line.isEmpty { return line }
        guard let sealed else { return nil }
        return TurnLineKey.open(sealed)
    }
}

/// What a Live Activity button asked the app to do, kept until the page takes it: the button opens the app, and the page
/// may not be listening yet.
enum PhoneActionInbox {
    static let posted = Notification.Name("DuskPhoneActionPosted")
    private static let key = "dusk.phoneActions"

    static func post(_ action: [String: Any]) {
        var list = UserDefaults.standard.array(forKey: key) ?? []
        list.append(action)
        UserDefaults.standard.set(Array(list.suffix(8)), forKey: key)
        NotificationCenter.default.post(name: posted, object: nil)
    }

    static func take() -> [[String: Any]] {
        let list = UserDefaults.standard.array(forKey: key) as? [[String: Any]] ?? []
        UserDefaults.standard.removeObject(forKey: key)
        return list
    }
}

/// The Live Activity's close button: that thread's activity leaves the Lock Screen, the Dynamic Island and a paired Mac's
/// menu bar now, without opening the app.
struct CloseTurnActivityIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Close"
    static var isDiscoverable = false

    @Parameter(title: "Conversation") var threadId: String

    init() {}

    init(threadId: String) {
        self.threadId = threadId
    }

    func perform() async throws -> some IntentResult {
        for activity in Activity<DuskTurnAttributes>.activities where activity.attributes.threadId == threadId {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        return .result()
    }
}

/// Approve on the Live Activity. Runs in the app (a LiveActivityIntent does), after Face ID, and opens the chat.
struct ApproveAskIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Approve"
    static var isDiscoverable = false
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Ask") var requestId: String
    @Parameter(title: "Conversation") var threadId: String
    @Parameter(title: "Bot") var botId: String
    @Parameter(title: "Room") var groupId: String

    init() {}

    init(requestId: String, threadId: String, botId: String, groupId: String?) {
        self.requestId = requestId
        self.threadId = threadId
        self.botId = botId
        self.groupId = groupId ?? ""
    }

    func perform() async throws -> some IntentResult {
        var data: [String: Any] = ["requestId": requestId, "threadId": threadId, "botId": botId]
        if !groupId.isEmpty { data["groupId"] = groupId }
        PhoneActionInbox.post(["actionId": "dusk.approve", "data": data])
        return .result()
    }
}
