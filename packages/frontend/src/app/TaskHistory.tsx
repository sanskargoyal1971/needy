import { useEffect, useState } from "react";
import { authClient } from "../auth/authClient.js";

export function TaskHistory() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authClient.getTaskHistory()
      .then(res => {
        setTasks(res.tasks);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  return (
    <div className="max-w-2xl mx-auto p-6 min-h-[calc(100vh-16rem)] font-sans">
      <header className="flex items-center gap-4 mb-8">
        <a href="#/" className="text-gray-400 hover:text-gray-900 transition-colors text-2xl font-light">←</a>
        <h1 className="text-2xl font-display font-black text-gray-900 m-0">Task History</h1>
      </header>

      {loading ? (
        <div className="text-center p-10 text-gray-500">Loading history...</div>
      ) : tasks.length === 0 ? (
        <div className="text-center p-12 bg-white rounded-3xl border border-gray-100 text-gray-500 shadow-sm">
          No past tasks found.
        </div>
      ) : (
        <div className="space-y-4">
          {tasks.map(task => (
            <div key={task.id} className="p-5 bg-white rounded-2xl border border-gray-100 shadow-sm flex justify-between items-center hover:border-gray-200 transition-colors">
              <div>
                <h3 className="text-base font-bold text-gray-900 mb-1">{task.title}</h3>
                <p className="text-sm text-gray-500 mb-3">
                  {new Date(task.createdAt).toLocaleDateString()} • {task.category}
                </p>
                <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wide
                  ${task.state === 'completed' 
                    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20' 
                    : task.state === 'cancelled' 
                      ? 'bg-gray-100 text-gray-600 ring-1 ring-inset ring-gray-500/20'
                      : 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/20'
                  }`}
                >
                  {task.state}
                </span>
              </div>
              <div className="text-xl font-black text-gray-900">
                ₹{task.price}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
