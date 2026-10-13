import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server as IOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { NS } from "@needy/shared";
import { signAccessToken } from "../../auth/jwt.js";
import { authMiddleware } from "../auth.js";
import { disconnectUserSockets } from "../disconnect.js";

/** A block has to end the connection that is already open, on every namespace — including
 *  ones that never join the personal room — and must not touch anybody else's. */
describe("disconnectUserSockets", () => {
  let httpServer: HttpServer;
  let io: IOServer;
  let port: number;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    httpServer = createServer();
    io = new IOServer(httpServer);
    for (const ns of Object.values(NS)) io.of(ns).use(authMiddleware);
    await new Promise<void>((r) => httpServer.listen(0, r));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const c of clients) c.disconnect();
    await io.close();
  });

  const connect = (ns: string, userId: string): Promise<ClientSocket> => {
    const token = signAccessToken({ sub: userId, role: "both", displayName: userId });
    const socket = ioClient(`http://localhost:${port}${ns}`, {
      transports: ["websocket"],
      auth: { token },
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    return new Promise((resolve, reject) => {
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", reject);
    });
  };

  it("closes every socket the user holds and nobody else's", async () => {
    const theirs = await Promise.all(Object.values(NS).map((ns) => connect(ns, "blocked-user")));
    const bystander = await connect(NS.chat, "someone-else");

    const dropped = theirs.map(
      (s) => new Promise<string>((resolve) => s.on("disconnect", (reason) => resolve(reason))),
    );
    const closed = await disconnectUserSockets(io, "blocked-user");

    expect(closed).toBe(Object.values(NS).length);
    // "io server disconnect" is the reason a client does NOT auto-reconnect from.
    expect(await Promise.all(dropped)).toEqual(theirs.map(() => "io server disconnect"));
    expect(bystander.connected).toBe(true);
  });
});
