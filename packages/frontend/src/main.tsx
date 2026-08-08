import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { MotionPreferencesProvider } from "./motion/preferences.js";
import { Playground } from "./playground/Playground.js";
import { ExperienceDemo } from "./experience/ExperienceDemo.js";
import { ExperienceErrorBoundary } from "./experience/ExperienceErrorBoundary.js";
import { AuthProvider, useAuth } from "./auth/AuthProvider.js";
import { LoginScreen } from "./auth/LoginScreen.js";
import { Dashboard } from "./app/Dashboard.js";
import { CreateTaskFlow } from "./app/CreateTaskFlow.js";
import { HelperApplicationForm } from "./app/HelperApplicationForm.js";
import { TaskHistory } from "./app/TaskHistory.js";
import { AdminPanel } from "./app/AdminPanel.js";
import "./styles.css";

const SUPPORT_PHONE = import.meta.env.VITE_SUPPORT_PHONE ?? "";

function AppRoutes() {
  const { user, status } = useAuth();

  if (status === "loading") {
    return <div style={{ padding: 40, textAlign: "center" }}>Loading...</div>;
  }

  if (status === "signed-out" || !user) {
    return <LoginScreen />;
  }

  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/create-task" element={<CreateTaskFlow />} />
      <Route path="/become-helper" element={<HelperApplicationForm />} />
      <Route path="/history" element={<TaskHistory />} />
      <Route path="/admin" element={<AdminPanel />} />
      <Route path="/experience" element={<ExperienceDemo />} />
      <Route path="/playground" element={<Playground />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionPreferencesProvider>
      <ExperienceErrorBoundary {...(SUPPORT_PHONE ? { supportPhone: SUPPORT_PHONE } : {})}>
        <AuthProvider>
          <HashRouter>
            <AppRoutes />
          </HashRouter>
        </AuthProvider>
      </ExperienceErrorBoundary>
    </MotionPreferencesProvider>
  </StrictMode>,
);
