# Needy — Project Rules

Standing rules for every Antigravity task in this project. Full context and build phases live in `needy-antigravity-build-prompt.md`.

## Identity
"Needy" is a hyperlocal trust & safety platform, not a generic gig app. Every decision — code or copy — should pass: "Would I let my elderly parent use this alone, and would I trust a stranger through it?"

## Security — never skip these for speed
- OTP auth only, rate-limited with exponential backoff.
- Sessions: short-lived JWT + rotating refresh token in httpOnly/Secure/SameSite=Strict cookies. Never localStorage.
- RBAC enforced at every API route (Requester/Helper/Admin/Ops) — being logged in is not a role check.
- Aadhaar numbers: never store plaintext, never log. Masked reference + provider verification status only.
- All PII encrypted at rest (AES-256) and in transit (TLS 1.2+, HSTS).
- KYC docs/selfies: private S3 only, signed time-limited URLs, never a public bucket.
- Server-side validation on every endpoint (Zod). Parameterized queries / Prisma only. CSP + CSRF + secure headers. Redis-backed rate limiting on task creation, chat, and SOS.
- Immutable, append-only audit log for every SOS trigger, KYC review action, and admin override.
- Secrets via AWS Secrets Manager / SSM only — never committed, never in a tracked `.env`.
- Location sharing scoped strictly to active-task duration; auto-revoke on completion or cancellation.

## Never fabricate
Never simulate a real response from a KYC, payment, or video-call provider. Sandbox/mock mode only, and call out every stub explicitly in the Walkthrough artifact — don't let a mocked flow look finished.

## Design tokens — reuse, don't reinvent per screen
- Palette: trust-teal `#0F5C5C`–`#1B7A7A` anchor, coral/amber `#FF7A59` accent, cream `#FAF7F2` background.
- Type: humanist sans (Inter / General Sans) for UI; warm serif or rounded display for emotional headlines.
- 16–24px corner radius, soft layered shadows, generous whitespace.
- Motion lives in shared components only: `BreathingBackground`, `PulseIndicator`, `RippleMarker`, `SOSGlow`. 8–12s ease-in-out breathing loops, spring micro-interactions, shimmering skeletons (never a blank white flash).
- Banned: countdown-urgency dark patterns, neon/glitch effects, anything that could read as a scam page.

## Definition of done — apply to every task
- Real seeded mock data, not empty states, unless the empty state is specifically what's being demoed.
- Every button/CTA routes somewhere real. No dead links, no 404s.
- Verify with the browser subagent: drive the actual flow, capture a screenshot or recording, attach it to the Walkthrough before marking anything done.
- Anything mocked or stubbed is called out explicitly — never allowed to look finished if it isn't.

## Working style
- One phase = one task/dispatch. Don't bundle multiple build phases into a single conversation.
- Produce the Task List and Implementation Plan first, and wait for review before writing code that touches auth, KYC, SOS, or payments.
