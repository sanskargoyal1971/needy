"use client";

import { ShieldCheck, KeyRound, MapPin, BellRing, PhoneCall } from "lucide-react";
import { SUPPORT_PHONE } from "@/lib/apiConfig";

export default function Safety() {
  return (
    <div className="bg-background py-16">
      <div className="container mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black text-gray-900 font-display mb-8">Trust & Safety</h1>
        <p className="text-xl text-gray-700 mb-12">
          Your safety is not an afterthought—it is the foundation of Needy. We have engineered multiple layers of security to ensure that you and your loved ones are protected at all times.
        </p>

        <section
          id="emergency"
          className="mb-12 scroll-mt-24 rounded-3xl border-2 border-red-300 bg-red-50 p-8"
        >
          <div className="mb-4 flex items-center gap-4">
            <div className="rounded-full bg-red-100 p-3 text-red-600">
              <PhoneCall size={32} aria-hidden />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">If you are in danger right now</h2>
          </div>
          <p className="text-lg text-gray-800">
            Call{" "}
            <a href="tel:112" className="font-black underline">
              112
            </a>{" "}
            first. Needy does not contact the police or an ambulance for you.
          </p>
          <p className="mt-3 text-gray-700">
            If you are on a task, open it and press the red alarm button there — that tells our
            Trust &amp; Safety team who you are with and where.
            {SUPPORT_PHONE && (
              <>
                {" "}
                You can also call us on{" "}
                <a href={`tel:${SUPPORT_PHONE}`} className="font-semibold underline">
                  {SUPPORT_PHONE}
                </a>
                .
              </>
            )}
          </p>
        </section>

        <div className="space-y-12">
          <section className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
            <div className="flex items-center gap-4 mb-4">
              <div className="p-3 bg-primary/10 rounded-full text-primary">
                <ShieldCheck size={32} />
              </div>
              <h2 className="text-2xl font-bold text-gray-900">Every helper is verified by a person</h2>
            </div>
            <p className="text-gray-600">
              Every helper submits a government ID, a live selfie and a short video. A person on our safety team reviews all three before the helper can see or accept any task, and every document view and decision is recorded in an audit log that cannot be edited.
            </p>
          </section>

          <section className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
            <div className="flex items-center gap-4 mb-4">
              <div className="p-3 bg-primary/10 rounded-full text-primary">
                <KeyRound size={32} />
              </div>
              <h2 className="text-2xl font-bold text-gray-900">A one-time code at your door</h2>
            </div>
            <p className="text-gray-600">
              Nothing starts until you say so. When your helper arrives they send you what they plan to do; the job only begins once you read it and share a one-time code with them in person. A video introduction before the helper sets off is planned and is not available yet.
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
              <h2 className="text-2xl font-bold text-gray-900">An alarm on every task</h2>
            </div>
            <p className="text-gray-600">
              An alarm button is always visible during an active task, for both the requester and the helper. Pressing it sends an alert with your task and address to our Trust & Safety team, who see it immediately on their console and record every action they take. It does not contact your family or the emergency services — for those, call 112.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
