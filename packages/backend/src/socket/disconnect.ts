import type { Server } from "socket.io";
import { NS } from "@needy/shared";
import { logger } from "../logger.js";
import type { SocketData } from "./auth.js";

/**
 * Drop every live socket a user holds, on every namespace and every instance.
 *
 * The approval and block checks run at the handshake and nowhere else. Until this existed,
 * blocking someone mid-task revoked their sessions and stopped them reconnecting — and left
 * the connection they already had open, still chatting and still receiving the other
 * person's location, until they chose to close the tab. A block has to take effect now.
 *
 * Matched on the authenticated identity rather than on a room: not every namespace joins the
 * personal room, and a rule that silently skips one namespace is the kind that gets found
 * later. `fetchSockets` goes through the Redis adapter, so a socket held by another instance
 * is closed too. The handshake gate then refuses the reconnect.
 */
export async function disconnectUserSockets(io: Server, userId: string): Promise<number> {
  let closed = 0;
  for (const ns of Object.values(NS)) {
    try {
      const sockets = await io.of(ns).fetchSockets();
      for (const socket of sockets) {
        if ((socket.data as Partial<SocketData>).user?.sub === userId) {
          socket.disconnect(true);
          closed += 1;
        }
      }
    } catch (err) {
      // Best effort per namespace: one failing must not leave the others connected.
      logger.error("failed to disconnect a user's sockets", { ns, userId, err: String(err) });
    }
  }
  if (closed > 0) logger.info("disconnected live sockets", { userId, closed });
  return closed;
}
