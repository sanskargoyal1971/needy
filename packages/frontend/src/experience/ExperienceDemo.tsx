import { useMemo, useState } from "react";
import { advanceableNextStates } from "@needy/shared";
import {
  MockNeedyClient,
  RealNeedyClient,
  RealtimeProvider,
  useDriver,
  useTaskExperience,
  type NeedyDriver,
} from "../realtime/index.js";
import { TaskExperience } from "./TaskExperience.js";

/**
 * Phase 3 harness. By default it drives the full Stage 1–7 lifecycle with the scripted
 * {@link MockNeedyClient}, so every wired animation can be reviewed here without a backend
 * (mirroring how Phase 2 was tuned in isolation). "Connect to live backend" swaps in the real
 * {@link RealNeedyClient} against a running server — same UI, real socket events.
 */
export function ExperienceDemo() {
  const [driver, setDriver] = useState<NeedyDriver>(() => new MockNeedyClient());
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);

  const controls = useMemo(
    () => ({
      requestHelp() {
        driver.start("mock-task");
        driver.requestHelp();
      },
      restartMock() {
        setLive(false);
        setDriver(new MockNeedyClient());
      },
      complete() {
        if (driver instanceof MockNeedyClient) driver.complete();
      },
    }),
    [driver],
  );

  async function goLive(baseUrl: string) {
    setBusy(true);
    try {
      const userId = `req-${Math.random().toString(36).slice(2, 8)}`;
      const tokRes = await fetch(`${baseUrl}/dev/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, role: "requester", displayName: "You" }),
      });
      if (!tokRes.ok) throw new Error(`dev/token ${tokRes.status}`);
      const { token } = (await tokRes.json()) as { token: string };

      const taskRes = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          category: "errand",
          origin: { lat: 12.9716, lng: 77.5946 },
          title: "Pick up medicine",
        }),
      });
      if (!taskRes.ok) throw new Error(`tasks ${taskRes.status}`);
      const task = (await taskRes.json()) as { id: string };

      const client = new RealNeedyClient({ baseUrl, token, userId });
      client.start(task.id);
      client.requestHelp();
      setDriver(client);
      setLive(true);
    } catch (err) {
      alert(`Could not connect to backend: ${String(err)}\n\nIs it running? npm run infra:up && npm run dev:backend`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
          justifyContent: "center",
          padding: "12px 16px",
        }}
      >
        {!live && (
          <>
            <Btn tone="warm" onClick={controls.requestHelp}>Request help</Btn>
            <Btn onClick={controls.restartMock}>Restart</Btn>
            <Btn onClick={controls.complete}>Skip to thank-you</Btn>
          </>
        )}
        <LiveConnect busy={busy} live={live} onConnect={goLive} onExit={controls.restartMock} />
      </div>

      <RealtimeProvider driver={driver}>
        <AdvanceBar />
        <TaskExperience />
      </RealtimeProvider>

      <p style={{ textAlign: "center", fontSize: 12, color: "var(--needy-text-soft)", marginTop: 8 }}>
        {live
          ? "Live: real socket events. Drop your connection to watch the reconnect + snapshot resync."
          : "Scripted walkthrough of all seven stages. Same components, same event shapes as the live client."}
      </p>
    </div>
  );
}

/** Drives lifecycle transitions via the server-validated `advance-task` action. In a real
 *  deployment most of these are the helper's actions; here it stands in for the helper so a
 *  single requester client can walk Stages 3–7 live. Offers only legal next states. */
function AdvanceBar() {
  const { task } = useTaskExperience();
  const driver = useDriver();
  if (!task || task.state === "searching") return null;
  const next = advanceableNextStates(task.state).filter((s) => s !== "cancelled");
  if (next.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        justifyContent: "center",
        flexWrap: "wrap",
        margin: "0 auto 4px",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--needy-text-soft)", alignSelf: "center" }}>simulate helper →</span>
      {next.map((s) => (
        <button
          key={s}
          onClick={() => driver.advanceTo(s)}
          style={{
            border: "1px solid var(--needy-border)",
            background: "var(--needy-surface)",
            color: "var(--needy-text)",
            borderRadius: 999,
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function LiveConnect({
  busy,
  live,
  onConnect,
  onExit,
}: {
  busy: boolean;
  live: boolean;
  onConnect: (baseUrl: string) => void;
  onExit: () => void;
}) {
  const [url, setUrl] = useState("http://localhost:4000");
  if (live) return <Btn onClick={onExit}>Back to demo</Btn>;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid var(--needy-border)",
          background: "var(--needy-surface)",
          color: "var(--needy-text)",
          fontSize: 12,
          width: 180,
        }}
      />
      <Btn onClick={() => onConnect(url)}>{busy ? "Connecting…" : "Connect to live backend"}</Btn>
    </span>
  );
}

function Btn({
  children,
  onClick,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: "default" | "warm";
}) {
  return (
    <button
      onClick={onClick}
      style={{
        border: "1px solid var(--needy-border)",
        background: tone === "warm" ? "var(--needy-warm)" : "transparent",
        color: tone === "warm" ? "#fff" : "var(--needy-text)",
        borderRadius: 10,
        padding: "8px 14px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
