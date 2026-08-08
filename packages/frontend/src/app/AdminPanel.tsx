import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider.js";
import { authClient } from "../auth/authClient.js";

export function AdminPanel() {
  const { user } = useAuth();
  const [stats, setStats] = useState<any>(null);
  const [applications, setApplications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user?.role !== "admin") return;
    
    Promise.all([
      authClient.getAdminStats(),
      authClient.getApplications()
    ])
    .then(([statsRes, appsRes]) => {
      setStats(statsRes);
      setApplications(appsRes.applications);
      setLoading(false);
    })
    .catch(err => {
      console.error(err);
      setLoading(false);
    });
  }, [user]);

  const handleReview = async (id: string, decision: "approved" | "rejected") => {
    try {
      await authClient.reviewApplication(id, decision);
      setApplications(prev => prev.filter(a => a.id !== id));
      
      // Update stats optimistically if approved
      if (decision === "approved") {
        setStats((prev: any) => ({ ...prev, helpers: prev.helpers + 1 }));
      }
    } catch (err) {
      alert("Failed to review application: " + (err as Error).message);
    }
  };

  if (!user || user.role !== "admin") {
    return <div className="p-10 text-center font-sans">Access Denied</div>;
  }

  if (loading) {
    return <div className="p-10 text-center text-gray-500 font-sans">Loading Admin Panel...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-6 min-h-[calc(100vh-16rem)] font-sans">
      <header className="flex justify-between items-center mb-10">
        <h1 className="text-3xl font-black text-gray-900 font-display">Admin Dashboard</h1>
        <button 
          onClick={() => {
            authClient.logout().then(() => window.location.reload());
          }}
          className="px-5 py-2 rounded-full border border-gray-200 text-gray-600 font-semibold hover:bg-gray-50 transition-colors text-sm"
        >
          Logout
        </button>
      </header>

      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          <StatCard label="Total Users" value={stats.users} />
          <StatCard label="Verified Helpers" value={stats.helpers} />
          <StatCard label="Total Tasks" value={stats.tasks} />
          <StatCard label="Platform Revenue" value={`₹${stats.revenue}`} />
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-900">Pending Applications</h2>
        <span className="bg-primary/10 text-primary font-semibold px-3 py-1 rounded-full text-sm">
          {applications.length} pending
        </span>
      </div>
      
      {applications.length === 0 ? (
        <div className="p-10 text-center bg-white rounded-3xl border border-gray-100 shadow-sm text-gray-500">
          No pending helper applications.
        </div>
      ) : (
        <div className="space-y-4">
          {applications.map(app => (
            <div key={app.id} className="p-6 bg-white rounded-3xl shadow-sm border border-gray-100">
              <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-4">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">{app.displayName}</h3>
                  <div className="mt-1 space-y-1">
                    <p className="text-sm text-gray-600"><span className="font-medium">Phone:</span> {app.phone}</p>
                    <p className="text-sm text-gray-600"><span className="font-medium">Aadhaar:</span> XXXX-XXXX-{app.aadhaarLast4}</p>
                    <p className="text-xs text-gray-400 mt-2">Applied: {new Date(app.createdAt).toLocaleString()}</p>
                  </div>
                </div>
                <div className="flex gap-2 w-full sm:w-auto">
                  <button 
                    onClick={() => handleReview(app.id, "approved")}
                    className="flex-1 sm:flex-none px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl transition-colors shadow-sm text-sm"
                  >
                    Approve
                  </button>
                  <button 
                    onClick={() => handleReview(app.id, "rejected")}
                    className="flex-1 sm:flex-none px-6 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-xl transition-colors shadow-sm text-sm"
                  >
                    Reject
                  </button>
                </div>
              </div>
              
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">Experience / Reason</p>
                <div className="p-4 bg-gray-50 rounded-xl text-sm text-gray-700 whitespace-pre-wrap border border-gray-100">
                  {app.experience}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-6 bg-white rounded-3xl border border-gray-100 shadow-sm">
      <p className="text-sm font-medium text-gray-500 mb-2">{label}</p>
      <p className="text-3xl font-black text-gray-900">{value}</p>
    </div>
  );
}
