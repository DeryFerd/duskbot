package bot.dusk.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PhoneNotificationsReadTest {

    @Test
    public void aReadClearsItsConversationUpToTheNewestLineShown() {
        assertTrue(PhoneNotifications.readClears("t1", "n2", "t1", "n2"));
    }

    @Test
    public void aReadLeavesANewerLineAndOtherConversations() {
        assertFalse(PhoneNotifications.readClears("t1", "n2", "t1", "n3"));
        assertFalse(PhoneNotifications.readClears("t1", "n2", "t2", "n2"));
        assertFalse(PhoneNotifications.readClears("t1", "", "t1", null));
    }
}
