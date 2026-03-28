import type { LatLng } from "../domain/geo.js";
import type { Job, JobStatus, Priority } from "../domain/model.js";

/**
 * The job lifecycle is event-sourced: state is a fold over events. This gives a
 * complete, replayable history (who assigned what, when the driver arrived) for
 * SLA reporting and dispute resolution, at no extra cost.
 */
export type JobEvent =
  | { type: "JobCreated"; jobId: string; tenantId: string; at: number; location: LatLng; requiredSkills: string[]; priority: Priority; dueBy: number; serviceMinutes: number }
  | { type: "JobAssigned"; jobId: string; at: number; driverId: string; etaSeconds: number; by: "auto" | string }
  | { type: "JobUnassigned"; jobId: string; at: number; reason: string }
  | { type: "DriverEnRoute"; jobId: string; at: number }
  | { type: "DriverArrived"; jobId: string; at: number; distanceM: number }
  | { type: "JobCompleted"; jobId: string; at: number; notes?: string }
  | { type: "JobFailed"; jobId: string; at: number; reason: string }
  | { type: "JobCancelled"; jobId: string; at: number; reason: string };

/** Allowed transitions. Anything else is a programming or client error. */
const TRANSITIONS: Record<JobStatus, Partial<Record<JobEvent["type"], JobStatus>>> = {
  pending: { JobAssigned: "assigned", JobCancelled: "cancelled" },
  assigned: { DriverEnRoute: "en_route", JobUnassigned: "pending", JobCancelled: "cancelled", DriverArrived: "on_site" },
  en_route: { DriverArrived: "on_site", JobUnassigned: "pending", JobCancelled: "cancelled" },
  on_site: { JobCompleted: "completed", JobFailed: "failed" },
  completed: {},
  failed: {},
  cancelled: {},
};

export class InvalidTransition extends Error {
  constructor(readonly from: JobStatus, readonly event: JobEvent["type"]) {
    super(`Cannot apply ${event} to a job in status ${from}`);
  }
}

export function canApply(status: JobStatus, type: JobEvent["type"]): boolean {
  return TRANSITIONS[status][type] !== undefined;
}

export function apply(job: Job | null, e: JobEvent): Job {
  if (e.type === "JobCreated") {
    if (job) throw new InvalidTransition(job.status, e.type);
    return {
      id: e.jobId, tenantId: e.tenantId, location: e.location, requiredSkills: e.requiredSkills, priority: e.priority,
      dueBy: e.dueBy, serviceMinutes: e.serviceMinutes, status: "pending", driverId: null, version: 1,
    };
  }
  if (!job) throw new Error(`Event ${e.type} for unknown job ${e.jobId}`);
  const next = TRANSITIONS[job.status][e.type];
  if (!next) throw new InvalidTransition(job.status, e.type);
  return {
    ...job,
    status: next,
    driverId: e.type === "JobAssigned" ? e.driverId : e.type === "JobUnassigned" ? null : job.driverId,
    version: job.version + 1,
  };
}

export function replay(events: JobEvent[]): Job | null {
  return events.reduce<Job | null>((j, e) => apply(j, e), null);
}
