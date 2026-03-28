import type { JobEvent } from "./jobEvents.js";

export class ConcurrencyError extends Error {}

export interface StoredEvent {
  seq: number;
  streamId: string;
  event: JobEvent;
}

/**
 * Append-only event store with per-stream optimistic concurrency
 * (`expectedVersion`), the same contract as EventStoreDB or a Postgres
 * `events(stream_id, version) UNIQUE` table.
 */
export class InMemoryEventStore {
  private readonly log: StoredEvent[] = [];
  private readonly streams = new Map<string, JobEvent[]>();
  private readonly subscribers = new Set<(e: StoredEvent) => void>();

  append(streamId: string, expectedVersion: number, events: JobEvent[]): StoredEvent[] {
    const stream = this.streams.get(streamId) ?? [];
    if (stream.length !== expectedVersion) {
      throw new ConcurrencyError(`Stream ${streamId} is at ${stream.length}, expected ${expectedVersion}`);
    }
    const stored = events.map((event) => ({ seq: this.log.length + 1, streamId, event }));
    for (const s of stored) {
      this.log.push(s);
      stream.push(s.event);
    }
    this.streams.set(streamId, stream);
    for (const s of stored) for (const fn of this.subscribers) fn(s);
    return stored;
  }

  read(streamId: string): JobEvent[] {
    return [...(this.streams.get(streamId) ?? [])];
  }

  readAll(fromSeq = 0): StoredEvent[] {
    return this.log.slice(fromSeq);
  }

  subscribe(fn: (e: StoredEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
