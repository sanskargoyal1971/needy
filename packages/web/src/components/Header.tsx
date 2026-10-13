"use client";

import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { SOSGlow } from "./SOSGlow";
import { useAuth } from "@/auth/AuthProvider";
import { homeFor, paths } from "@/lib/paths";

export function Header() {
  const { state, logout } = useAuth();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/40 bg-background/60 backdrop-blur-xl shadow-glass">
      <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href={paths.landing} className="flex items-center gap-2 group">
            <div className="relative">
              <div className="absolute -inset-1 bg-primary/20 rounded-full blur opacity-0 group-hover:opacity-100 transition duration-500"></div>
              <span className="relative font-display text-2xl font-black text-primary drop-shadow-sm">Needy</span>
            </div>
          </Link>
          <nav className="hidden gap-6 text-sm font-bold text-gray-600 md:flex">
            <Link href={paths.becomeHelper} className="transition-all hover:text-primary hover:-translate-y-0.5 inline-block">
              Become a Helper
            </Link>
            <Link href={paths.safety} className="transition-all hover:text-primary hover:-translate-y-0.5 inline-block">
              Trust &amp; Safety
            </Link>
            <Link href={paths.pricing} className="transition-all hover:text-primary hover:-translate-y-0.5 inline-block">
              Pricing
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          {/* Three states, not two. While `loading` the session is genuinely unknown — the
              tokens are httpOnly, so only /auth/me can answer — and rendering "Log in" during
              that window makes a signed-in user's own header flicker at them on every load. */}
          {state.status === "loading" ? (
            <div className="h-9 w-32 animate-pulse rounded-full bg-gray-200 shadow-inner" aria-hidden />
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
                Sign-in
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
                className="hidden text-sm font-bold text-gray-600 transition-all hover:text-primary sm:block hover:-translate-y-0.5"
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

          <div className="ml-2 transform hover:scale-110 transition-transform">
            <SOSGlow>
              <ShieldAlert size={24} />
            </SOSGlow>
          </div>
        </div>
      </div>
    </header>
  );
}
