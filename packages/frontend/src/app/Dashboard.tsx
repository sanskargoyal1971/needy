import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider.js";
import { authClient } from "../auth/authClient.js";
import { RequesterApp } from "./RequesterApp.js";
import { HelperApp } from "./HelperApp.js";
import { AdminPanel } from "./AdminPanel.js";

export function Dashboard() {
  const { user } = useAuth();
  const [mode, setMode] = useState<"requester" | "helper">("requester");
  const [earnings, setEarnings] = useState<number | null>(null);

  useEffect(() => {
    if (user?.role === "helper" || user?.role === "both") {
      authClient.getEarnings().then(res => setEarnings(res.earnings)).catch(console.error);
    }
  }, [user]);

  if (!user) return null;

  if (user.role === "admin") {
    return <AdminPanel />;
  }

  const showModeToggle = user.role === "both";
  const activeMode = showModeToggle ? mode : user.role === "helper" ? "helper" : "requester";

  return (
    <div className="max-w-2xl mx-auto p-6 min-h-[calc(100vh-16rem)] font-sans">
      <header className="mb-8">
        <h1 className="text-3xl font-black text-gray-900 font-display">
          Welcome back, {user.displayName}
        </h1>
        {earnings !== null && activeMode === "helper" && (
          <p className="mt-2 text-primary font-semibold">
            Total Earnings: ₹{earnings}
          </p>
        )}
      </header>

      {showModeToggle && (
        <div className="flex bg-white/50 backdrop-blur-sm rounded-full p-1 mb-8 shadow-sm border border-gray-100">
          <button
            onClick={() => setMode("requester")}
            className={`flex-1 py-3 px-6 rounded-full font-semibold transition-all duration-200 ${
              activeMode === "requester"
                ? "bg-white text-primary shadow-sm ring-1 ring-gray-200/50"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            I need help
          </button>
          <button
            onClick={() => setMode("helper")}
            className={`flex-1 py-3 px-6 rounded-full font-semibold transition-all duration-200 ${
              activeMode === "helper"
                ? "bg-white text-primary shadow-sm ring-1 ring-gray-200/50"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            I want to help
          </button>
        </div>
      )}

      {activeMode === "requester" && (
        <div className="space-y-6">
          <RequesterApp />
          
          <a 
            href="#/history" 
            className="block p-6 bg-white rounded-2xl shadow-sm border border-gray-100 hover:border-primary/20 hover:shadow-md transition-all group"
          >
            <h3 className="text-lg font-semibold text-gray-900 group-hover:text-primary">Past Tasks</h3>
            <p className="mt-1 text-sm text-gray-500">
              View your task history and receipts
            </p>
          </a>
          
          {user.role === "requester" && user.kycStatus === "unverified" && (
            <a 
              href="#/become-helper" 
              className="block p-6 bg-primary rounded-2xl shadow-sm text-center hover:bg-primary-dark transition-colors"
            >
              <h3 className="text-lg font-semibold text-white">Become a Helper</h3>
              <p className="mt-1 text-sm text-white/80">
                Earn money by helping others in your community
              </p>
            </a>
          )}
          
          {user.kycStatus === "pending" && (
            <div className="p-6 bg-yellow-50 rounded-2xl border border-yellow-100">
              <strong className="text-yellow-800 font-semibold">Helper Application Pending</strong>
              <p className="mt-1 text-sm text-yellow-700">We are reviewing your application to ensure community safety.</p>
            </div>
          )}
        </div>
      )}

      {activeMode === "helper" && (
        <div className="space-y-6">
          <HelperApp />
          
          <a 
            href="#/history" 
            className="block p-6 bg-white rounded-2xl shadow-sm border border-gray-100 hover:border-primary/20 hover:shadow-md transition-all group"
          >
            <h3 className="text-lg font-semibold text-gray-900 group-hover:text-primary">Earnings & History</h3>
            <p className="mt-1 text-sm text-gray-500">
              View your past tasks and completed payouts
            </p>
          </a>
        </div>
      )}
    </div>
  );
}
