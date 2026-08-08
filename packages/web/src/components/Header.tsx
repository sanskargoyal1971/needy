"use client";

import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { SOSGlow } from "./SOSGlow";
import { useAuth } from "@/auth/AuthProvider";
import { homeFor, paths } from "@/lib/paths";

export function Header() {
  const { state, logout } = useAuth();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-gray-100 bg-background/80 backdrop-blur-md">
      <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href={paths.landing} className="flex items-center gap-2">
            <span className="font-display text-2xl font-black text-primary">Needy</span>
          </Link>
          <nav className="hidden gap-6 text-sm font-medium text-gray-600 md:flex">
            <Link href={paths.becomeHelper} className="transition-colors hover:text-primary">
              Become a Helper
            </Link>
            <Link href={paths.safety} className="transition-colors hover:text-primary">
              Trust &amp; Safety
            </Link>
            <Link href={paths.pricing} className="transition-colors hover:text-primary">
              Pricing
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          {/* Three states, not two. While `loading` the session is genuinely unknown — the
              tokens are httpOnly, so only /auth/me can answer — and rendering "Log in" during
              that window makes a signed-in user's own header flicker at them on every load. */}
          {state.status === "loading" ? (
            <div className="h-9 w-32 animate-pulse rounded-full bg-gray-100" aria-hidden />
          ) : state.status === "authenticated" ? (
            <>
              <Link
                href={homeFor(state.user.role, state.user.onboardingStatus)}
                className="hidden text-sm font-medium text-gray-600 transition-colors hover:text-primary sm:block"
              >
                {state.user.displayName}
              </Link>
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark"
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <Link
                href={paths.login}
                className="hidden text-sm font-medium text-gray-600 transition-colors hover:text-primary sm:block"
              >
                Log in
              </Link>
              <Link
                href={paths.signup}
                className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark"
              >
                Sign up
              </Link>
            </>
          )}

          <div className="ml-2">
            <SOSGlow>
              <ShieldAlert size={24} />
            </SOSGlow>
          </div>
        </div>
      </div>
    </header>
  );
}
