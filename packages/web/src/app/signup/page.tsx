"use client";

import Link from "next/link";
import { useState } from "react";


export default function Signup() {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");

  return (
    <div className="flex min-h-[calc(100vh-16rem)] items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-background">
      <div className="w-full max-w-md space-y-8 bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
        <div>
          <h2 className="mt-6 text-center text-3xl font-black tracking-tight text-gray-900 font-display">
            Create an account
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Join Needy to request or offer help
          </p>
        </div>
        
        <form className="mt-8 space-y-6" onSubmit={(e) => e.preventDefault()}>
          <div className="rounded-md shadow-sm space-y-4">
            <div>
              <label htmlFor="name" className="sr-only">Full Name</label>
              <input
                id="name"
                name="name"
                type="text"
                required
                className="relative block w-full rounded-xl border-0 py-3 px-4 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm sm:leading-6"
                placeholder="Full Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
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
          
          <div className="text-center text-xs text-gray-500 mt-4 px-4">
            By signing up, you agree to our <Link href="/terms" className="underline hover:text-gray-700">Terms of Service</Link> and <Link href="/privacy" className="underline hover:text-gray-700">Privacy Policy</Link>.
          </div>
        </form>
        
        <div className="text-center text-sm text-gray-600">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-primary hover:text-primary-dark">
            Log in
          </Link>
        </div>
      </div>
    </div>
  );
}
