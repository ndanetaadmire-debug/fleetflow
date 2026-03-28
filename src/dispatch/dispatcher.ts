import { randomUUID } from "node:crypto";
import { haversine, isValidLatLng, type LatLng } from "../domain/geo.js";
import { type Driver, type Job, type Priority, TERMINAL } from "../domain/model.js";
import { InMemoryEventStore } from "../events/eventStore.js";
import { apply, canApply, InvalidTransition, type JobEvent } from "../events/jobEvents.js";
import { planAssignments } from "./assignment.js";

export interface DispatcherOptions {
  now?: () => number;
  arrivalRadiusM?: number;
  maxLocationAgeMs?: number;
}

export class NotFound extends Error {}

/**
 * Application service. Commands validate against the current projection,
 * emit events, and the projection is updated by folding those events.
 * The read model (`jobs`) can always be rebuilt from the event store.
 */
export class Dispatcher {
  readonly events = new InMemoryEventStore();
  private readonly jobs = new Map<string, Job>();
  private readonly drivers = new Map<string, Driver>();
  private readonly now: () => number;
  private readonly arrivalRadiusM: number;
  private readonly maxLocationAgeMs: number;

  constructor(opts: DispatcherOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.arrivalRadiusM = opts.arrivalRadiusM ?? 100;
    this.maxLocationAgeMs = opts.maxLocationAgeMs ?? 5 * 60_000;
    this.events.subscribe(({ event }) => {
      this.jobs.set(event.jobId, apply(this.jobs.get(event.jobId) ?? null, event));
    });
  }

  // ---- drivers -----------------------------------------------------------------------------
  upsertDriver(d: Omit<Driver, "locationAt"> & { locationAt?: number }): Driver {
    if (!isValidLatLng(d.location)) throw new RangeError("invalid coordinates");
    const driver = { ...d, locationAt: d.locationAt ?? this.now() };
    this.drivers.set(d.id, driver);
    return driver;
  }

  /**
   * GPS ping. Out-of-order pings are dropped (mobile networks reorder), and
   * entering the geofence of an assigned job emits DriverArrived automatically.
   */
  updateLocation(driverId: string, location: LatLng, at: number): JobEvent[] {
    const d = this.drivers.get(driverId);
    if (!d) throw new NotFound(`driver ${driverId}`);
    if (!isValidLatLng(location)) throw new RangeError("invalid coordinates");
    if (at <= d.locationAt) return [];
    this.drivers.set(driverId, { ...d, location, locationAt: at });

    const emitted: JobEvent[] = [];
    for (const job of this.openJobsFor(driverId)) {
      if (job.status !== "assigned" && job.status !== "en_route") continue;
      const distanceM = Math.round(haversine(location, job.location));
      if (distanceM <= this.arrivalRadiusM) {
        emitted.push(...this.emit(job, { type: "DriverArrived", jobId: job.id, at, distanceM }));
      }
    }
    return emitted;
  }

  /** Driver went offline: release their not-yet-started work back to the pool. */
  setOnline(driverId: string, online: boolean): JobEvent[] {
    const d = this.drivers.get(driverId);
    if (!d) throw new NotFound(`driver ${driverId}`);
    this.drivers.set(driverId, { ...d, online });
    if (online) return [];
    return this.openJobsFor(driverId)
      .filter((j) => j.status === "assigned" || j.status === "en_route")
      .flatMap((j) => this.emit(j, { type: "JobUnassigned", jobId: j.id, at: this.now(), reason: "driver_offline" }));
  }

  // ---- jobs --------------------------------------------------------------------------------
  createJob(input: { tenantId: string; location: LatLng; requiredSkills?: string[]; priority?: Priority; dueBy: number; serviceMinutes?: number }): Job {
    if (!isValidLatLng(input.location)) throw new RangeError("invalid coordinates");
    const jobId = `job_${randomUUID()}`;
    this.events.append(jobId, 0, [{
      type: "JobCreated", jobId, tenantId: input.tenantId, at: this.now(), location: input.location,
      requiredSkills: input.requiredSkills ?? [], priority: input.priority ?? "normal", dueBy: input.dueBy,
      serviceMinutes: input.serviceMinutes ?? 30,
    }]);
    return this.job(jobId);
  }

  /** Run the batch optimiser over all pending jobs for a tenant. */
  autoDispatch(tenantId: string) {
    const jobs = [...this.jobs.values()].filter((j) => j.tenantId === tenantId && j.status === "pending");
    const drivers = [...this.drivers.values()].filter((d) => d.tenantId === tenantId);
    const plan = planAssignments(jobs, drivers, { now: this.now(), maxLocationAgeMs: this.maxLocationAgeMs, load: this.loadByDriver() });
    for (const a of plan.assignments) {
      this.emit(this.job(a.jobId), { type: "JobAssigned", jobId: a.jobId, at: this.now(), driverId: a.driverId, etaSeconds: a.etaSeconds, by: "auto" });
    }
    return plan;
  }

  assignManually(jobId: string, driverId: string, by: string): Job {
    const job = this.job(jobId);
    const d = this.drivers.get(driverId);
    if (!d || d.tenantId !== job.tenantId) throw new NotFound(`driver ${driverId}`);
    if (job.status !== "pending") this.emit(job, { type: "JobUnassigned", jobId, at: this.now(), reason: `reassigned by ${by}` });
    this.emit(this.job(jobId), { type: "JobAssigned", jobId, at: this.now(), driverId, etaSeconds: 0, by });
    return this.job(jobId);
  }

  transition(jobId: string, type: "DriverEnRoute" | "JobCompleted" | "JobFailed" | "JobCancelled", detail?: string): Job {
    const job = this.job(jobId);
    const at = this.now();
    const e: JobEvent =
      type === "DriverEnRoute" ? { type, jobId, at }
      : type === "JobCompleted" ? { type, jobId, at, notes: detail }
      : { type, jobId, at, reason: detail ?? "unspecified" };
    this.emit(job, e);
    return this.job(jobId);
  }

  job(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new NotFound(`job ${id}`);
    return j;
  }

  listJobs(tenantId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.tenantId === tenantId);
  }

  driver(id: string): Driver | undefined {
    return this.drivers.get(id);
  }

  /** SLA metric: was the driver on site before the job's due time? Derived purely from events. */
  slaReport(tenantId: string) {
    let onTime = 0;
    let late = 0;
    for (const job of this.listJobs(tenantId)) {
      const arrived = this.events.read(job.id).find((e) => e.type === "DriverArrived");
      if (!arrived) continue;
      if (arrived.at <= job.dueBy) onTime++;
      else late++;
    }
    const total = onTime + late;
    return { onTime, late, onTimeRate: total ? onTime / total : null };
  }

  // ---- internals ---------------------------------------------------------------------------
  private emit(job: Job, e: JobEvent): JobEvent[] {
    if (!canApply(job.status, e.type)) throw new InvalidTransition(job.status, e.type);
    // expectedVersion = events already in the stream → rejects a stale concurrent command.
    this.events.append(job.id, job.version, [e]);
    return [e];
  }

  private openJobsFor(driverId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.driverId === driverId && !TERMINAL.has(j.status));
  }

  private loadByDriver(): Map<string, number> {
    const load = new Map<string, number>();
    for (const j of this.jobs.values()) {
      if (j.driverId && !TERMINAL.has(j.status)) load.set(j.driverId, (load.get(j.driverId) ?? 0) + 1);
    }
    return load;
  }
}
