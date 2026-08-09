import type { ReactNode } from "react";
import { RequesterShell } from "@/experience/RequesterShell";

/** Everything under /app is a signed-in requester with a live socket session. The shell owns
 *  both the guard and the driver so no individual page has to remember either. */
export default function RequesterLayout({ children }: { children: ReactNode }) {
  return <RequesterShell>{children}</RequesterShell>;
}
