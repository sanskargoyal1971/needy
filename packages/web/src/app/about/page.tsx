"use client";


export default function About() {
  return (
    <div className="bg-background py-16">
      <div className="container mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black text-gray-900 font-display mb-8 text-center">About Needy</h1>
        <div className="bg-white p-8 md:p-12 rounded-3xl shadow-sm border border-gray-100">
          <p className="text-xl text-gray-700 mb-6 font-medium">
            We built Needy because trust shouldn't be a luxury when you need help the most.
          </p>
          <div className="space-y-6 text-gray-600">
            <p>
              In our fast-paced world, finding reliable, trustworthy help for everyday tasks—whether it's accompanying an elderly parent to a doctor's appointment, fetching groceries, or simply needing a companion—has become increasingly difficult and stressful. 
            </p>
            <p>
              Generic gig-economy platforms often treat these sensitive tasks just like delivering a package. But when you are trusting someone with your loved ones or your home, the standard of care needs to be fundamentally higher.
            </p>
            <p>
              That's why Needy was created. We are a hyperlocal trust platform first, and a service marketplace second. Every single helper on our platform is rigorously verified through government ID checks and live video introductions. We've built in 24/7 SOS features, live tracking, and strict privacy controls.
            </p>
            <p className="font-bold text-gray-900 pt-4">
              Our mission is simple: to connect those in need with verified, compassionate helpers in their community, ensuring that everyone feels safe, respected, and supported.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
