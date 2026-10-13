import Link from "next/link";
import { PhoneCall, ShieldAlert } from "lucide-react";
import { SUPPORT_PHONE } from "@/lib/apiConfig";
import { paths } from "@/lib/paths";

export default function Contact() {
  return (
    <div className="min-h-[calc(100vh-16rem)] bg-background py-16">
      <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <h1 className="mb-8 font-display text-4xl font-black text-gray-900">Contact us</h1>

        <section className="mb-6 rounded-3xl border-2 border-red-300 bg-red-50 p-6">
          <h2 className="mb-2 flex items-center gap-2 text-lg font-bold text-gray-900">
            <ShieldAlert size={20} className="text-red-600" aria-hidden />
            In an emergency
          </h2>
          <p className="text-gray-800">
            Call{" "}
            <a href="tel:112" className="font-black underline">
              112
            </a>
            . If you are on a task, also press the alarm button on that task so our safety team
            knows who you are with.
          </p>
        </section>

        <section className="rounded-3xl border border-gray-100 bg-white p-6 shadow-sm">
          <h2 className="mb-2 flex items-center gap-2 text-lg font-bold text-gray-900">
            <PhoneCall size={20} className="text-primary" aria-hidden />
            Support
          </h2>
          {SUPPORT_PHONE ? (
            <p className="text-gray-600">
              Call us on{" "}
              <a href={`tel:${SUPPORT_PHONE}`} className="font-semibold text-primary underline">
                {SUPPORT_PHONE}
              </a>
              .
            </p>
          ) : (
            // No number is configured for this deployment. Said plainly rather than filled
            // with an address nobody answers — a contact page that leads nowhere is worse
            // than one that says so.
            <div className="border-l-4 border-yellow-400 bg-yellow-50 p-4">
              <p className="text-sm font-medium text-yellow-800">
                A support phone number has not been set up for this site yet.
              </p>
            </div>
          )}
          <p className="mt-4 text-gray-600">
            Many questions are answered in the{" "}
            <Link href={paths.faq} className="font-semibold text-primary hover:underline">
              FAQ
            </Link>{" "}
            and on the{" "}
            <Link href={paths.safety} className="font-semibold text-primary hover:underline">
              Trust &amp; Safety
            </Link>{" "}
            page.
          </p>
        </section>
      </div>
    </div>
  );
}
