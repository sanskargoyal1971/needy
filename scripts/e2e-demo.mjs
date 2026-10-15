/**
 * ── End-to-end walk of a running Needy stack ───────────────────────────────
 *
 *  Drives the real API and sockets the way the web app does, as three people at once: a
 *  requester, a helper and an admin. Every step prints PASS/FAIL with the server's answer.
 *  Creates throwaway accounts on made-up numbers (+91 90002xxxxx); nothing is mocked.
 *
 *      NEEDY_WEB=https://<host> NEEDY_API=https://api.<host> NEEDY_OTP=123456 \
 *      NEEDY_ADMIN_PHONE=... NEEDY_ADMIN_PASSWORD=... node scripts/e2e-demo.mjs
 *
 *  Sandbox stacks only: it relies on the fixed sign-in code.
 */
import fs from "node:fs";
import { io } from "socket.io-client";

const WEB = process.env.NEEDY_WEB;
const API = process.env.NEEDY_API;
const OTP = process.env.NEEDY_OTP ?? "123456";
const ADMIN_PHONE = process.env.NEEDY_ADMIN_PHONE;
const ADMIN_PASSWORD = process.env.NEEDY_ADMIN_PASSWORD;
if (!WEB || !API) throw new Error("set NEEDY_WEB and NEEDY_API");

const results = [];
const short = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "" : s.length > 220 ? s.slice(0, 220) + "…" : s;
};
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  — " + short(detail)}`,
  );
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── an HTTP client with a cookie jar and the CSRF header, like the browser ──
class Person {
  constructor(label) {
    this.label = label;
    this.jar = {};
    this.sockets = {};
    this.events = [];
  }
  cookieHeader() {
    return Object.entries(this.jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  keep(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const v = kv.slice(i + 1);
      if (v === "" || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))
        delete this.jar[kv.slice(0, i)];
      else this.jar[kv.slice(0, i)] = v;
    }
  }
  async req(method, path, body, { form } = {}) {
    const headers = { origin: WEB, cookie: this.cookieHeader() };
    if (this.jar.needy_csrf) headers["x-csrf-token"] = decodeURIComponent(this.jar.needy_csrf);
    if (body !== undefined && !form) headers["content-type"] = "application/json";
    const res = await fetch(API + path, {
      method,
      headers,
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    this.keep(res);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  socket(ns) {
    if (this.sockets[ns]) return this.sockets[ns];
    const s = io(API + ns, {
      transports: ["websocket"],
      extraHeaders: { cookie: this.cookieHeader(), origin: WEB },
      forceNew: true,
      reconnection: false,
    });
    s.onAny((event, payload) => this.events.push({ ns, event, payload, at: Date.now() }));
    this.sockets[ns] = s;
    return s;
  }
  async connect(ns) {
    const s = this.socket(ns);
    if (s.connected) return s;
    await new Promise((resolve, reject) => {
      s.once("connect", resolve);
      s.once("connect_error", reject);
      setTimeout(() => reject(new Error(`connect ${ns} timed out`)), 10_000);
    });
    return s;
  }
  emit(ns, event, payload, timeout = 10_000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ timeout: true }), timeout);
      this.socket(ns).emit(event, payload, (ack) => {
        clearTimeout(t);
        resolve(ack);
      });
    });
  }
  async waitFor(ns, event, pred = () => true, timeout = 15_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const hit = this.events.find((e) => e.ns === ns && e.event === event && pred(e.payload));
      if (hit) return hit.payload;
      await sleep(200);
    }
    return null;
  }
  close() {
    for (const s of Object.values(this.sockets)) s.close();
  }
}

// ── tiny valid files: the server checks magic bytes, not names ──
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048)]);
const upload = (p, kind, bytes, type, name) => {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", new Blob([bytes], { type }), name);
  return p.req("POST", "/onboarding/documents", undefined, { form: fd });
};

const stamp = String(Date.now()).slice(-5);
const ORIGIN = { lat: 17.4486, lng: 78.3908 };

async function signUp(p, phone, name) {
  p.phone = phone;
  let r = await p.req("POST", "/auth/otp/request", { phone });
  record(`${p.label}: request sign-in code`, r.status === 200, r.status);
  r = await p.req("POST", "/auth/otp/verify", { phone, code: OTP });
  record(
    `${p.label}: sign in with code`,
    r.status === 200 && !!r.body.user,
    r.body.user?.onboardingStatus ?? r.body,
  );
  if (!p.jar.needy_csrf) await p.req("GET", "/auth/csrf");
  r = await p.req("GET", "/auth/me");
  record(`${p.label}: /auth/me`, r.status === 200, r.body.user?.role ?? r.body);
  p.id = r.body.user?.id ?? r.body.id;
  r = await p.req("POST", "/onboarding/identity", {
    displayName: name,
    dateOfBirth: "1990-04-12",
    gender: "other",
    areaLabel: "Madhapur, Hyderabad",
    areaLat: ORIGIN.lat,
    areaLng: ORIGIN.lng,
  });
  record(
    `${p.label}: onboarding — about you`,
    r.status === 200,
    r.status === 200 ? undefined : r.body,
  );
  r = await upload(p, "gov_id", PNG, "image/png", "id.png");
  record(`${p.label}: upload ID`, r.status === 200, r.body);
  r = await upload(p, "selfie", PNG, "image/png", "selfie.png");
  record(`${p.label}: upload selfie`, r.status === 200, r.body);
  r = await upload(p, "video_testimony", WEBM, "video/webm", "video.webm");
  record(`${p.label}: upload video`, r.status === 200, r.body);
  r = await p.req("POST", "/onboarding/submit", {});
  record(
    `${p.label}: submit for review`,
    r.status === 200,
    r.body?.user?.onboardingStatus ?? r.body,
  );
}

async function main() {
  // ── 1. pages ──────────────────────────────────────────────────────────────
  const pages = [
    "/",
    "/about",
    "/faq",
    "/contact",
    "/pricing",
    "/privacy",
    "/refunds",
    "/safety",
    "/terms",
    "/become-a-helper",
    "/login",
    "/signup",
    "/signup/verify",
    "/hold",
    "/app",
    "/app/request",
    "/app/exceptions",
    "/helper",
    "/helper/services",
    "/helper/reviews",
    "/account/security",
    "/admin",
    "/admin/queue",
    "/admin/sos",
    "/admin/abuse",
    "/admin/audit",
    "/admin/staff",
    "/admin/users",
  ];
  for (const path of pages) {
    const r = await fetch(WEB + path, { redirect: "manual" });
    const ok = r.status === 200 || (r.status >= 300 && r.status < 400);
    record(
      `page ${path}`,
      ok,
      `${r.status}${r.headers.get("location") ? " → " + r.headers.get("location") : ""}`,
    );
  }
  const health = await (await fetch(API + "/health")).json();
  record("API health", health.ok === true, health.dependencies);

  // ── 2. two new people sign up and apply ───────────────────────────────────
  const R = new Person("requester");
  const H = new Person("helper");
  const A = new Person("admin");
  await signUp(R, `+9190002${stamp}`, "E2E Requester");
  await signUp(H, `+9190003${stamp}`, "E2E Helper");

  // ── 3. admin signs in (password + second code) and approves both ──────────
  let r = await A.req("POST", "/auth/password/login", {
    phone: ADMIN_PHONE,
    password: ADMIN_PASSWORD,
  });
  record("admin: password accepted", r.status === 200 && r.body.mfaRequired, Object.keys(r.body));
  r = await A.req("POST", "/auth/password/mfa", {
    phone: ADMIN_PHONE,
    pendingToken: r.body.pendingToken,
    code: OTP,
  });
  record("admin: second factor", r.status === 200, r.body.user?.role ?? r.body);
  if (!A.jar.needy_csrf) await A.req("GET", "/auth/csrf");
  for (const path of [
    "/admin/stats",
    "/admin/verifications",
    "/admin/applications",
    "/admin/users",
    "/admin/sos",
    "/admin/abuse",
    "/admin/audit",
    "/admin/audit/verify",
    "/admin/exceptions",
  ]) {
    r = await A.req("GET", path);
    record(`admin: GET ${path}`, r.status === 200, r.status === 200 ? undefined : r.body);
  }
  r = await A.req("GET", `/admin/verifications/${R.id}`);
  record(
    "admin: open requester's packet",
    r.status === 200,
    r.status === 200 ? Object.keys(r.body) : r.body,
  );
  const docUrl = JSON.stringify(r.body).match(/https?:[^"]+\/admin\/documents\/raw[^"]*/)?.[0];
  if (docUrl) {
    const d = await fetch(docUrl.replace(/\\u0026/g, "&"), {
      headers: { cookie: A.cookieHeader(), origin: WEB },
    });
    record(
      "admin: view ID document (signed link)",
      d.status === 200,
      `${d.status} ${d.headers.get("content-type")}`,
    );
  } else record("admin: view ID document (signed link)", false, "no document link in packet");
  r = await A.req("POST", `/admin/verifications/${R.id}/decision`, {
    decision: "approve",
    role: "requester",
  });
  record("admin: approve requester", r.status === 200, r.status === 200 ? undefined : r.body);
  r = await A.req("POST", `/admin/verifications/${H.id}/decision`, {
    decision: "approve",
    role: "helper",
  });
  record("admin: approve helper", r.status === 200, r.status === 200 ? undefined : r.body);

  // A role change means a fresh token: sign in again the way the app does after approval.
  for (const p of [R, H]) {
    r = await p.req("POST", "/auth/refresh", {});
    r = await p.req("GET", "/auth/me");
    record(
      `${p.label}: approved after refresh`,
      r.body.user?.onboardingStatus === "approved",
      `${r.body.user?.role} / ${r.body.user?.onboardingStatus}`,
    );
  }

  // ── 4. helper sets services and goes online ───────────────────────────────
  const svcRes = await H.req("GET", "/services");
  const svc = svcRes.body.services ?? [];
  record("service catalog", svcRes.status === 200 && svc.length > 0, svc.length + " services");
  r = await H.req("GET", "/me/services");
  record("helper: read my services", r.status === 200, r.status === 200 ? undefined : r.body);
  const codes = svc.map((s) => s.code);
  r = await H.req("PUT", "/me/services", { codes });
  record("helper: offer all services", r.status === 200, r.status === 200 ? undefined : r.body);
  try {
    await H.connect("/presence");
    await H.connect("/matching");
    record("helper: sockets connected", true);
  } catch (e) {
    record("helper: sockets connected", false, String(e));
  }
  let ack = await H.emit("/presence", "publish-availability", {
    point: { lat: ORIGIN.lat + 0.002, lng: ORIGIN.lng + 0.001 },
    available: true,
  });
  record("helper: go online", !ack?.timeout && !ack?.error, ack);
  const heartbeat = setInterval(
    () =>
      H.socket("/presence").emit(
        "publish-availability",
        { point: { lat: ORIGIN.lat + 0.002, lng: ORIGIN.lng + 0.001 }, available: true },
        () => {},
      ),
    15_000,
  );

  // ── 5. requester asks for help; helper is offered it and accepts ──────────
  r = await R.req("POST", "/tasks", {
    category: "errand",
    origin: ORIGIN,
    title: "E2E: pick up medicines",
    description: "End-to-end test task — please ignore.",
  });
  const task = r.body.task ?? r.body;
  record(
    "requester: create task",
    r.status === 200 || r.status === 201,
    task?.id ? `${task.id} ${task.state}` : r.body,
  );
  await R.connect("/matching");
  ack = await R.emit("/matching", "request-help", { taskId: task.id });
  record("requester: start search", !ack?.timeout && !ack?.error, ack);
  const offer = await H.waitFor(
    "/matching",
    "offer",
    (o) => o.taskId === task.id || o.task?.id === task.id,
    30_000,
  );
  record("helper: receives the offer", !!offer, offer ? Object.keys(offer) : "no offer in 30s");
  ack = await H.emit("/matching", "accept", { taskId: task.id });
  record("helper: accept", ack?.won === true, ack);
  const matched = await R.waitFor(
    "/matching",
    "matched",
    (m) => (m.taskId ?? m.task?.id) === task.id,
  );
  record(
    "requester: told who is coming",
    !!matched,
    matched ? Object.keys(matched) : "no matched event",
  );

  // ── 6. helper sets off; live tracking + chat ──────────────────────────────
  ack = await H.emit("/matching", "advance-task", { taskId: task.id, to: "en-route" });
  record(
    "helper: advance to en-route",
    !ack?.timeout && !ack?.error && ack?.ok !== false,
    ack?.task?.state ?? ack,
  );
  await H.connect("/tracking");
  await R.connect("/tracking");
  R.socket("/tracking").emit("join", { taskId: task.id });
  H.socket("/tracking").emit("join", { taskId: task.id });
  await sleep(800);
  for (let i = 0; i < 3; i++) {
    H.socket("/tracking").emit("location", {
      taskId: task.id,
      point: { lat: ORIGIN.lat + 0.002 - i * 0.0006, lng: ORIGIN.lng + 0.001 },
      heading: 200,
      speedMps: 1.4,
    });
    await sleep(1200);
  }
  const moved = await R.waitFor("/tracking", "helper-moved", () => true, 8_000);
  record("requester: sees helper moving", !!moved, moved ? Object.keys(moved) : "no helper-moved");
  const eta = await R.waitFor("/tracking", "eta", () => true, 4_000);
  record("requester: gets an ETA", !!eta, eta ?? "no eta event");

  await R.connect("/chat");
  await H.connect("/chat");
  R.socket("/chat").emit("join", { taskId: task.id });
  H.socket("/chat").emit("join", { taskId: task.id });
  await sleep(800);
  ack = await H.emit("/chat", "send", {
    taskId: task.id,
    clientMsgId: `e2e-${stamp}`,
    body: "Hi, I'm on my way.",
  });
  record("helper: send chat message", !ack?.timeout && !ack?.error, ack);
  const msg = await R.waitFor("/chat", "message", (m) => JSON.stringify(m).includes("on my way"));
  record("requester: receives chat message", !!msg, msg ? "delivered" : "not delivered");

  // ── 7. task lifecycle + doorstep handoff ──────────────────────────────────
  for (const to of ["arrived"]) {
    ack = await H.emit("/matching", "advance-task", { taskId: task.id, to });
    record(`helper: advance to ${to}`, !ack?.timeout && !ack?.error && ack?.ok !== false, ack);
  }
  r = await H.req("POST", `/tasks/${task.id}/handoff/brief`, {
    brief: "I will collect the medicines and bring them back.",
  });
  record("helper: handoff brief", r.status === 200, r.status === 200 ? undefined : r.body);
  r = await R.req("POST", `/tasks/${task.id}/handoff/code`, {});
  const code = r.body.code;
  record(
    "requester: get doorstep code",
    r.status === 200 && !!code,
    r.status === 200 ? "code issued" : r.body,
  );
  r = await H.req("POST", `/tasks/${task.id}/handoff/verify`, { code: "0000" });
  record("helper: wrong doorstep code refused", r.status >= 400, r.status);
  r = await H.req("POST", `/tasks/${task.id}/handoff/verify`, { code });
  record("helper: correct doorstep code", r.status === 200, r.status === 200 ? undefined : r.body);
  r = await R.req("GET", `/tasks/${task.id}`);
  const stateNow = (r.body.task ?? r.body).state;
  if (stateNow !== "in-progress") {
    ack = await H.emit("/matching", "advance-task", { taskId: task.id, to: "in-progress" });
    record("helper: advance to in-progress", !ack?.error && ack?.ok !== false, ack);
  } else record("task in progress after handoff", true);

  // ── 8. SOS during the task, handled from the console ──────────────────────
  await A.connect("/sos");
  ack = await new Promise((res) => {
    const t = setTimeout(() => res({ timeout: true }), 10_000);
    A.socket("/sos").emit("watch", (a) => {
      clearTimeout(t);
      res(a);
    });
  });
  record("admin: watch SOS console", !ack?.timeout && !ack?.error, ack && Object.keys(ack));
  await R.connect("/sos");
  ack = await R.emit("/sos", "raise", {
    taskId: task.id,
    kind: "other",
    note: "E2E test alarm — please ignore",
    at: ORIGIN,
  });
  const alertId = ack?.alertId ?? ack?.alert?.id;
  record("requester: raise SOS", !!alertId, ack);
  await sleep(1500);
  const consoleSaw = A.events.some(
    (e) => e.ns === "/sos" && JSON.stringify(e.payload ?? "").includes(alertId ?? "∅"),
  );
  record(
    "admin: SOS appears live on console",
    consoleSaw,
    consoleSaw ? undefined : A.events.filter((e) => e.ns === "/sos").map((e) => e.event),
  );
  r = await A.req("POST", `/admin/sos/${alertId}/acknowledge`, {});
  record("admin: acknowledge SOS", r.status === 200, r.status === 200 ? undefined : r.body);
  r = await A.req("POST", `/admin/sos/${alertId}/resolve`, {
    note: "E2E test — resolved by script",
  });
  record("admin: resolve SOS", r.status === 200, r.status === 200 ? undefined : r.body);

  // ── 9. complete, history, earnings, location revoked ──────────────────────
  ack = await R.emit("/matching", "advance-task", { taskId: task.id, to: "completed" });
  record(
    "requester: confirm task complete",
    !ack?.timeout && !ack?.error && ack?.ok !== false,
    ack,
  );
  r = await R.req("GET", `/tasks/${task.id}`);
  record(
    "task is completed",
    (r.body.task ?? r.body).state === "completed",
    (r.body.task ?? r.body).state,
  );
  r = await R.req("GET", "/tasks/history");
  record(
    "requester: task history",
    r.status === 200 && JSON.stringify(r.body).includes(task.id),
    r.status,
  );
  r = await H.req("GET", "/helpers/me/earnings");
  record("helper: earnings", r.status === 200, r.status === 200 ? undefined : r.body);
  r = await R.req("GET", "/snapshot");
  record("requester: reconnect snapshot", r.status === 200, r.status === 200 ? undefined : r.body);
  const before = H.events.length;
  H.socket("/tracking").emit("location", { taskId: task.id, point: ORIGIN });
  await sleep(1500);
  const lateErr = H.events.slice(before).find((e) => e.event === "error");
  record(
    "location sharing ends with the task",
    !!lateErr || !R.events.slice(-3).some((e) => e.event === "helper-moved"),
    lateErr?.payload ?? "no new position delivered",
  );

  // ── 10. cancellation path ─────────────────────────────────────────────────
  r = await R.req("POST", "/tasks", {
    category: "companionship",
    origin: ORIGIN,
    title: "E2E: cancel me",
    description: "Cancellation test.",
  });
  const t2 = r.body.task ?? r.body;
  ack = await R.emit("/matching", "request-help", { taskId: t2.id });
  ack = await R.emit("/matching", "advance-task", { taskId: t2.id, to: "cancelled" });
  r = await R.req("GET", `/tasks/${t2.id}`);
  record(
    "requester: cancel a search",
    (r.body.task ?? r.body).state === "cancelled",
    (r.body.task ?? r.body).state,
  );

  // ── 11. security checks that must hold on a public host ───────────────────
  const anon = new Person("anonymous");
  r = await anon.req("GET", "/admin/stats");
  record("anonymous refused admin API", r.status === 401 || r.status === 403, r.status);
  r = await R.req("GET", "/admin/stats");
  record("requester refused admin API", r.status === 403 || r.status === 401, r.status);
  r = await anon.req("POST", "/dev/token", { userId: H.id, role: "helper", displayName: "x" });
  record("/dev/token not reachable", r.status === 404, r.status);
  r = await fetch(API + "/metrics");
  record("/metrics not reachable", r.status === 404, r.status);
  r = await fetch(API + "/tasks", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      cookie: R.cookieHeader(),
      "content-type": "application/json",
    },
    body: "{}",
  });
  record("cross-site POST refused (CSRF)", r.status === 403, r.status);
  r = await R.req("GET", `/tasks/${task.id}`);
  const otherTask = await anon.req("GET", `/tasks/${task.id}`);
  record(
    "task hidden from strangers",
    otherTask.status === 401 || otherTask.status === 403 || otherTask.status === 404,
    otherTask.status,
  );
  const home = await fetch(WEB + "/");
  record(
    "security headers on site",
    !!home.headers.get("content-security-policy") &&
      !!home.headers.get("strict-transport-security"),
    {
      csp: !!home.headers.get("content-security-policy"),
      hsts: !!home.headers.get("strict-transport-security"),
    },
  );

  // ── 12. sign out — on a second session, so R stays signed in for the browser pass ──
  const R2 = new Person("requester (2nd device)");
  await R2.req("POST", "/auth/otp/request", { phone: R.phone });
  r = await R2.req("POST", "/auth/otp/verify", { phone: R.phone, code: OTP });
  if (!R2.jar.needy_csrf) await R2.req("GET", "/auth/csrf");
  r = await R2.req("POST", "/auth/logout", {});
  record("requester: sign out", r.status === 200 || r.status === 204, r.status);
  r = await R2.req("GET", "/auth/me");
  record("signed out means signed out", r.status === 401, r.status);
  r = await R.req("GET", "/auth/me");
  record("other device stays signed in", r.status === 200, r.status);

  // Hand the live sessions to a browser pass. Session tokens: mode 600, caller deletes it.
  if (process.env.E2E_SESSIONS_OUT) {
    fs.writeFileSync(
      process.env.E2E_SESSIONS_OUT,
      JSON.stringify({
        requester: R.jar,
        helper: H.jar,
        admin: A.jar,
        taskId: task.id,
        requesterId: R.id,
      }),
      { mode: 0o600 },
    );
  }

  clearInterval(heartbeat);
  for (const p of [R, H, A]) p.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}: ${short(f.detail)}`);
  }
  console.log(`test accounts: ${R.id} ${H.id}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
