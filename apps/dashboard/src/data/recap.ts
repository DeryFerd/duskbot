import { useEffect, useState } from "react";
import type { AccountRecap } from "../../../../shared/account-recap";
import { api } from "../lib/api";

/** what the person and their bots did together; null while it loads or when it could not be read */
export function useRecap(on = true): { recap: AccountRecap | null; loading: boolean } {
  const [answer, setAnswer] = useState<{ recap: AccountRecap | null; loading: boolean }>({ recap: null, loading: on });
  useEffect(() => {
    if (!on) return;
    const controller = new AbortController();
    setAnswer((previous) => ({ recap: previous.recap, loading: true }));
    api.recap(controller.signal).then(
      (recap) => setAnswer({ recap, loading: false }),
      () => { if (!controller.signal.aborted) setAnswer({ recap: null, loading: false }); },
    );
    return () => controller.abort();
  }, [on]);
  return answer;
}
