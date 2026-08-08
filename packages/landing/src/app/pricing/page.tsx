"use client";

import { CheckCircle2, Heart } from "lucide-react";
import Link from "next/link";

export default function Pricing() {
  return (
    <div className="bg-white py-16">
      <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
        <h1 className="text-4xl font-black text-gray-900 font-display mb-4">Transparent Pricing</h1>
        <p className="text-xl text-gray-600 mb-16 max-w-2xl mx-auto">
          Choose the mode of assistance that fits your needs. No hidden fees, no surge pricing, and no dark patterns.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto text-left">
          {/* Commercial Mode */}
          <div className="rounded-3xl border border-gray-200 p-8 shadow-sm">
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Commercial Mode</h2>
            <p className="text-gray-500 mb-6">Pay for immediate, professional assistance from verified helpers.</p>
            <div className="text-4xl font-black text-gray-900 mb-6">
              Hourly / Base Rate
            </div>
            <ul className="space-y-4 mb-8">
              {[
                "Helpers set their own base rates",
                "100% of tips go to the helper",
                "Secure in-app payments via Razorpay",
                "Automated receipts provided"
              ].map((feature, i) => (
                <li key={i} className="flex items-center gap-3">
                  <CheckCircle2 className="text-primary" size={20} />
                  <span className="text-gray-700">{feature}</span>
                </li>
              ))}
            </ul>
            <Link href="/signup" className="block w-full text-center rounded-xl bg-primary px-6 py-3 font-medium text-white transition-colors hover:bg-primary-dark">
              Request Commercial Help
            </Link>
          </div>

          {/* Social Service Mode */}
          <div className="rounded-3xl border border-accent p-8 shadow-md relative overflow-hidden bg-orange-50">
            <div className="absolute top-0 right-0 p-6 opacity-10">
              <Heart size={100} className="text-accent" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Social Service Mode</h2>
            <p className="text-gray-600 mb-6">For those who need help but cannot afford to pay.</p>
            <div className="text-4xl font-black text-accent mb-6">
              Free
            </div>
            <ul className="space-y-4 mb-8 relative z-10">
              {[
                "Routed to our network of verified volunteers",
                "Same rigorous safety and KYC standards",
                "Perfect for elderly care or emergency errands",
                "Driven by community compassion"
              ].map((feature, i) => (
                <li key={i} className="flex items-center gap-3">
                  <Heart className="text-accent" size={20} />
                  <span className="text-gray-700">{feature}</span>
                </li>
              ))}
            </ul>
            <Link href="/signup" className="block w-full text-center rounded-xl bg-accent px-6 py-3 font-medium text-white transition-colors hover:bg-orange-600 relative z-10">
              Request Volunteer Help
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
