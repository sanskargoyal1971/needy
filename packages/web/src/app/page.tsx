"use client";

import Link from "next/link";
import { ShieldCheck, MapPin, Heart, Clock, Star, PhoneCall } from "lucide-react";
import { BreathingBackground } from "@/components/BreathingBackground";
import { Doorstep3D, Float, IconTile3D, MapPin3D, VerifiedShield3D } from "@/motion/depth";

export default function Home() {
  return (
    <div className="overflow-x-hidden">
      {/* 1. Hero Section */}
      <BreathingBackground className="relative border-b border-gray-100">
        <Float decorative className="pointer-events-none absolute top-20 left-10" amplitude={14}>
          <div className="w-64 h-64 bg-primary-100 rounded-full mix-blend-multiply filter blur-3xl opacity-70" />
        </Float>
        <Float
          decorative
          className="pointer-events-none absolute top-40 right-20"
          amplitude={14}
          delay={5}
        >
          <div className="w-72 h-72 bg-accent-light/30 rounded-full mix-blend-multiply filter blur-3xl opacity-70" />
        </Float>

        <div className="container mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-32 relative z-10">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-8 items-center">
            <div className="max-w-2xl relative z-20">
              <h1 className="text-4xl font-black tracking-tight text-gray-900 font-display sm:text-6xl mb-6 leading-tight drop-shadow-sm">
                Someone’s ready to{" "}
                <span className="text-primary relative inline-block">
                  help you
                  <svg
                    className="absolute -bottom-2 w-full h-3 text-accent/30"
                    viewBox="0 0 100 10"
                    preserveAspectRatio="none"
                  >
                    <path
                      d="M0 5 Q 50 10 100 5"
                      stroke="currentColor"
                      strokeWidth="8"
                      fill="none"
                    />
                  </svg>
                </span>{" "}
                right now.
              </h1>
              <p className="text-lg text-gray-700 mb-8 max-w-xl font-medium drop-shadow-sm">
                A hyperlocal platform connecting you with ID-verified, human-reviewed local helpers
                for errands, companionship, and immediate assistance.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 pt-2">
                <Link
                  href="/signup"
                  className="inline-flex justify-center items-center rounded-2xl bg-primary px-8 py-4 text-lg font-bold text-white transition-all transform shadow-3d-button hover:translate-y-1 hover:shadow-3d-button-hover hover:bg-primary-dark"
                >
                  I need help
                </Link>
                <Link
                  href="/become-a-helper"
                  className="inline-flex justify-center items-center rounded-2xl bg-white px-8 py-4 text-lg font-bold text-gray-900 ring-1 ring-inset ring-gray-200 transition-all transform shadow-sm hover:-translate-y-1 hover:shadow-3d-card hover:bg-gray-50"
                >
                  Become a Helper
                </Link>
              </div>

              {/* Trust Strip */}
              <div className="mt-12 flex flex-wrap items-center gap-6 text-sm font-bold text-gray-700 bg-white/60 backdrop-blur-md p-4 rounded-2xl shadow-sm border border-white">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-primary/10 rounded-lg">
                    <ShieldCheck className="text-primary" size={20} />
                  </div>
                  ID-verified helpers
                </div>
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-primary/10 rounded-lg">
                    <MapPin className="text-primary" size={20} />
                  </div>
                  Live tracking
                </div>
                <div className="flex items-center gap-2">
                  {/* Still, on purpose: a pulsing alarm icon on a landing page reads as urgency. */}
                  <div className="p-2 bg-accent/10 rounded-lg">
                    <PhoneCall className="text-accent" size={20} />
                  </div>
                  In-app SOS
                </div>
              </div>
            </div>

            {/* The hero illustration: a pin standing on a neighbourhood tile, with the two
                example cards drifting beside it. All of it is illustration — the claims it
                stands for are in the copy on the left — so it is hidden from screen readers
                and its example cards are not read out as if they were live. */}
            <div
              aria-hidden="true"
              className="relative mx-auto flex w-full max-w-lg items-center justify-center lg:max-w-none lg:pl-10 z-10"
            >
              <div className="relative flex w-full max-w-[460px] items-center justify-center">
                <div className="pointer-events-none absolute inset-[8%] rounded-full bg-[radial-gradient(closest-side,_rgba(27,122,122,0.16),_rgba(250,247,242,0))]" />
                <MapPin3D size={460} />

                <Float
                  className="absolute top-[10%] left-0 sm:-left-4 z-20 pointer-events-none"
                  amplitude={8}
                  delay={2}
                >
                  <div className="bg-white/90 backdrop-blur-md p-3 rounded-2xl shadow-3d-card flex items-center gap-3">
                    <div className="h-10 w-10 bg-green-100 text-green-600 rounded-full flex items-center justify-center font-bold">
                      <ShieldCheck size={20} />
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 font-bold">Verified Helper</div>
                      <div className="text-sm font-black text-gray-900">Arriving in 5m</div>
                    </div>
                  </div>
                </Float>

                <Float
                  className="absolute bottom-[12%] right-0 sm:-right-4 z-20 pointer-events-none"
                  amplitude={8}
                  delay={6}
                >
                  <div className="bg-white/90 backdrop-blur-md p-3 rounded-2xl shadow-3d-card flex items-center gap-3">
                    <div className="h-10 w-10 bg-accent/20 text-accent rounded-full flex items-center justify-center font-bold">
                      <Heart size={20} />
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 font-bold">New Request</div>
                      <div className="text-sm font-black text-gray-900">Hospital Visit</div>
                    </div>
                  </div>
                </Float>
              </div>
            </div>
          </div>
        </div>
      </BreathingBackground>

      {/* 2. How it works */}
      <section className="py-24 bg-white relative overflow-hidden">
        <div className="absolute right-0 top-0 w-1/3 h-full bg-gradient-to-l from-primary/5 to-transparent skew-x-12 transform origin-top-right"></div>
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center max-w-3xl mx-auto mb-20">
            <h2 className="text-4xl font-black font-display text-gray-900 tracking-tight">
              How it works
            </h2>
            <p className="mt-4 text-xl text-gray-600 font-medium">
              Simple, secure, and built for your peace of mind.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-12 relative">
            <div className="hidden md:block absolute top-16 left-1/8 right-1/8 h-1 bg-gradient-to-r from-primary-100 via-primary to-primary-100 rounded-full -z-10 shadow-sm" />

            {(
              [
                {
                  title: "Post a need",
                  desc: "Choose what you need help with and where you are.",
                  icon: <Clock size={28} />,
                  tone: "teal",
                },
                {
                  title: "See who is coming",
                  desc: "You see your helper's name and rating as soon as they accept, and can message them.",
                  icon: <ShieldCheck size={28} />,
                  tone: "teal",
                },
                {
                  title: "Track live",
                  desc: "See exactly where they are. You're never in the dark.",
                  icon: <MapPin size={28} />,
                  tone: "teal",
                },
                {
                  title: "Rate & done",
                  desc: "Leave a rating to help keep our community safe.",
                  icon: <Star size={28} />,
                  tone: "coral",
                },
              ] as const
            ).map((step, idx) => (
              <div key={idx} className="relative flex flex-col items-center text-center">
                {/* Staggered by a quarter cycle each, so the row ripples rather than marches. */}
                <IconTile3D tone={step.tone} size={128} delay={idx * 2.5} className="mb-4">
                  {step.icon}
                </IconTile3D>
                <h3 className="text-2xl font-black text-gray-900 mb-3">{step.title}</h3>
                <p className="text-gray-600 font-medium leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 3. Trust & Safety band */}
      <section className="py-24 bg-primary text-white overflow-hidden relative">
        <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white via-transparent to-transparent" />
        <div className="absolute top-0 right-0 -mt-20 -mr-20 w-96 h-96 bg-primary-dark rounded-full filter blur-3xl opacity-50"></div>
        <div className="absolute bottom-0 left-0 -mb-20 -ml-20 w-80 h-80 bg-accent/20 rounded-full filter blur-3xl opacity-30"></div>

        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 mb-6 text-sm font-bold tracking-wide">
                <ShieldCheck size={16} className="text-accent" /> SAFETY FIRST
              </div>
              <h2 className="text-4xl font-display font-black mb-6 leading-tight drop-shadow-md">
                Built on Trust & Security
              </h2>
              <p className="text-primary-100 mb-8 text-xl font-medium drop-shadow-sm">
                We take safety seriously. Our platform is designed with layers of protection so you
                can feel secure every step of the way.
              </p>
              <Link
                href="/safety"
                className="inline-flex items-center justify-center px-6 py-3 rounded-xl bg-white/10 hover:bg-white/20 border border-white/30 text-white font-bold transition-all hover:scale-105 backdrop-blur-sm shadow-glass"
              >
                Read our full safety policy →
              </Link>
            </div>
            <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-8 perspective-1000">
              <div className="bg-gradient-to-br from-primary-dark/80 to-primary/80 p-8 rounded-3xl backdrop-blur-xl border border-white/20 shadow-3d-card hover:shadow-3d-card-hover transition-all transform hover:-translate-y-2 hover:rotate-1">
                <VerifiedShield3D size={136} className="-mt-4 mb-2 -ml-4" />
                <h3 className="text-2xl font-black mb-3">Every helper is verified</h3>
                <p className="text-primary-100 font-medium leading-relaxed">
                  Every helper submits a government ID, a live selfie and a short video, and a
                  person on our safety team reviews them before they can accept any task.
                </p>
              </div>
              <div className="bg-gradient-to-br from-primary-dark/80 to-primary/80 p-8 rounded-3xl backdrop-blur-xl border border-white/20 shadow-3d-card hover:shadow-3d-card-hover transition-all transform hover:-translate-y-2 hover:-rotate-1">
                <Doorstep3D size={136} delay={5} className="-mt-4 mb-2 -ml-4" />
                <h3 className="text-2xl font-black mb-3">A code at your door</h3>
                <p className="text-primary-100 font-medium leading-relaxed">
                  Nothing starts until you say so. Your helper tells you what they will do, and the
                  job only begins when you share a one-time code with them at your door.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Category tiles */}
      <section className="py-24 bg-background relative">
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <h2 className="text-4xl font-black font-display text-gray-900 tracking-tight">
              What do you need help with?
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 perspective-1000">
            {["Hospital Visit", "Grocery & Shopping", "Companion Walk", "Pick & Deliver"].map(
              (cat, idx) => (
                <Link
                  href="/signup"
                  key={idx}
                  className="group relative rounded-3xl bg-white p-8 shadow-3d-card transition-all transform hover:shadow-3d-card-hover hover:-translate-y-2 flex flex-col items-center text-center border border-gray-100 overflow-hidden"
                >
                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-accent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                  <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-accent/20 to-accent/5 flex items-center justify-center mb-6 text-accent group-hover:scale-110 transition-transform shadow-inner group-hover:shadow-md">
                    <Heart size={32} />
                  </div>
                  <h3 className="text-xl font-black text-gray-900">{cat}</h3>
                </Link>
              ),
            )}
          </div>
        </div>
      </section>

      {/* 5. Social proof (Mock data flagged) */}
      <section className="py-24 bg-white border-t border-gray-100 relative">
        <div className="absolute left-0 bottom-0 w-full h-1/2 bg-gradient-to-t from-gray-50 to-transparent"></div>
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-16 rounded-r-xl shadow-sm max-w-3xl mx-auto flex items-start gap-3">
            <div className="mt-0.5">
              <Clock size={16} className="text-yellow-600" />
            </div>
            <p className="text-sm text-yellow-800 font-medium">
              <strong className="font-bold">Development Note:</strong> The testimonials and
              statistics shown below use mock data for demonstration purposes.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-20 text-center">
            <div className="p-8 rounded-3xl bg-white shadow-sm border border-gray-100 transform hover:scale-105 transition-transform">
              <div className="text-5xl font-black text-primary mb-2 font-display drop-shadow-sm">
                12,400+
              </div>
              <div className="text-gray-600 font-bold uppercase tracking-wider text-sm">
                Verified Helpers
              </div>
            </div>
            <div className="p-8 rounded-3xl bg-white shadow-sm border border-gray-100 transform hover:scale-105 transition-transform">
              <div className="text-5xl font-black text-primary mb-2 font-display drop-shadow-sm">
                45,000+
              </div>
              <div className="text-gray-600 font-bold uppercase tracking-wider text-sm">
                Tasks Completed
              </div>
            </div>
            <div className="p-8 rounded-3xl bg-white shadow-sm border border-gray-100 transform hover:scale-105 transition-transform">
              <div className="text-5xl font-black text-primary mb-2 font-display drop-shadow-sm">
                4.9/5
              </div>
              <div className="text-gray-600 font-bold uppercase tracking-wider text-sm">
                Average Rating
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
            <div className="bg-background p-10 rounded-3xl shadow-3d-card relative">
              <div className="absolute -top-6 -left-6 text-8xl text-primary/10 font-serif leading-none">
                "
              </div>
              <div className="flex gap-1 text-accent mb-6 relative z-10">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} size={24} fill="currentColor" />
                ))}
              </div>
              <p className="text-xl text-gray-800 italic mb-8 font-medium leading-relaxed relative z-10">
                "I was worried about sending my mother to the hospital alone while I was at work.
                The helper, Priya, was so gentle and kept me updated on the app the entire time. I
                felt completely at ease."
              </p>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center font-bold text-primary">
                  AS
                </div>
                <div>
                  <div className="font-black text-gray-900 text-lg">Ananya S.</div>
                  <div className="text-sm font-bold text-primary">Requester, Bengaluru</div>
                </div>
              </div>
            </div>
            <div className="bg-background p-10 rounded-3xl shadow-3d-card relative">
              <div className="absolute -top-6 -left-6 text-8xl text-primary/10 font-serif leading-none">
                "
              </div>
              <div className="flex gap-1 text-accent mb-6 relative z-10">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} size={24} fill="currentColor" />
                ))}
              </div>
              <p className="text-xl text-gray-800 italic mb-8 font-medium leading-relaxed relative z-10">
                "This platform gives me a dignified way to earn while genuinely helping people in my
                community. The doorstep code before every task makes me feel safe, too."
              </p>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center font-bold text-accent">
                  RM
                </div>
                <div>
                  <div className="font-black text-gray-900 text-lg">Rahul M.</div>
                  <div className="text-sm font-bold text-accent">Verified Helper, Mumbai</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Volunteer/social-service callout */}
      <section className="py-32 bg-gradient-to-br from-orange-50 to-orange-100 border-y border-orange-200 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-12 opacity-10 transform translate-x-1/4 -translate-y-1/4">
          <Heart size={400} className="text-accent" />
        </div>
        <div className="absolute bottom-0 left-0 p-12 opacity-5 transform -translate-x-1/4 translate-y-1/4">
          <Heart size={300} className="text-accent" />
        </div>

        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="max-w-2xl bg-white/40 backdrop-blur-xl p-10 rounded-3xl shadow-3d-card border border-white/60">
            <div className="inline-flex items-center justify-center p-3 bg-accent rounded-2xl text-white mb-8 shadow-inner shadow-black/20">
              <Heart size={32} fill="currentColor" />
            </div>
            <h2 className="text-4xl font-black font-display text-gray-900 mb-6 drop-shadow-sm">
              Give back to your community
            </h2>
            <p className="text-xl text-gray-800 mb-10 font-medium leading-relaxed">
              Needy isn't just a commercial platform. As a helper you can choose to offer Social
              Service — free help for people who can't afford to pay — alongside paid work, or
              instead of it.
            </p>
            <Link
              href="/become-a-helper"
              className="inline-flex justify-center rounded-2xl bg-accent px-8 py-4 text-lg font-bold text-white shadow-3d-button transition-transform hover:translate-y-1 hover:shadow-3d-button-hover hover:bg-orange-600 active:translate-y-2 active:shadow-none"
            >
              Join as a Volunteer
            </Link>
          </div>
        </div>
      </section>

      {/* 7. FAQ accordion */}
      <section className="py-24 bg-white relative">
        <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-black font-display text-gray-900">
              Frequently Asked Questions
            </h2>
          </div>
          <div className="space-y-6">
            {[
              {
                q: "How are helpers verified?",
                a: "Every helper submits a government ID, a live selfie and a short video. A person on our safety team reviews all three before the account is approved, and every review is recorded.",
              },
              {
                q: "What happens if I press the SOS button?",
                a: "During an active task, the alarm button sends an alert with your task and address to our Trust & Safety team, who see it immediately on their console. It does not contact the police or your family for you — in an emergency, call 112.",
              },
              {
                q: "Can I use Needy for free?",
                a: "Yes, you can request help under the 'Social Service' category. These requests are routed to our community of volunteers.",
              },
            ].map((faq, idx) => (
              <div
                key={idx}
                className="bg-white rounded-3xl p-8 shadow-3d-card border border-gray-100 hover:shadow-3d-card-hover transition-all transform hover:-translate-y-1"
              >
                <h3 className="text-xl font-black text-gray-900 mb-3 flex items-center gap-3">
                  <span className="text-primary">•</span> {faq.q}
                </h3>
                <p className="text-lg text-gray-600 font-medium pl-6">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
