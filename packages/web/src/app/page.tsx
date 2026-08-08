"use client";

import Image from "next/image";
import Link from "next/link";
import { ShieldCheck, Video, MapPin, Heart, Clock, Star, PhoneCall } from "lucide-react";
import { BreathingBackground } from "@/components/BreathingBackground";

import { RippleMarker } from "@/components/RippleMarker";

export default function Home() {
  return (
    <div>
      {/* 1. Hero Section */}
      <BreathingBackground className="relative border-b border-gray-100">
        <div className="container mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-32">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-8 items-center">
            <div className="max-w-2xl">
              <h1 className="text-4xl font-black tracking-tight text-gray-900 font-display sm:text-6xl mb-6">
                Someone’s ready to <span className="text-primary">help you</span> right now.
              </h1>
              <p className="text-lg text-gray-600 mb-8 max-w-xl">
                A hyperlocal platform connecting you with background-verified, trustworthy local helpers for errands, companionship, and immediate assistance.
              </p>
              <div className="flex flex-col sm:flex-row gap-4">
                <Link href="/signup" className="inline-flex justify-center rounded-2xl bg-primary px-8 py-4 text-lg font-medium text-white shadow-lg transition-transform hover:-translate-y-1 hover:shadow-xl hover:bg-primary-dark">
                  I need help
                </Link>
                <Link href="/become-a-helper" className="inline-flex justify-center rounded-2xl bg-white px-8 py-4 text-lg font-medium text-gray-900 shadow-sm ring-1 ring-inset ring-gray-200 transition-transform hover:-translate-y-1 hover:bg-gray-50">
                  Become a Helper
                </Link>
              </div>
              
              {/* Trust Strip */}
              <div className="mt-10 flex flex-wrap items-center gap-6 text-sm font-medium text-gray-600">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="text-primary" size={20} />
                  Aadhaar-verified helpers
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="text-primary" size={20} />
                  Live tracking
                </div>
                <div className="flex items-center gap-2">
                  <PhoneCall className="text-primary" size={20} />
                  24/7 SOS
                </div>
              </div>
            </div>
            
            <div className="relative mx-auto w-full max-w-lg lg:max-w-none">
              <div className="relative w-full aspect-square rounded-3xl overflow-hidden shadow-2xl ring-1 ring-gray-900/10 bg-white/50 backdrop-blur-sm p-4">
                 <Image 
                   src="/hero.png" 
                   alt="A helpful person assisting an elderly person with groceries" 
                   fill
                   className="object-cover rounded-2xl"
                 />
              </div>
            </div>
          </div>
        </div>
      </BreathingBackground>

      {/* 2. How it works */}
      <section className="py-24 bg-white">
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <h2 className="text-3xl font-bold font-display text-gray-900 sm:text-4xl">How it works</h2>
            <p className="mt-4 text-lg text-gray-600">Simple, secure, and built for your peace of mind.</p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 relative">
            <div className="hidden md:block absolute top-12 left-1/8 right-1/8 h-0.5 bg-gray-100 -z-10" />
            
            {[
              { title: "Post a need", desc: "Select what you need help with and set a time window.", icon: <Clock size={24} className="text-primary" /> },
              { title: "Meet on video", desc: "Have a quick video call with your matched helper before they arrive.", icon: <Video size={24} className="text-primary" /> },
              { title: "Track live", desc: "See exactly where they are. You're never in the dark.", icon: <RippleMarker size={32} /> },
              { title: "Rate & done", desc: "Leave a rating to help keep our community safe.", icon: <Star size={24} className="text-primary" /> },
            ].map((step, idx) => (
              <div key={idx} className="relative flex flex-col items-center text-center group">
                <div className="h-24 w-24 rounded-full bg-background flex items-center justify-center mb-6 shadow-sm border border-gray-100 group-hover:scale-105 transition-transform">
                  {step.icon}
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">{step.title}</h3>
                <p className="text-gray-600">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 3. Trust & Safety band */}
      <section className="py-24 bg-primary text-white overflow-hidden relative">
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white via-transparent to-transparent" />
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
            <div>
              <h2 className="text-3xl font-display font-bold mb-6">Built on Trust</h2>
              <p className="text-primary-100 mb-8 text-lg">
                We take safety seriously. Our platform is designed with layers of protection so you can feel secure every step of the way.
              </p>
              <Link href="/safety" className="inline-flex items-center text-white font-medium hover:text-accent transition-colors">
                Read our full safety policy →
              </Link>
            </div>
            <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-8">
              <div className="bg-primary-dark/50 p-6 rounded-2xl backdrop-blur-sm border border-white/10 hover:-translate-y-1 transition-transform">
                <ShieldCheck size={32} className="text-accent mb-4" />
                <h3 className="text-xl font-bold mb-2">100% Aadhaar Verified</h3>
                <p className="text-primary-100">Every helper undergoes rigorous government ID verification and a liveness check before they can see any tasks.</p>
              </div>
              <div className="bg-primary-dark/50 p-6 rounded-2xl backdrop-blur-sm border border-white/10 hover:-translate-y-1 transition-transform">
                <Video size={32} className="text-accent mb-4" />
                <h3 className="text-xl font-bold mb-2">Pre-task Video Intro</h3>
                <p className="text-primary-100">Never open your door to a stranger. Meet your helper face-to-face via an in-app secure video call before they arrive.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Category tiles */}
      <section className="py-24 bg-background">
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <h2 className="text-3xl font-bold font-display text-gray-900 sm:text-4xl">What do you need help with?</h2>
          </div>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {['Hospital Visit', 'Grocery & Shopping', 'Companion Walk', 'Pick & Deliver'].map((cat, idx) => (
              <Link href="/signup" key={idx} className="group relative rounded-3xl bg-white p-8 shadow-sm ring-1 ring-gray-200 transition-all hover:shadow-lg hover:-translate-y-1 flex flex-col items-center text-center">
                <div className="h-16 w-16 rounded-full bg-accent/10 flex items-center justify-center mb-6 text-accent group-hover:scale-110 transition-transform">
                  <Heart size={28} />
                </div>
                <h3 className="text-lg font-bold text-gray-900">{cat}</h3>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* 5. Social proof (Mock data flagged) */}
      <section className="py-24 bg-white border-t border-gray-100">
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-12 rounded-r-lg max-w-3xl mx-auto">
            <p className="text-sm text-yellow-800">
              <strong className="font-semibold">Development Note:</strong> The testimonials and statistics shown below use mock data for demonstration purposes.
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16 text-center">
            <div>
              <div className="text-4xl font-black text-primary mb-2 font-display">12,400+</div>
              <div className="text-gray-600 font-medium">Verified Helpers</div>
            </div>
            <div>
              <div className="text-4xl font-black text-primary mb-2 font-display">45,000+</div>
              <div className="text-gray-600 font-medium">Tasks Completed</div>
            </div>
            <div>
              <div className="text-4xl font-black text-primary mb-2 font-display">4.9/5</div>
              <div className="text-gray-600 font-medium">Average Rating</div>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="bg-background p-8 rounded-3xl">
              <div className="flex gap-1 text-accent mb-4">
                {[...Array(5)].map((_, i) => <Star key={i} size={20} fill="currentColor" />)}
              </div>
              <p className="text-lg text-gray-700 italic mb-6">
                "I was worried about sending my mother to the hospital alone while I was at work. The helper, Priya, was so gentle and kept me updated on the app the entire time. I felt completely at ease."
              </p>
              <div className="font-bold text-gray-900">Ananya S.</div>
              <div className="text-sm text-gray-500">Requester, Bengaluru</div>
            </div>
            <div className="bg-background p-8 rounded-3xl">
              <div className="flex gap-1 text-accent mb-4">
                {[...Array(5)].map((_, i) => <Star key={i} size={20} fill="currentColor" />)}
              </div>
              <p className="text-lg text-gray-700 italic mb-6">
                "This platform gives me a dignified way to earn while genuinely helping people in my community. The video verification before every task makes me feel safe, too."
              </p>
              <div className="font-bold text-gray-900">Rahul M.</div>
              <div className="text-sm text-gray-500">Verified Helper, Mumbai</div>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Volunteer/social-service callout */}
      <section className="py-24 bg-orange-50 border-y border-orange-100 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-12 opacity-10">
          <Heart size={200} className="text-accent" />
        </div>
        <div className="container mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold font-display text-gray-900 sm:text-4xl mb-6">Give back to your community</h2>
            <p className="text-lg text-gray-700 mb-8">
              Needy isn't just a commercial platform. You can toggle into Volunteer Mode anytime to help those who can't afford to pay. Log volunteer hours, build community trust, and make a real difference.
            </p>
            <Link href="/become-a-helper" className="inline-flex justify-center rounded-2xl bg-accent px-8 py-4 text-lg font-medium text-white shadow-sm transition-transform hover:-translate-y-1 hover:bg-orange-600">
              Join as a Volunteer
            </Link>
          </div>
        </div>
      </section>

      {/* 7. FAQ accordion */}
      <section className="py-24 bg-white">
        <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold font-display text-gray-900">Frequently Asked Questions</h2>
          </div>
          <div className="space-y-6">
            {[
              { q: "How are helpers verified?", a: "Every helper must complete a rigorous Aadhaar-based KYC process and a live selfie check before their account is approved. We do not compromise on identity verification." },
              { q: "What happens if I press the SOS button?", a: "The SOS button immediately sends your live location to your emergency contacts, alerts our 24/7 Trust & Safety team, and initiates a callback to your phone." },
              { q: "Can I use Needy for free?", a: "Yes, you can request help under the 'Social Service' category. These requests are routed to our community of volunteers." }
            ].map((faq, idx) => (
              <div key={idx} className="bg-background rounded-2xl p-6 border border-gray-100">
                <h3 className="text-lg font-bold text-gray-900 mb-2">{faq.q}</h3>
                <p className="text-gray-600">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
