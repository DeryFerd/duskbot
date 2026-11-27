package bot.dusk.mobile;

import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.junit.Test;

public class MessagingServiceManifestTest {

    @Test
    public void duskServiceReceivesPushesInPlaceOfCapacitors() throws Exception {
        String manifest = new String(Files.readAllBytes(Paths.get("src/main/AndroidManifest.xml")), StandardCharsets.UTF_8);
        assertTrue(manifest.matches("(?s).*<service android:name=\"\\.DuskMessagingService\"[^>]*>\\s*<intent-filter>\\s*<action android:name=\"com\\.google\\.firebase\\.MESSAGING_EVENT\" />.*"));
        assertTrue(manifest.matches("(?s).*<service android:name=\"com\\.capacitorjs\\.plugins\\.pushnotifications\\.MessagingService\" tools:node=\"remove\" />.*"));
    }
}
