"use client";

import Link from "next/link";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";

export default function Login() {
  const [phone, setPhone] = useState("");

  return (
    <div className="flex min-h-[calc(100vh-16rem)] items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-background">
      <div className="w-full max-w-md space-y-8 bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
        <div>
          <h2 className="mt-6 text-center text-3xl font-black tracking-tight text-gray-900 font-display">
            Welcome back
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Sign in to your Needy account
          </p>
        </div>
        
        <form className="mt-8 space-y-6" onSubmit={(e) => e.preventDefault()}>
          <div className="rounded-md shadow-sm space-y-4">
            <div>
              <label htmlFor="phone-number" className="sr-only">Phone Number</label>
              <input
                id="phone-number"
                name="phone"
                type="tel"
                required
                className="relative block w-full rounded-xl border-0 py-3 px-4 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm sm:leading-6"
                placeholder="Mobile Number"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>

          <div>
            <button
              type="submit"
              className="group relative flex w-full justify-center rounded-xl bg-primary px-3 py-3 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors"
            >
              Get OTP
            </button>
          </div>
          
          <div className="flex items-center justify-center gap-2 text-xs text-gray-500 mt-4">
            <ShieldCheck size={16} className="text-primary" />
            <span>Secure, passwordless login</span>
          </div>
        </form>
        
        <div className="text-center text-sm text-gray-600">
          Don't have an account?{' '}
          <Link href="/signup" className="font-semibold text-primary hover:text-primary-dark">
            Sign up
          </Link>
        </div>
      </div>
    </div>
  );
}
