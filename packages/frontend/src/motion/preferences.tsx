import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Reduced-motion is a genuine accessibility requirement here (§4) — elderly users are a
 * named audience. Every vocabulary component branches on this hook to a minimal, non-moving
 * fallback. We keep our OWN context (rather than only Framer's `useReducedMotion`) so the
 * playground can force the reduced state on to preview fallbacks, while the default still
 * tracks the real `prefers-reduced-motion` media query.
 */

type Override = "system" | "reduce" | "allow";

interface MotionPrefContext {
  reduced: boolean;
  override: Override;
  setOverride: (o: Override) => void;
}

const Ctx = createContext<MotionPrefContext>({
  reduced: false,
  override: "system",
  setOverride: () => {},
});

function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && "matchMedia" in window
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function MotionPreferencesProvider({
  children,
  defaultOverride = "system",
}: {
  children: ReactNode;
  defaultOverride?: Override;
}) {
  const [override, setOverride] = useState<Override>(defaultOverride);
  const system = useSystemReducedMotion();
  const reduced =
    override === "reduce" ? true : override === "allow" ? false : system;

  const value = useMemo(
    () => ({ reduced, override, setOverride }),
    [reduced, override],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** True when animation should collapse to its minimal, non-moving fallback. */
export function useReducedMotionPref(): boolean {
  return useContext(Ctx).reduced;
}

/** Full control surface, for the playground toolbar. */
export function useMotionPreferences(): MotionPrefContext {
  return useContext(Ctx);
}
