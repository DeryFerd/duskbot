package bot.dusk.mobile;

import android.app.NotificationManager;
import android.content.Intent;
import android.service.notification.StatusBarNotification;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The notifications the app draws itself (PhoneNotifications): the chat on screen, the ones shown, the preview key,
 * bot avatars, and taps. A tap that cold-starts the app waits for takeOpened(); later ones fire "action".
 */
@CapacitorPlugin(name = "DuskNotifications")
public class NotificationsPlugin extends Plugin {

    private static final List<JSObject> opened = new ArrayList<>();

    @Override
    public void load() {
        PhoneNotifications.foreground = true;
        take(getActivity().getIntent());
    }

    @Override
    protected void handleOnResume() {
        PhoneNotifications.foreground = true;
    }

    @Override
    protected void handleOnPause() {
        PhoneNotifications.foreground = false;
    }

    @Override
    protected void handleOnDestroy() {
        PhoneNotifications.foreground = false;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        take(intent);
    }

    private void take(Intent intent) {
        if (intent == null || !PhoneNotifications.TAP_ACTION.equals(intent.getAction())) return;
        String tap = intent.getStringExtra(PhoneNotifications.TAP_EXTRA);
        // consumed once, so a recreated activity does not open the chat again
        intent.removeExtra(PhoneNotifications.TAP_EXTRA);
        if (tap == null) return;
        JSObject action = new JSObject();
        try {
            action.put("actionId", "tap");
            action.put("data", new JSObject().put("dusk", new JSObject(tap)));
        } catch (JSONException ignored) {
            return;
        }
        synchronized (opened) {
            if (hasListeners("action")) notifyListeners("action", action);
            else opened.add(action);
        }
    }

    @PluginMethod
    public void takeOpened(PluginCall call) {
        JSArray actions = new JSArray();
        synchronized (opened) {
            for (JSObject action : opened) actions.put(action);
            opened.clear();
        }
        call.resolve(new JSObject().put("actions", actions));
    }

    @PluginMethod
    public void setViewing(PluginCall call) {
        String threadId = call.getString("threadId");
        PhoneNotifications.viewing = threadId == null || threadId.isEmpty() ? null : threadId;
        call.resolve();
    }

    @PluginMethod
    public void delivered(PluginCall call) {
        JSArray list = new JSArray();
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager != null) {
            for (StatusBarNotification item : PhoneNotifications.ours(manager)) {
                JSObject entry = new JSObject().put("id", item.getTag()).put("threadId", item.getTag());
                String id = PhoneNotifications.latestId(item);
                if (id != null) entry.put("notificationId", id);
                list.put(entry);
            }
        }
        call.resolve(new JSObject().put("notifications", list));
    }

    @PluginMethod
    public void remove(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager != null) {
            for (int at = 0; at < ids.length(); at++) {
                String id = ids.optString(at, "");
                if (!id.isEmpty()) manager.cancel(id, PhoneNotifications.MESSAGE_ID);
            }
            PhoneNotifications.summarize(getContext(), manager);
        }
        call.resolve();
    }

    // launcher badges follow the conversations' own counts (setNumber)
    @PluginMethod
    public void setBadge(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void previewKey(PluginCall call) {
        String key = PhoneNotifications.previewKey(getContext());
        JSObject result = new JSObject();
        if (key != null) result.put("key", key);
        call.resolve(result);
    }

    @PluginMethod
    public void cacheAvatars(PluginCall call) {
        JSArray avatars = call.getArray("avatars", new JSArray());
        Map<String, String> pngs = new HashMap<>();
        for (int at = 0; at < avatars.length(); at++) {
            JSONObject avatar = avatars.optJSONObject(at);
            if (avatar == null) continue;
            String botId = avatar.optString("botId", ""), png = avatar.optString("png", "");
            if (!botId.isEmpty() && !png.isEmpty()) pngs.put(botId, png);
        }
        getBridge().execute(() -> {
            PhoneNotifications.cacheAvatars(getContext(), pngs);
            call.resolve();
        });
    }
}
