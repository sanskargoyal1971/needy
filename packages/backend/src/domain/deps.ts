import type { Server } from "socket.io";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { RedisClients } from "../redis.js";
import type {
  HelperProfileRepository,
  MessageRepository,
  TaskRepository,
} from "./stores.js";

/** The single dependency container passed to every namespace registrar and the HTTP
 *  layer. Modules depend ONLY on this surface — never on each other — which is what lets
 *  them be built and reasoned about independently. */
export interface Deps {
  io: Server;
  redis: RedisClients;
  logger: Logger;
  config: Config;
  tasks: TaskRepository;
  messages: MessageRepository;
  helpers: HelperProfileRepository;
  /** Injectable clock so tests are deterministic (rate-limit refills, offer windows,
   *  away-sweeps all read time through this). Defaults to Date.now in production wiring. */
  now: () => number;
}

/** Each namespace module exports a registrar with exactly this signature. `index.ts`
 *  calls them all after the io server and Redis are ready. */
export type NamespaceRegistrar = (deps: Deps) => void;
