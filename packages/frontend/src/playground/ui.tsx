import type { CSSProperties, ReactNode } from "react";

/** Minimal, dependency-free controls so the playground stays focused on the motion, not on
 *  a component kit. Purely presentational. */

export function Stage({
  title,
  spec,
  blurb,
  controls,
  children,
}: {
  title: string;
  spec: string;
  blurb: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        background: "var(--needy-surface)",
        border: "1px solid var(--needy-border)",
        borderRadius: "var(--needy-radius)",
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        minWidth: 0,
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
          <span
            style={{
              fontSize: 11,
              color: "var(--needy-text-soft)",
              border: "1px solid var(--needy-border)",
              borderRadius: 999,
              padding: "1px 8px",
            }}
          >
            {spec}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "var(--needy-text-soft)", lineHeight: 1.5 }}>
          {blurb}
        </p>
      </header>
      <div
        style={{
          background: "var(--needy-surface-2)",
          borderRadius: 12,
          minHeight: 220,
          display: "grid",
          placeItems: "center",
          padding: 20,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
      {controls && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          {controls}
        </div>
      )}
    </section>
  );
}

export function Button({
  onClick,
  children,
  tone = "default",
  style,
}: {
  onClick?: () => void;
  children: ReactNode;
  tone?: "default" | "warm" | "alarm";
  style?: CSSProperties;
}) {
  const bg =
    tone === "warm" ? "var(--needy-warm)" : tone === "alarm" ? "var(--needy-alarm)" : "transparent";
  const fg = tone === "default" ? "var(--needy-text)" : "#fff";
  return (
    <button
      onClick={onClick}
      style={{
        appearance: "none",
        border: "1px solid var(--needy-border)",
        background: bg,
        color: fg,
        borderRadius: 10,
        padding: "8px 14px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      <span style={{ color: "var(--needy-text-soft)" }}>
        {label}: {value}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ accentColor: "var(--needy-warm)" }}
      />
    </label>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
