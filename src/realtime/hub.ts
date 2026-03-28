import type { StoredEvent } from "../events/eventStore.js";

export interface Socket {
  send(data: string): void;
  readonly readyState: number;
  bufferedAmount?: number;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;
const MAX_BUFFERED_BYTES = 1_000_000;

/**
 * Tenant-scoped fan-out. Each connection only ever receives its own tenant's events.
 * Slow consumers are disconnected instead of buffering unboundedly (back-pressure).
 * Every message carries `seq` so clients can resume with `?since=<seq>` after reconnecting.
 */
export class RealtimeHub {
  private readonly rooms = new Map<string, Set<Socket>>();

  join(tenantId: string, socket: Socket): () => void {
    const room = this.rooms.get(tenantId) ?? new Set();
    room.add(socket);
    this.rooms.set(tenantId, room);
    return () => {
      room.delete(socket);
      if (room.size === 0) this.rooms.delete(tenantId);
    };
  }

  publish(tenantId: string, stored: StoredEvent): void {
    const msg = JSON.stringify({ seq: stored.seq, ...stored.event });
    for (const s of this.rooms.get(tenantId) ?? []) {
      if (s.readyState !== OPEN) continue;
      if ((s.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
        s.close(1013, "client too slow, reconnect with ?since");
        continue;
      }
      s.send(msg);
    }
  }

  connections(tenantId: string): number {
    return this.rooms.get(tenantId)?.size ?? 0;
  }
}
