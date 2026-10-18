# Needy

A realtime help-matching platform. The guiding constraint runs through every layer:

> Every piece of realtime feedback must read as evidence of a real, present human —
> never as a system state.

Data quality is what makes that possible, so the realtime plumbing is built and
tested **first**, with plain UI, before any animation is wired on top.

## Monorepo layout

```
packages/
  shared/     Types + socket event contracts. The single source of truth both
              backend and frontend import so event names/payloads never drift.
  backend/    Node + Socket.io + Redis realtime engine.
  frontend/   React + Framer Motion client: motion vocabulary + wired task lifecycle.
```

## Build phases (following the companion spec's own order)

| Phase | Scope                                                                   | Spec     | Status                               |
| ----- | ----------------------------------------------------------------------- | -------- | ------------------------------------ |
| **0** | Monorepo scaffold, frozen event contracts, infra compose                | —        | ✅                                   |
| **1** | Realtime backend: presence, tracking, matching, chat — **no animation** | §2       | ✅ typecheck + 3 tests               |
| **2** | Motion vocabulary library in isolation + playground                     | §4, §5.2 | ✅ typecheck + build                 |
| **3** | Wire Stage 1–7 animations to real socket events                         | §3, §5.3 | ✅ typecheck + build + runtime smoke |

## Frontend (Phases 2–3)

Vite + React + Framer Motion, two routes:

- `#/playground` — the **motion vocabulary** (§4): six primitives (`BreathingPulse`,
  `RadarSweep`, `SoftScaleReveal`, `InterpolatedMarker`, `TypingDots`, `ArrivalHighlight`)
  driven entirely by tokens in `src/motion/motion.config.ts`, each with a reduced-motion
  fallback. Tune here in isolation before wiring to data.
- `#/experience` — the **wired task lifecycle** (§3). A `NeedyDriver` interface has two
  implementations: `RealNeedyClient` (Socket.io Manager across all four namespaces, with the
  reconnect → `/snapshot` resync of §2.1) and a scripted `MockNeedyClient` that walks all
  seven stages so the flow is reviewable without a backend. `TaskExperience` switches stages
  purely on the server-authoritative `task.state`. "Connect to live backend" swaps the mock
  for the real client against a running server.

### Live tracking map (Stage 4)

`LiveMap` (and the request form's `OriginPicker`) render Google Maps. Set
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` in `packages/web/.env.local` (optionally
`NEXT_PUBLIC_GOOGLE_MAP_ID`; it defaults to Google's `DEMO_MAP_ID`); without a key each map says
it can't be shown. The §2.3 glide is preserved
by interpolating the helper in **geographic** space (Framer motion values tween lat/lng between
GPS points) and re-positioning the advanced marker each frame, so the human silhouette glides
continuously and stays glued to the map through pan/zoom — never teleporting per coordinate.

### Task lifecycle transitions

Stage 3–7 transitions after match are driven by the `advance-task` matching action, guarded
server-side by the shared `TASK_TRANSITIONS` state machine (`packages/shared/src/task.ts`) plus
participant auth. Every accepted transition broadcasts `task-updated` to both parties, so all
clients stay server-authoritative. `searching → matched` is intentionally excluded — that edge
belongs solely to the matching accept flow under its distributed lock. In the demo, the
"simulate helper" bar drives these (most are the helper's actions in a real deployment).

## Backend architecture (Phase 1)

Socket.io uses **namespace-per-concern** (`/presence`, `/tracking`, `/chat`,
`/matching`) so reconnect and auth scoping stay clean. The handshake authenticates
with the same short-lived JWT as REST.

- **Presence** (`/presence`) — not a boolean: `{state, activity, lastActiveAt}`.
  Flips to `away` only after 2 missed heartbeats (dead-zone flicker guard), and
  broadcasts changes **only** to a helper's subscribers, never globally.
- **Tracking** (`/tracking`) — helper posts location every 3–5s; server stores only
  the _current_ point in Redis (TTL'd, no trail) and recomputes real-road ETA. Smooth
  marker interpolation is the client's job.
- **Matching** (`/matching`) — Redis `GEOSEARCH` over online-available helpers, offers
  broadcast to all eligible helpers **simultaneously** with an accept window;
  first-accept-wins is guarded by a Redis distributed lock (the double-accept race is
  explicitly tested).
- **Chat** (`/chat`) — typing indicators, sent→delivered→read receipts, server-side
  token-bucket rate limiting.

**Reconnect is a first-class feature.** After any drop the client re-syncs from
`GET /snapshot` (a `SessionSnapshot`) before trusting new socket events.

### Dependency shape

Every namespace module is a `NamespaceRegistrar` `(deps: Deps) => void`. Modules depend
only on the `Deps` container (io, redis, logger, config, repositories, injectable clock)
and shared `domain/` accessors + `services/` — never on each other. Durable data sits
behind repository interfaces with two implementations: in-memory (dev / tests) and
**Postgres** (`src/db.ts` schema + `src/domain/pgStores.ts`). `index.ts` selects Postgres
when `DATABASE_URL` is set — running migrations and seeding on boot — otherwise falls back to
in-memory. Neither the socket nor HTTP layers know which is active. The Postgres SQL is
exercised for real in tests via `pg-mem`.

## Running locally

```bash
npm install
npm run infra:up          # Redis + Postgres via docker compose
cp packages/backend/.env.example packages/backend/.env
npm run dev               # builds shared, then backend + frontend
```

Get a dev token to exercise the API before a real auth system exists:

```bash
curl -XPOST localhost:4000/dev/token \
  -H 'content-type: application/json' \
  -d '{"userId":"u1","role":"requester","displayName":"Asha"}'
```
