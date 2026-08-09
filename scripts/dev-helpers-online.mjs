/**
 * ── Put helpers on the map, near you ───────────────────────────────────────
 *
 *  Manual dev tool. Matching only reaches helpers who are in the availability index within
 *  1 / 5 / 10 km of the request, and that index is only written when a helper's browser
 *  publishes its own position. With one browser profile you cannot be signed in as both a
 *  requester and a helper at once — so testing a match by hand needs either a second browser
 *  or this.
 *
 *  It signs in as the seeded helper accounts over the socket exactly as their app would, and
 *  publishes availability around a point you choose. Nothing here bypasses the server: the
 *  helpers are real approved accounts, the eligibility matrix and the service filter still
 *  apply, and an offer still has to be accepted.
 *
 *  Usage — from the repo root, with `npm run dev` already running:
 *
 *      node scripts/dev-helpers-online.mjs                 # around the default point
 *      node scripts/dev-helpers-online.mjs 12.9716 77.5946 # around a lat/lng you give it
 *
 *  Leave it running. It re-publishes every 20 seconds because availability entries are TTL'd
 *  server-side — publish once and the helper ages out of the index about a minute later, which
 *  is the correct behaviour for a phone that has gone quiet.
 */
import { io } from "socket.io-client";
import jwt from "jsonwebtoken";

const API = process.env.NEEDY_API ?? "http://localhost:4000";
const SECRET = process.env.JWT_SECRET ?? "dev-only-change-me";

/** Defaults to the origin used while building these screens. Override with argv. */
const lat = Number(process.argv[2] ?? 17.46323293433547);
const lng = Number(process.argv[3] ?? 78.36728364229204);

if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
  console.error("usage: node scripts/dev-helpers-online.mjs [lat] [lng]");
  process.exit(1);
}

/** The seeded helpers, spread a few hundred metres apart so the requester's radar has
 *  distinguishable pins rather than one dot. */
const HELPERS = [
  { id: "p-help-n", name: "Priya", d: { lat: 0.006, lng: 0.001 } },
  { id: "p-help-se", name: "Meera", d: { lat: -0.004, lng: 0.005 } },
  { id: "p-help-w", name: "Lakshmi", d: { lat: 0.001, lng: -0.007 } },
  { id: "p-help-y", name: "Divya", d: { lat: 0.002, lng: 0.003 } },
];

const token = (sub) =>
  jwt.sign({ sub, role: "helper", displayName: sub, kyc: "verified" }, SECRET, {
    expiresIn: "2h",
  });

const connect = (sub) =>
  new Promise((resolve, reject) => {
    const socket = io(`${API}/presence`, {
      transports: ["websocket"],
      auth: { token: token(sub) },
      forceNew: true,
    });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });

const publish = (socket, point) =>
  new Promise((resolve) =>
    socket.emit("publish-availability", { point, available: true }, resolve),
  );

const sockets = [];
for (const helper of HELPERS) {
  const point = { lat: lat + helper.d.lat, lng: lng + helper.d.lng };
  try {
    const socket = await connect(helper.id);
    sockets.push({ socket, helper, point });
    const ack = await publish(socket, point);
    console.log(
      ack?.ok
        ? `  ✓ ${helper.name} is available near ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`
        : `  ✗ ${helper.name} refused: ${JSON.stringify(ack)}`,
    );
  } catch (err) {
    console.log(`  ✗ ${helper.name} could not connect: ${String(err)}`);
  }
}

if (sockets.length === 0) {
  console.error("\nNo helper could connect. Is `npm run dev` running?");
  process.exit(1);
}

console.log("\nHolding them online. Press Ctrl-C to take them off the map.");
setInterval(() => {
  for (const { socket, point } of sockets) void publish(socket, point);
}, 20_000);

const shutdown = () => {
  for (const { socket } of sockets) socket.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
