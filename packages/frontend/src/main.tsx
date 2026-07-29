import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionPreferencesProvider } from "./motion/preferences.js";
import { Playground } from "./playground/Playground.js";
import { ExperienceDemo } from "./experience/ExperienceDemo.js";
import "./styles.css";

/** Minimal hash routing — enough to switch between the Phase 2 vocabulary playground and the
 *  Phase 3 wired task experience without pulling in a router dependency. */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/experience");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/experience");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function App() {
  const route = useHashRoute();
  const isPlayground = route.startsWith("#/playground");
  return (
    <div>
      <nav
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "center",
          padding: "12px 0",
          borderBottom: "1px solid var(--needy-border)",
        }}
      >
        <NavLink href="#/experience" active={!isPlayground}>Task experience</NavLink>
        <NavLink href="#/playground" active={isPlayground}>Motion vocabulary</NavLink>
      </nav>
      {isPlayground ? <Playground /> : <ExperienceDemo />}
    </div>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <a
      href={href}
      style={{
        textDecoration: "none",
        fontSize: 13,
        fontWeight: 600,
        padding: "6px 14px",
        borderRadius: 999,
        color: active ? "#fff" : "var(--needy-text)",
        background: active ? "var(--needy-warm)" : "transparent",
        border: "1px solid var(--needy-border)",
      }}
    >
      {children}
    </a>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionPreferencesProvider>
      <App />
    </MotionPreferencesProvider>
  </StrictMode>,
);
