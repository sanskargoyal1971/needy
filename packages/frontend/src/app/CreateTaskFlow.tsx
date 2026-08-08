import { useState } from "react";
import { API_BASE } from "../apiConfig.js";

const CATEGORY_PRICING = {
  errand: 149,
  companionship: 199,
  "social-service": 0,
  urgent: 299,
};

const CATEGORY_LABELS = {
  errand: "Run an Errand",
  companionship: "Companionship",
  "social-service": "Social Service (Volunteer)",
  urgent: "Urgent Assistance",
};

export function CreateTaskFlow() {
  const [category, setCategory] = useState<keyof typeof CATEGORY_PRICING | null>(null);
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!category || !description.trim()) return;
    
    setLoading(true);
    try {
      // Hardcode origin for demo purposes to avoid geolocation prompts in testing
      const origin = { lat: 28.6139, lng: 77.2090 };
      
      const res = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          title: CATEGORY_LABELS[category],
          description,
          category,
          origin
        })
      });
      
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      
      // Navigate to experience view with the new task ID
      window.location.hash = `#/experience?taskId=${data.id}`;
    } catch (err) {
      alert("Failed to create task");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 min-h-[calc(100vh-16rem)] font-sans">
      <header className="flex items-center gap-4 mb-8">
        <a href="#/" className="text-gray-400 hover:text-gray-900 transition-colors text-2xl font-light">←</a>
        <h1 className="text-2xl font-display font-black text-gray-900 m-0">Request Help</h1>
      </header>

      <form onSubmit={handleSubmit} className="space-y-8 bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
        <div>
          <label className="block mb-4 text-base font-bold text-gray-900">1. What kind of help do you need?</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(Object.keys(CATEGORY_PRICING) as Array<keyof typeof CATEGORY_PRICING>).map(cat => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`p-4 rounded-2xl text-left flex flex-col gap-1 transition-all border-2 ${
                  category === cat 
                    ? "border-primary bg-primary/5 ring-4 ring-primary/10" 
                    : "border-gray-100 bg-white hover:border-gray-300"
                }`}
              >
                <span className="font-semibold text-gray-900 text-sm">{CATEGORY_LABELS[cat]}</span>
                <span className="text-primary font-black">₹{CATEGORY_PRICING[cat]}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block mb-3 text-base font-bold text-gray-900">2. Add details</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            required
            rows={4}
            placeholder="Please describe exactly what you need help with..."
            className="w-full rounded-2xl border-0 py-4 px-5 text-gray-900 ring-1 ring-inset ring-gray-200 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-base resize-y transition-all"
          />
        </div>

        <div className="p-5 bg-gray-50 rounded-2xl border border-gray-100">
          <div className="flex justify-between items-center mb-3">
            <span className="text-gray-500 text-sm font-medium">Service Area</span>
            <span className="font-semibold text-gray-900 text-sm">New Delhi (Mock)</span>
          </div>
          <div className="flex justify-between items-center border-t border-gray-200 pt-3">
            <span className="text-lg font-bold text-gray-900">Total Price</span>
            <span className="text-2xl font-black text-primary">₹{category ? CATEGORY_PRICING[category] : "0"}</span>
          </div>
        </div>

        <button
          type="submit"
          disabled={!category || !description.trim() || loading}
          className="w-full flex justify-center rounded-2xl bg-primary px-6 py-4 text-lg font-bold text-white shadow-md hover:bg-primary-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-primary"
        >
          {loading ? "Finding Helpers..." : "Request Help Now"}
        </button>
      </form>
    </div>
  );
}
