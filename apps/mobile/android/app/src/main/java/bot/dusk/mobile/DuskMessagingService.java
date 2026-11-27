package bot.dusk.mobile;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Data-only dusk pushes (data.dusk = "1") are drawn by the app (PhoneNotifications) so they stack per conversation;
 * the rest, and the token, go through Capacitor's push plugin as before.
 */
public class DuskMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        if (message.getNotification() == null && PhoneNotifications.isDusk(message.getData())) {
            try {
                PhoneNotifications.show(this, message.getData());
            } catch (RuntimeException ignored) {}
        }
        super.onMessageReceived(message);
    }
}
