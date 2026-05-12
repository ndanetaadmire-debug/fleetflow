import { describe, expect, it } from "vitest";
import { candidatesFor, planAssignments } from "../src/dispatch/assignment.js";
import { etaSeconds, haversine } from "../src/domain/geo.js";
import { driver, HOUR, job, MIDRAND, ROSEBANK, SANDTON, SOWETO, T0 } from "./fixtures.js";

const base = { now: T0, maxLocationAgeMs: 5 * 60_000, load: new Map<string, number>() };

describe("geo", () => {
  it("computes realistic Johannesburg distances", () => {
    expect(haversine(SANDTON, ROSEBANK) / 1000).toBeCloseTo(4.5, 0);
    expect(etaSeconds(SANDTON, SOWETO)).toBeGreaterThan(etaSeconds(SANDTON, ROSEBANK));
  });
});

describe("hard constraints", () => {
  it("filters by skills, tenant, freshness, capacity and shift end", () => {
    const j = job("j", { requiredSkills: ["gas"] });
    const drivers = [
      driver("ok", { skills: ["gas", "electrical"] }),
      driver("no-skill"),
      driver("other-tenant", { tenantId: "globex", skills: ["gas"] }),
      driver("stale", { skills: ["gas"], locationAt: T0 - HOUR }),
      driver("offline", { skills: ["gas"], online: false }),
      driver("full", { skills: ["gas"], capacity: 1 }),
      driver("shift-over", { skills: ["gas"], shiftEndsAt: T0 + 10 * 60_000 }),
    ];
    const ids = candidatesFor(j, drivers, { ...base, load: new Map([["full", 1]]) }).map((c) => c.driverId);
    expect(ids).toEqual(["ok"]);
  });

  it("prefers the closer driver", () => {
    const ids = candidatesFor(job("j"), [driver("far", { location: SOWETO }), driver("near", { location: SANDTON })], base).map((c) => c.driverId);
    expect(ids).toEqual(["near", "far"]);
  });
});

describe("regret-2 batch assignment", () => {
  it("beats greedy: the constrained job gets the only driver who can do it", () => {
    // Greedy in arrival order would give the plumber (closest to both) to the easy job first,
    // leaving the gas job unassignable. Regret assigns the gas job first.
    const easy = job("easy", { location: ROSEBANK });
    const gas = job("gas", { location: MIDRAND, requiredSkills: ["gas"], dueBy: T0 + 4 * HOUR });
    const drivers = [driver("gas-tech", { skills: ["gas"], location: SANDTON, capacity: 1 }), driver("general", { location: SOWETO, capacity: 1 })];
    const plan = planAssignments([easy, gas], drivers, base);
    expect(Object.fromEntries(plan.assignments.map((a) => [a.jobId, a.driverId]))).toEqual({ gas: "gas-tech", easy: "general" });
    expect(plan.unassigned).toEqual([]);
  });

  it("respects capacity across the batch and explains leftovers", () => {
    const jobs = [job("a"), job("b"), job("c")];
    const plan = planAssignments(jobs, [driver("solo", { capacity: 2 })], base);
    expect(plan.assignments).toHaveLength(2);
    expect(plan.unassigned).toEqual([{ jobId: expect.any(String), reason: "qualified drivers are at capacity" }]);
  });

  it("explains why nothing can be assigned", () => {
    expect(planAssignments([job("x", { requiredSkills: ["crane"] })], [driver("d")], base).unassigned[0]?.reason).toMatch(/skills: crane/);
    expect(planAssignments([job("x")], [driver("d", { online: false })], base).unassigned[0]?.reason).toBe("no drivers online");
    expect(planAssignments([job("x")], [driver("d", { locationAt: 0 })], base).unassigned[0]?.reason).toMatch(/stale GPS/);
  });

  it("weights urgent jobs so they win contested drivers", () => {
    const normal = job("normal", { location: ROSEBANK });
    const urgent = job("urgent", { location: ROSEBANK, priority: "urgent" });
    const plan = planAssignments([normal, urgent], [driver("only", { capacity: 1 })], base);
    expect(plan.assignments[0]?.jobId).toBe("urgent");
  });
});
