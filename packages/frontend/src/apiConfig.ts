/** The backend origin, in one place.
 *
 *  It was previously duplicated as a private `const API` inside `authClient.ts` while the
 *  realtime drivers took a `baseUrl` prop that the demo harness filled from a text input. Those
 *  two could disagree, and did: the harness defaulted to `http://localhost:4000` while a
 *  deployed build read `VITE_API_URL`, so cookies set by one origin were never sent to the other. */
export const API_BASE: string = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/** A phone number a stuck user can actually call. Empty by default: the fallback then says
 *  "call our help line" generically rather than printing a tappable number that rings nowhere. */
export const SUPPORT_PHONE: string = import.meta.env.VITE_SUPPORT_PHONE ?? "";
