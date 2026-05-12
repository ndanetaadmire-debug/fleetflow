import { Dispatcher } from "../src/dispatch/dispatcher.js";
import type { Driver, Job } from "../src/domain/model.js";

export const T0 = Date.UTC(2026, 10, 13, 8, 0); // 10:00 SAST
export const HOUR = 3_600_000;

// Johannesburg reference points
export const SANDTON = { lat: -26.1076, lng: 28.0567 };
export const ROSEBANK = { lat: -26.1467, lng: 28.0436 };
export const SOWETO = { lat: -26.2485, lng: 27.854 };
export const MIDRAND = { lat: -25.9992, lng: 28.1263 };

export function driver(id: string, over: Partial<Driver> = {}): Driver {
  return { id, tenantId: "acme", name: id, skills: [], location: SANDTON, locationAt: T0, shiftEndsAt: T0 + 8 * HOUR, online: true, capacity: 3, ...over };
}

export function job(id: string, over: Partial<Job> = {}): Job {
  return { id, tenantId: "acme", location: ROSEBANK, requiredSkills: [], priority: "normal", dueBy: T0 + 2 * HOUR, serviceMinutes: 30, status: "pending", driverId: null, version: 1, ...over };
}

export function makeDispatcher() {
  let now = T0;
  const d = new Dispatcher({ now: () => now });
  return { d, advance: (ms: number) => (now += ms), now: () => now };
}
