import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useAuth } from "./AuthProvider.js";

export function LoginScreen() {
  const { requestCode, signIn } = useAuth();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"phone" | "code">("phone");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.length < 10) {
      setError("Please enter a valid phone number");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await requestCode(phone);
      setStage("code");
    } catch (err: any) {
      setError(err.message || "Failed to request code");
    } finally {
      setLoading(false);
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) {
      setError("Please enter the 6-digit code");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await signIn(phone, code);
    } catch (err: any) {
      setError(err.message || "Invalid code");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-16rem)] items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-background font-sans">
      <div className="w-full max-w-md space-y-8 bg-white p-8 sm:p-10 rounded-[32px] shadow-sm border border-gray-100">
        <div>
          <h2 className="mt-2 text-center text-3xl font-black tracking-tight text-gray-900 font-display">
            {stage === "phone" ? "Welcome back" : "Enter Code"}
          </h2>
          <p className="mt-3 text-center text-sm text-gray-500">
            {stage === "phone" 
              ? "Sign in to your Needy account"
              : `We sent a 6-digit code to ${phone}`
            }
          </p>
        </div>

        {error && (
          <div className="p-4 bg-red-50 text-red-700 rounded-xl text-sm font-medium border border-red-100 text-center">
            {error}
          </div>
        )}
        
        {stage === "phone" ? (
          <form className="mt-8 space-y-6" onSubmit={handlePhoneSubmit}>
            <div className="rounded-xl shadow-sm space-y-4">
              <div>
                <label htmlFor="phone-number" className="sr-only">Phone Number</label>
                <input
                  id="phone-number"
                  name="phone"
                  type="tel"
                  required
                  className="relative block w-full rounded-xl border-0 py-3.5 px-4 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm sm:leading-6 transition-all"
                  placeholder="Mobile Number (e.g. +91...)"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="group relative flex w-full justify-center rounded-xl bg-primary px-3 py-3.5 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors shadow-sm disabled:opacity-70"
              >
                {loading ? "Sending..." : "Get OTP"}
              </button>
            </div>
            
            <div className="flex items-center justify-center gap-2 text-xs text-gray-500 mt-6 font-medium">
              <ShieldCheck size={16} className="text-primary" />
              <span>Secure, passwordless login</span>
            </div>
          </form>
        ) : (
          <form className="mt-8 space-y-6" onSubmit={handleCodeSubmit}>
            <div className="rounded-xl shadow-sm space-y-4">
              <div>
                <label htmlFor="code" className="sr-only">Verification Code</label>
                <input
                  id="code"
                  name="code"
                  type="text"
                  required
                  maxLength={6}
                  className="relative block w-full rounded-xl border-0 py-3.5 px-4 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-lg tracking-widest text-center transition-all"
                  placeholder="0 0 0 0 0 0"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <button
                type="submit"
                disabled={loading}
                className="group relative flex w-full justify-center rounded-xl bg-primary px-3 py-3.5 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors shadow-sm disabled:opacity-70"
              >
                {loading ? "Verifying..." : "Sign In"}
              </button>
              
              <button
                type="button"
                onClick={() => setStage("phone")}
                className="text-sm font-semibold text-gray-500 hover:text-gray-900 transition-colors"
              >
                Use a different number
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
