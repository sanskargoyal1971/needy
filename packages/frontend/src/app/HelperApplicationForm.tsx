import { useState } from "react";
import { useAuth } from "../auth/AuthProvider.js";
import { authClient } from "../auth/authClient.js";

export function HelperApplicationForm() {
  const { user, refreshUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Basic form state
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [aadhaarLast4, setAadhaarLast4] = useState("");
  const [experience, setExperience] = useState("");

  if (!user) return null;

  if (user.kycStatus === "pending") {
    return (
      <div className="max-w-lg mx-auto mt-10 p-8 bg-white rounded-3xl shadow-sm border border-gray-100 text-center">
        <div className="text-5xl mb-6">⏳</div>
        <h1 className="text-2xl font-display font-black text-gray-900 mb-2">Application Pending</h1>
        <p className="text-gray-500 mb-8">
          Your application is currently being reviewed by our trust & safety team. We'll let you know once you're approved.
        </p>
        <a href="#/" className="inline-block px-6 py-3 bg-gray-50 hover:bg-gray-100 text-gray-900 font-semibold rounded-xl transition-colors">
          Return to Dashboard
        </a>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (aadhaarLast4.length !== 4 || !/^\d{4}$/.test(aadhaarLast4)) {
      setError("Please enter exactly 4 digits for Aadhaar.");
      return;
    }
    
    setLoading(true);
    setError(null);
    try {
      await authClient.applyAsHelper({
        displayName,
        phone: user.phone,
        aadhaarLast4,
        experience
      });
      await refreshUser(); // to pick up the kycStatus change
      window.location.hash = "#/";
    } catch (err: any) {
      setError(err.message || "Failed to submit application");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto mt-10 p-8 bg-white rounded-3xl shadow-sm border border-gray-100 font-sans">
      <h1 className="text-2xl font-display font-black text-gray-900 mb-2">Become a Helper</h1>
      <p className="text-gray-500 mb-8">
        Join our community and earn money by helping people nearby. For your safety and theirs, all helpers must be verified.
      </p>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-xl mb-6 text-sm font-medium border border-red-100">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block mb-1.5 text-sm font-semibold text-gray-900">Full Name</label>
          <input 
            type="text" 
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            required
            className="w-full rounded-xl border-0 py-3 px-4 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm sm:leading-6" 
          />
        </div>
        
        <div>
          <label className="block mb-1.5 text-sm font-semibold text-gray-900">Phone Number</label>
          <input 
            type="text" 
            value={user.phone}
            disabled
            className="w-full rounded-xl border-0 py-3 px-4 text-gray-500 bg-gray-50 ring-1 ring-inset ring-gray-200 sm:text-sm sm:leading-6 cursor-not-allowed" 
          />
          <p className="mt-1.5 text-xs text-gray-500">Linked to your verified account</p>
        </div>

        <div>
          <label className="block mb-1.5 text-sm font-semibold text-gray-900">Aadhaar (Last 4 Digits)</label>
          <input 
            type="text" 
            value={aadhaarLast4}
            onChange={e => setAadhaarLast4(e.target.value)}
            maxLength={4}
            pattern="\d{4}"
            required
            placeholder="e.g. 1234"
            className="w-full rounded-xl border-0 py-3 px-4 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm sm:leading-6" 
          />
          <p className="mt-1.5 text-xs text-gray-500">We use this to verify your identity. We never store your full Aadhaar.</p>
        </div>

        <div>
          <label className="block mb-1.5 text-sm font-semibold text-gray-900">Why do you want to help?</label>
          <textarea 
            value={experience}
            onChange={e => setExperience(e.target.value)}
            required
            rows={4}
            placeholder="Tell us a bit about yourself and why you'd be a good fit..."
            className="w-full rounded-xl border-0 py-3 px-4 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm sm:leading-6 resize-y" 
          />
        </div>

        <button 
          type="submit" 
          disabled={loading}
          className="mt-4 w-full flex justify-center rounded-xl bg-primary px-4 py-3.5 text-sm font-semibold text-white shadow-sm hover:bg-primary-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
        >
          {loading ? "Submitting..." : "Submit Application"}
        </button>
        
        <div className="text-center pt-2">
          <a href="#/" className="text-sm font-semibold text-gray-500 hover:text-gray-900 transition-colors">
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}
