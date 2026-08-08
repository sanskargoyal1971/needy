"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ClipboardCheck, ScrollText, Users } from "lucide-react";
import { AppGate } from "@/auth/AppGate";
import { paths } from "@/lib/paths";

/** ── Admin shell ───────────────────────────────────────────────────────────
 *  Everything under /admin sits behind `AppGate requireAdmin`. That guard is a redirect, not
 *  the security boundary — every endpoint underneath independently requires the admin role,
 *  so a user who disables JavaScript reaches a console where every request 403s.
 *
 *  Not linked from any public navigation, deliberately. Nothing here should be discoverable
 *  by someone who was not told it exists.
 */

const NAV = [
  { href: paths.adminQueue, label: "Review queue", icon: ClipboardCheck },
  { href: paths.adminUsers, label: "Users", icon: Users },
  { href: paths.adminAudit, label: "Audit log", icon: ScrollText },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

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
            {NAV.map(({ href, label, icon: Icon }) => {
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
            })}
          </nav>

          {children}
        </div>
      </div>
    </AppGate>
  );
}
