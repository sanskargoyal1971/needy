"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ClipboardCheck, Flag, ScrollText, ShieldCheck, Siren, Users } from "lucide-react";
import { AppGate } from "@/auth/AppGate";
import { useAuth } from "@/auth/AuthProvider";
import { paths } from "@/lib/paths";

/** ── Admin shell ───────────────────────────────────────────────────────────
 *  Everything under /admin sits behind `AppGate requireAdmin`. That guard is a redirect, not
 *  the security boundary — every endpoint underneath independently requires the admin role,
 *  so a user who disables JavaScript reaches a console where every request 403s.
 *
 *  Not linked from any public navigation, deliberately. Nothing here should be discoverable
 *  by someone who was not told it exists.
 */

/** Alerts lead, and that ordering is the one opinion this nav holds: everything else here can
 *  wait until after lunch, and an alarm cannot. */
const NAV = [
  { href: paths.adminSos, label: "Alerts", icon: Siren },
  { href: paths.adminQueue, label: "Review queue", icon: ClipboardCheck },
  { href: paths.adminAbuse, label: "Signals", icon: Flag },
  { href: paths.adminUsers, label: "Users", icon: Users },
  { href: paths.adminAudit, label: "Audit log", icon: ScrollText },
  /** Super admin only. Hidden rather than shown-and-refused: a tab that 403s on every
   *  click teaches operators to ignore refusals. */
  { href: paths.adminStaff, label: "Operators", icon: ShieldCheck, superAdminOnly: true },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { state } = useAuth();
  const isSuperAdmin = state.status === "authenticated" && state.user.role === "super_admin";

  return (
    <AppGate requireAdmin>
      <div className="bg-background">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <header className="mb-6">
            <h1 className="font-display text-2xl font-black text-gray-900">Trust &amp; Safety</h1>
            <p className="mt-1 text-sm text-gray-600">
              Every document you open and every decision you make is recorded against your account.
            </p>
          </header>

          <nav className="mb-8 flex gap-1 border-b border-gray-200" aria-label="Admin sections">
            {NAV.filter((item) => !item.superAdminOnly || isSuperAdmin).map(
              ({ href, label, icon: Icon }) => {
                // startsWith so a packet detail page keeps its parent tab lit, but the exact
                // check first so /admin/users does not also light /admin.
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "border-primary text-primary"
                        : "border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900"
                    }`}
                  >
                    <Icon size={16} aria-hidden />
                    {label}
                  </Link>
                );
              },
            )}
          </nav>

          {children}
        </div>
      </div>
    </AppGate>
  );
}
