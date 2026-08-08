"use client";

import { ShieldCheck, Video, MapPin, BellRing } from "lucide-react";

export default function Safety() {
  return (
    <div className="bg-background py-16">
      <div className="container mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black text-gray-900 font-display mb-8">Trust & Safety</h1>
        <p className="text-xl text-gray-700 mb-12">
          Your safety is not an afterthought—it is the foundation of Needy. We have engineered multiple layers of security to ensure that you and your loved ones are protected at all times.
        </p>

        <div className="space-y-12">
          <section className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
            <div className="flex items-center gap-4 mb-4">
              <div className="p-3 bg-primary/10 rounded-full text-primary">
                <ShieldCheck size={32} />
              </div>
              <h2 className="text-2xl font-bold text-gray-900">Mandatory Aadhaar Verification</h2>
            </div>
            <p className="text-gray-600">
              Every helper on our platform must pass a rigorous identity verification process using government-issued Aadhaar credentials and a live selfie liveness check before they can see or accept any tasks.
            </p>
          </section>

          <section className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
            <div className="flex items-center gap-4 mb-4">
              <div className="p-3 bg-primary/10 rounded-full text-primary">
                <Video size={32} />
              </div>
              <h2 className="text-2xl font-bold text-gray-900">Pre-task Video Introduction</h2>
            </div>
            <p className="text-gray-600">
              Never open your door to a stranger. Once a helper accepts your request, a mandatory secure video call is initiated within the app so you can meet them face-to-face before they arrive.
            </p>
          </section>

          <section className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
            <div className="flex items-center gap-4 mb-4">
              <div className="p-3 bg-primary/10 rounded-full text-primary">
                <MapPin size={32} />
              </div>
              <h2 className="text-2xl font-bold text-gray-900">Live Location Tracking</h2>
            </div>
            <p className="text-gray-600">
              From the moment the helper is on their way until the task is marked complete, you can track their live location on a map. Location sharing is strictly scoped to the duration of the active task to protect privacy.
            </p>
          </section>

          <section className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 border-l-4 border-l-red-500">
            <div className="flex items-center gap-4 mb-4">
              <div className="p-3 bg-red-100 rounded-full text-red-600">
                <BellRing size={32} />
              </div>
              <h2 className="text-2xl font-bold text-gray-900">24/7 SOS Button</h2>
            </div>
            <p className="text-gray-600">
              An SOS button is always visible during an active task. One tap immediately sends your live location to your emergency contacts, flags the session for our 24/7 Trust & Safety review team, and initiates a callback to your phone.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
