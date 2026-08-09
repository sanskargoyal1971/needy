import type { ReactNode } from "react";
import { HelperShell } from "@/experience/HelperShell";

/** Everything under /helper is a signed-in helper with a live socket session — including the
 *  availability publish loop, which is why the driver is mounted at the layout and not per
 *  page: navigating between the offer list and the services screen must not de-list them. */
export default function HelperLayout({ children }: { children: ReactNode }) {
  return <HelperShell>{children}</HelperShell>;
}
