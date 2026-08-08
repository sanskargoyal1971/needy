/** The backend origin, in one place.
 *
 *  Ported from the Vite app, where it existed because the origin had been duplicated as a
 *  private `const API` inside `authClient.ts` while the realtime drivers took a `baseUrl` prop
 *  filled from a text input. Those two could disagree, and did: cookies set by one origin were
 *  never sent to the other.
 *
 *  On Next the read is `process.env.NEXT_PUBLIC_*` rather than `import.meta.env.VITE_*`. Note
 *  these are inlined at BUILD time, not read at runtime, so the value baked into a production
 *  image is whatever was set when `next build` ran — it cannot be changed by restarting the
 *  container with a different env var. The Dockerfile therefore takes it as a build arg.
 */
export const API_BASE: string = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** A phone number a stuck user can actually call. Empty by default: the fallback then says
 *  "call our help line" generically rather than printing a tappable number that rings nowhere. */
export const SUPPORT_PHONE: string = process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? "";
