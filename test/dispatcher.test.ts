import { describe, expect, it } from "vitest";
import { InvalidTransition, replay } from "../src/events/jobEvents.js";
import { ConcurrencyError } from "../src/events/eventStore.js";
import { driver, HOUR, makeDispatcher, ROSEBANK, SANDTON } from "./fixtures.js";

describe("dispatcher lifecycle", () => {
  it("assigns, detects geofenced arrival from GPS, completes, and reports SLA", () => {
    const { d, now, advance } = makeDispatcher();
    d.upsertDriver(driver("thabo", { location: SANDTON }));
    const job = d.createJob({ tenantId: "acme", location: ROSEBANK, dueBy: now() + HOUR });

    const plan = d.autoDispatch("acme");
    expect(plan.assignments[0]).toMatchObject({ jobId: job.id, driverId: "thabo" });

    d.transition(job.id, "DriverEnRoute");
    advance(10 * 60_000);
    expect(d.updateLocation("thabo", { lat: -26.13, lng: 28.05 }, now())).toEqual([]); // still 2km away
    advance(5 * 60_000);
    const arrived = d.updateLocation("thabo", { lat: -26.1468, lng: 28.0437 }, now()); // ~15m away
    expect(arrived[0]).toMatchObject({ type: "DriverArrived" });
    expect(d.job(job.id).status).toBe("on_site");

    d.transition(job.id, "JobCompleted", "replaced valve");
    expect(d.job(job.id).status).toBe("completed");
    expect(d.slaReport("acme")).toEqual({ onTime: 1, late: 0, onTimeRate: 1 });
  });

  it("the read model is exactly a replay of the event stream", () => {
    const { d, now } = makeDispatcher();
    d.upsertDriver(driver("a"));
    const job = d.createJob({ tenantId: "acme", location: ROSEBANK, dueBy: now() + HOUR });
    d.autoDispatch("acme");
    d.transition(job.id, "DriverEnRoute");
    expect(replay(d.events.read(job.id))).toEqual(d.job(job.id));
  });

  it("drops out-of-order GPS pings", () => {
    const { d, now } = makeDispatcher();
    d.upsertDriver(driver("a", { locationAt: now() }));
    d.updateLocation("a", ROSEBANK, now() + 2000);
    d.updateLocation("a", SANDTON, now() + 1000); // late packet
    expect(d.driver("a")?.location).toEqual(ROSEBANK);
  });

  it("releases work when a driver goes offline, so it can be re-dispatched", () => {
    const { d, now } = makeDispatcher();
    d.upsertDriver(driver("a"));
    d.upsertDriver(driver("b", { location: { lat: -26.2, lng: 28.0 } }));
    const job = d.createJob({ tenantId: "acme", location: ROSEBANK, dueBy: now() + HOUR });
    d.autoDispatch("acme");
    const first = d.job(job.id).driverId!;
    const events = d.setOnline(first, false);
    expect(events[0]).toMatchObject({ type: "JobUnassigned", reason: "driver_offline" });
    d.autoDispatch("acme");
    expect(d.job(job.id).driverId).not.toBe(first);
  });

  it("rejects illegal transitions and stale writers", () => {
    const { d, now } = makeDispatcher();
    const job = d.createJob({ tenantId: "acme", location: ROSEBANK, dueBy: now() + HOUR });
    expect(() => d.transition(job.id, "JobCompleted")).toThrow(InvalidTransition);
    expect(() => d.events.append(job.id, 0, [{ type: "JobCancelled", jobId: job.id, at: 0, reason: "x" }])).toThrow(ConcurrencyError);
  });

  it("supports manual reassignment by a dispatcher", () => {
    const { d, now } = makeDispatcher();
    d.upsertDriver(driver("a"));
    d.upsertDriver(driver("b"));
    const job = d.createJob({ tenantId: "acme", location: ROSEBANK, dueBy: now() + HOUR });
    d.autoDispatch("acme");
    const other = d.job(job.id).driverId === "a" ? "b" : "a";
    expect(d.assignManually(job.id, other, "lerato").driverId).toBe(other);
    expect(d.events.read(job.id).map((e) => e.type)).toEqual(["JobCreated", "JobAssigned", "JobUnassigned", "JobAssigned"]);
  });

  it("validates coordinates", () => {
    const { d, now } = makeDispatcher();
    expect(() => d.createJob({ tenantId: "acme", location: { lat: 200, lng: 0 }, dueBy: now() })).toThrow(RangeError);
  });
});
