"use client";

import { HelperExperience } from "@/experience/HelperExperience";

/**
 * `/helper` — where every approved helper is sent at sign-in.
 *
 * `homeFor()` has routed helpers here since the Vite app and the route did not exist: signing
 * in as a helper landed on a 404, which meant the platform had no way for the people who do
 * the work to receive any.
 */
export default function HelperHome() {
  return <HelperExperience />;
}
