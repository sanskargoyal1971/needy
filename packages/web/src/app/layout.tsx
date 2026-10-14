import type { Metadata } from "next";
import { connection } from "next/server";
import { Inter, Merriweather } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { AuthProvider } from "@/auth/AuthProvider";
import { MotionPreferencesProvider } from "@/motion/preferences";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const merriweather = Merriweather({
  subsets: ["latin"],
  weight: ["300", "400", "700", "900"],
  variable: "--font-merriweather",
});

export const metadata: Metadata = {
  title: "Needy | Immediate, verified assistance",
  description:
    "A hyperlocal trust platform that connects people who need immediate, verified assistance with ID-verified local helpers.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /**
   * Awaited purely to opt every page out of static prerendering, which is what makes the CSP in
   * `proxy.ts` work at all.
   *
   * This is not theoretical and it is not a preference. With the pages prerendered at build
   * time, the served HTML carried script tags with NO nonce while the proxy attached a
   * `script-src 'nonce-…' 'strict-dynamic'` header per request — and `strict-dynamic` makes
   * the browser ignore `'self'`, so EVERY script on the page would have been blocked. The
   * build reported twenty happy static routes and the app would have been blank in a browser.
   * Caught by serving the production build and grepping the HTML for `nonce=`, not by reading
   * the Next docs, which is the only way this class of mistake gets caught.
   *
   * Next stamps the nonce onto its own bootstrap scripts only when it renders per request, and
   * a page renders per request only when something waits for one. `connection()` is the
   * spelling Next 16 documents for exactly that; it replaces the `void headers()` this used on
   * Next 14, which stopped being enough once the request APIs became async — an un-awaited
   * `headers()` is a floating promise, not a read. The cost is real — the marketing pages are
   * no longer prerendered — and is discussed in proxy.ts.
   */
  await connection();

  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${merriweather.variable} font-sans antialiased bg-background text-foreground min-h-screen flex flex-col`}
      >
        {/* The motion preference wraps the public pages too, not only the signed-in shells:
            without a provider its context defaults to "motion allowed", and the landing page's
            3D objects would ignore an OS-level reduce-motion setting. The shells keep their
            own provider; the nearer one wins, which changes nothing for them. */}
        <MotionPreferencesProvider>
          {/* Wraps everything, including the Header, so the nav can reflect the session. */}
          <AuthProvider>
            <Header />
            <main className="flex-grow">{children}</main>
            <Footer />
          </AuthProvider>
        </MotionPreferencesProvider>
      </body>
    </html>
  );
}
