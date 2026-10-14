/**
 * ── What the dev scripts share with the server ────────────────────────────
 *
 *  Since migration 12 a user's phone number is sealed in `users.phone_enc` and found through
 *  the keyed `users.phone_hash`; the plaintext column is empty. A script that writes or looks
 *  up accounts with SQL therefore has to seal and index exactly as the server does — under the
 *  SAME keys, or the server cannot open what the script wrote and lookups miss.
 *
 *  So this loads the backend's own `.env` (the file the dev server reads) before importing the
 *  compiled backend modules, whose config is read once at import. Build first:
 *  `npm run build --workspace @needy/backend`.
 *
 *  NODE_ENV defaults to development ONLY when no DATABASE_URL is configured either, i.e. when
 *  the script is about to touch the local docker database. Pointed at any other database with
 *  no NODE_ENV, the backend's config treats it as production and refuses to run without the
 *  real keys — which is the right answer: sealing a production row under the development key
 *  would leave an account the server cannot open.
 */
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: fileURLToPath(new URL("../../packages/backend/.env", import.meta.url)) });
if (!process.env.NODE_ENV && !process.env.DATABASE_URL) process.env.NODE_ENV = "development";

export const DB = process.env.DATABASE_URL ?? "postgres://needy:needy@localhost:5432/needy";

export const { hashPassword, passwordProblem } =
  await import("../../packages/backend/dist/auth/password.js");
export const { sealPhone, openPhone } = await import("../../packages/backend/dist/auth/userPii.js");
export const { phoneIndex } = await import("../../packages/backend/dist/crypto/pii.js");

/** The last four digits only. These scripts print to a terminal, and scrollback is not where a
 *  list of everyone's phone numbers should end up. */
export const masked = (phone) => `***${String(phone).replace(/\D/g, "").slice(-4)}`;
