import type { Metadata } from "next";
import { Inter, Merriweather } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { AuthProvider } from "@/auth/AuthProvider";

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
  description: "A hyperlocal trust platform that connects people who need immediate, verified assistance with background-verified local helpers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${merriweather.variable} font-sans antialiased bg-background text-foreground min-h-screen flex flex-col`}>
        {/* Wraps everything, including the Header, so the nav can reflect the session. The
            provider is a client component; the layout itself stays a server component, so
            marketing pages are still statically rendered. */}
        <AuthProvider>
          <Header />
          <main className="flex-grow">{children}</main>
          <Footer />
        </AuthProvider>
      </body>
    </html>
  );
}
