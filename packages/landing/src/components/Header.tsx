import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { SOSGlow } from "./SOSGlow";

export function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-gray-100 bg-background/80 backdrop-blur-md">
      <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl font-black text-primary font-display">Needy</span>
          </Link>
          <nav className="hidden md:flex gap-6 text-sm font-medium text-gray-600">
            <Link href="/become-a-helper" className="hover:text-primary transition-colors">Become a Helper</Link>
            <Link href="/safety" className="hover:text-primary transition-colors">Trust & Safety</Link>
            <Link href="/pricing" className="hover:text-primary transition-colors">Pricing</Link>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <Link href="/login" className="hidden sm:block text-sm font-medium text-gray-600 hover:text-primary transition-colors">
            Log in
          </Link>
          <Link 
            href="/signup" 
            className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark"
          >
            Sign up
          </Link>
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
