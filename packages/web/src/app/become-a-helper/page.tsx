"use client";

import Image from "next/image";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

export default function BecomeAHelper() {
  return (
    <div className="bg-white">
      <div className="container mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <h1 className="text-4xl font-black text-gray-900 font-display sm:text-5xl mb-6">
              Earn with dignity. Help your community.
            </h1>
            <p className="text-lg text-gray-600 mb-8">
              Join the Needy community as a verified helper. Whether you want to earn money assisting others with errands and hospital visits, or you want to volunteer your time, we provide a safe, respectful platform for you.
            </p>
            <div className="space-y-4 mb-8">
              {[
                "Flexible hours - you choose when and where to help.",
                "Every requester is verified too, and an alarm button is on every task.",
                "Choose between commercial tasks or volunteering.",
                "A one-time doorstep code confirms every job before it starts."
              ].map((benefit, idx) => (
                <div key={idx} className="flex items-start gap-3">
                  <CheckCircle2 className="text-primary mt-1" size={20} />
                  <span className="text-gray-700 font-medium">{benefit}</span>
                </div>
              ))}
            </div>
            <Link href="/signup" className="inline-flex justify-center rounded-2xl bg-primary px-8 py-4 text-lg font-medium text-white shadow-lg transition-transform hover:-translate-y-1 hover:bg-primary-dark">
              Start your application
            </Link>
          </div>
          <div className="relative w-full aspect-square rounded-3xl overflow-hidden bg-background">
             <Image 
               src="/helper.png" 
               alt="A confident, verified young adult wearing an ID badge" 
               fill
               className="object-contain p-8"
             />
          </div>
        </div>
      </div>
    </div>
  );
}
