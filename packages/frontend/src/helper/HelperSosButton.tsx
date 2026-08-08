import { SosControl } from "../safety/SosControl.js";
import { useHelperSosPort } from "../safety/usePorts.js";

/**
 * The helper's SOS entry point.
 *
 * This file used to hold the whole implementation — the sheet, the kinds list, the sending
 * state, the failure notice. All of it now lives in the shared {@link SosControl}, because the
 * requester's copy of the same control had shipped as an animation with no network call and the
 * root cause was that there were two copies at all. Only one of them was ever audited; the alarm
 * is a property of the protocol, not of either role. See `safety/sosPort.ts`.
 *
 * Kept as a named component rather than inlining `<SosControl>` at the call site so the helper
 * tree keeps a role-shaped name, and so this file remains the obvious place to look.
 */
export function HelperSosButton() {
  const port = useHelperSosPort();
  return <SosControl port={port} />;
}
