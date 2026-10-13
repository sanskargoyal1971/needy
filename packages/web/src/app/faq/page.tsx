import Link from "next/link";
import { paths } from "@/lib/paths";

const FAQS: { q: string; a: string }[] = [
  {
    q: "How are helpers verified?",
    a: "Every helper submits a government ID, a live selfie and a short video. A person on our safety team reviews all three before the account is approved, and every review is recorded.",
  },
  {
    q: "How do I ask for help?",
    a: "Sign in, choose what you need, check the pin is where you are, and describe the job. We ask the verified helpers closest to you first and widen the search if nobody nearby can take it.",
  },
  {
    q: "What if nobody is available?",
    a: "We tell you. The search covers the area around you in three widening steps; if no one accepts, the request closes, nothing is charged, and you can ask again.",
  },
  {
    q: "What does the helper see about me?",
    a: "Only a rough area until one of them accepts. Your exact location is shared with the helper who accepted, and only while the task is active.",
  },
  {
    q: "What is the code at the door?",
    a: "When your helper arrives they send you what they plan to do. The job starts only when you share a one-time code with them in person, so nothing begins without your say-so.",
  },
  {
    q: "What happens if I press the alarm?",
    a: "During an active task, the alarm sends an alert with your task and address to our Trust & Safety team. It does not contact the police or your family for you — in an emergency, call 112.",
  },
  {
    q: "How much does it cost?",
    a: "Each service has a flat price shown before you ask. Social Service requests are free and go to helpers who have chosen to volunteer.",
  },
  {
    q: "Why can't I be matched with some helpers?",
    a: "For safety we do not automatically pair two adults under 36 of different genders. It applies to everyone, both ways round. If you both want to go ahead, you can each ask for a review by our safety team.",
  },
];

export default function Faq() {
  return (
    <div className="min-h-[calc(100vh-16rem)] bg-background py-16">
      <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <h1 className="mb-8 font-display text-4xl font-black text-gray-900">
          Frequently asked questions
        </h1>
        <div className="space-y-4">
          {FAQS.map((faq) => (
            <div key={faq.q} className="rounded-3xl border border-gray-100 bg-white p-6 shadow-sm">
              <h2 className="mb-2 text-lg font-bold text-gray-900">{faq.q}</h2>
              <p className="text-gray-600">{faq.a}</p>
            </div>
          ))}
        </div>
        <p className="mt-10 text-center text-gray-600">
          Something else?{" "}
          <Link href={paths.contact} className="font-semibold text-primary hover:underline">
            Contact us
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
