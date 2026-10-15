"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, ShieldAlert, X } from "lucide-react";
import { SOSGlow, TASK_ALARM_ID } from "./SOSGlow";
import { useAuth } from "@/auth/AuthProvider";
import { homeFor, paths } from "@/lib/paths";

const NAV = [
  { href: paths.becomeHelper, label: "Become a Helper" },
  { href: paths.safety, label: "Trust & Safety" },
  { href: paths.pricing, label: "Pricing" },
] as const;

export function Header() {
  const { state, logout } = useAuth();
  const router = useRouter();
  /** Below `md` the nav links (and, signed in, the account links) live behind this menu. They
   *  used to be `hidden` with nothing in their place: on a phone there was no way to reach
   *  Pricing or Trust & Safety from the header, and no "Log in" at all for a signed-out visitor. */
  const [menuOpen, setMenuOpen] = useState(false);
  /** Choosing a link closes it, so the next page does not open under a stale menu. */
  const close = () => setMenuOpen(false);

  /**
   * The red button in the header used to have no handler at all — the most alarming control
   * on the page, on every page, doing nothing. An alarm belongs to a task (it is what tells
   * the safety team who and where), so this does one of two honest things: on a task screen
   * it takes you to that task's alarm; anywhere else it takes you to the emergency
   * instructions, which lead with the number to call.
   */
  const onSos = () => {
    const alarm = document.getElementById(TASK_ALARM_ID);
    if (alarm) {
      alarm.scrollIntoView({ behavior: "smooth", block: "center" });
      alarm.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
      return;
    }
    router.push(`${paths.safety}#emergency`);
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/40 bg-background/60 backdrop-blur-xl shadow-glass">
      <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href={paths.landing} className="flex items-center gap-2 group">
            <div className="relative">
              <div className="absolute -inset-1 bg-primary/20 rounded-full blur opacity-0 group-hover:opacity-100 transition duration-500"></div>
              <span className="relative font-display text-2xl font-black text-primary drop-shadow-sm">
                Needy
              </span>
            </div>
          </Link>
          <nav className="hidden gap-6 text-sm font-bold text-gray-600 md:flex">
            {NAV.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="transition-all hover:text-primary hover:-translate-y-0.5 inline-block"
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          {/* Three states, not two. While `loading` the session is genuinely unknown — the
              tokens are httpOnly, so only /auth/me can answer — and rendering "Log in" during
              that window makes a signed-in user's own header flicker at them on every load. */}
          {state.status === "loading" ? (
            <div
              className="h-9 w-32 animate-pulse rounded-full bg-gray-200 shadow-inner"
              aria-hidden
            />
          ) : state.status === "authenticated" ? (
            <>
              <Link
                href={homeFor(state.user.role, state.user.onboardingStatus)}
                className="hidden text-sm font-bold text-gray-600 transition-all hover:text-primary sm:block hover:-translate-y-0.5"
              >
                {state.user.displayName}
              </Link>
              {/* The only route to the password screen. Without a link it would exist and be
                  unreachable — the same shape of gap that left the exception wizard with no
                  entrance until someone walked the flow. */}
              <Link
                href={paths.security}
                className="hidden text-sm font-bold text-gray-600 transition-all hover:text-primary sm:block hover:-translate-y-0.5"
              >
                Account security
              </Link>
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded-xl bg-gray-100 px-4 py-2 text-sm font-black text-gray-700 transition-all transform hover:translate-y-[1px] hover:bg-gray-200 active:translate-y-[2px] shadow-sm border border-gray-200"
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <Link
                href={paths.login}
                className="text-sm font-bold text-gray-600 transition-all hover:text-primary hover:-translate-y-0.5"
              >
                Log in
              </Link>
              <Link
                href={paths.signup}
                className="rounded-xl bg-primary px-5 py-2 text-sm font-black text-white transition-all transform hover:translate-y-[1px] hover:shadow-3d-button-hover active:translate-y-[2px] active:shadow-none shadow-3d-button hover:bg-primary-dark"
              >
                Sign up
              </Link>
            </>
          )}

          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            className="rounded-xl p-2 text-gray-700 hover:bg-gray-100 md:hidden"
          >
            {menuOpen ? <X size={22} aria-hidden /> : <Menu size={22} aria-hidden />}
            <span className="sr-only">{menuOpen ? "Close menu" : "Open menu"}</span>
          </button>

          <div className="ml-1 transform hover:scale-110 transition-transform sm:ml-2">
            <SOSGlow onClick={onSos}>
              <ShieldAlert size={24} aria-hidden />
              <span className="sr-only">Emergency help</span>
            </SOSGlow>
          </div>
        </div>
      </div>

      {menuOpen && (
        <nav
          id="mobile-menu"
          aria-label="Menu"
          className="border-t border-gray-200 bg-background px-4 pb-4 pt-2 md:hidden"
        >
          <ul className="flex flex-col text-base font-bold text-gray-700">
            {NAV.map(({ href, label }) => (
              <li key={href}>
                <Link
                  href={href}
                  onClick={close}
                  className="block rounded-xl px-2 py-3 hover:bg-gray-100"
                >
                  {label}
                </Link>
              </li>
            ))}
            {state.status === "authenticated" && (
              <>
                <li>
                  <Link
                    href={homeFor(state.user.role, state.user.onboardingStatus)}
                    onClick={close}
                    className="block rounded-xl px-2 py-3 hover:bg-gray-100"
                  >
                    {state.user.displayName} — your home
                  </Link>
                </li>
                <li>
                  <Link
                    href={paths.security}
                    onClick={close}
                    className="block rounded-xl px-2 py-3 hover:bg-gray-100"
                  >
                    Account security
                  </Link>
                </li>
              </>
            )}
          </ul>
        </nav>
      )}
    </header>
  );
}
