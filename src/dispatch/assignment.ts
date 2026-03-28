import { etaSeconds } from "../domain/geo.js";
import { type Driver, type Job, PRIORITY_WEIGHT } from "../domain/model.js";

export interface Candidate {
  driverId: string;
  etaSeconds: number;
  cost: number;
}

export interface AssignmentPlan {
  assignments: Array<{ jobId: string; driverId: string; etaSeconds: number }>;
  unassigned: Array<{ jobId: string; reason: string }>;
}

export interface Constraints {
  now: number;
  /** Ignore drivers whose last GPS fix is older than this. */
  maxLocationAgeMs: number;
  /** Current open (non-terminal) job count per driver. */
  load: Map<string, number>;
}

/**
 * Hard constraints decide *whether* a driver can take a job; the cost decides *how good* it is.
 * Cost = travel time, plus a heavy penalty for arriving late, scaled by priority.
 */
export function candidatesFor(job: Job, drivers: Driver[], c: Constraints): Candidate[] {
  const out: Candidate[] = [];
  for (const d of drivers) {
    if (!d.online || d.tenantId !== job.tenantId) continue;
    if (c.now - d.locationAt > c.maxLocationAgeMs) continue;
    if ((c.load.get(d.id) ?? 0) >= d.capacity) continue;
    if (!job.requiredSkills.every((s) => d.skills.includes(s))) continue;

    const eta = etaSeconds(d.location, job.location);
    const arrival = c.now + eta * 1000;
    const finish = arrival + job.serviceMinutes * 60_000;
    if (finish > d.shiftEndsAt) continue; // can't finish before shift ends

    const lateSeconds = Math.max(0, (arrival - job.dueBy) / 1000);
    const cost = (eta + lateSeconds * 10) / PRIORITY_WEIGHT[job.priority];
    out.push({ driverId: d.id, etaSeconds: eta, cost });
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/**
 * Batch assignment with the **regret-2 heuristic**.
 *
 * Greedy "nearest driver per job" lets an easy job steal the only driver who
 * could have served a hard job. Regret insertion instead assigns first the job
 * that would lose the most if it didn't get its best driver (cost of 2nd best −
 * best). It's a standard VRP construction heuristic: near-optimal in practice,
 * O(J²·D), and explainable to ops staff, unlike a black-box solver.
 */
export function planAssignments(jobs: Job[], drivers: Driver[], c: Constraints): AssignmentPlan {
  const load = new Map(c.load);
  const open = jobs.filter((j) => j.status === "pending");
  const plan: AssignmentPlan = { assignments: [], unassigned: [] };

  while (open.length > 0) {
    let pickIdx = -1;
    let pick: Candidate | undefined;
    let bestRegret = -Infinity;

    for (let i = 0; i < open.length; i++) {
      const cands = candidatesFor(open[i]!, drivers, { ...c, load });
      if (cands.length === 0) continue;
      const regret = cands.length === 1 ? Number.POSITIVE_INFINITY : cands[1]!.cost - cands[0]!.cost;
      // Tie-break: higher priority, then earlier due date.
      const better =
        regret > bestRegret ||
        (regret === bestRegret && pickIdx >= 0 && PRIORITY_WEIGHT[open[i]!.priority] > PRIORITY_WEIGHT[open[pickIdx]!.priority]) ||
        (regret === bestRegret && pickIdx >= 0 && open[i]!.dueBy < open[pickIdx]!.dueBy);
      if (better) {
        bestRegret = regret;
        pickIdx = i;
        pick = cands[0];
      }
    }

    if (pickIdx < 0 || !pick) {
      for (const j of open) plan.unassigned.push({ jobId: j.id, reason: explainUnassignable(j, drivers, { ...c, load }) });
      break;
    }
    const [job] = open.splice(pickIdx, 1);
    plan.assignments.push({ jobId: job!.id, driverId: pick.driverId, etaSeconds: pick.etaSeconds });
    load.set(pick.driverId, (load.get(pick.driverId) ?? 0) + 1);
  }
  return plan;
}

/** Ops staff need to know *why* a job is stuck, not just that it is. */
export function explainUnassignable(job: Job, drivers: Driver[], c: Constraints): string {
  const tenant = drivers.filter((d) => d.tenantId === job.tenantId);
  if (!tenant.some((d) => d.online)) return "no drivers online";
  const skilled = tenant.filter((d) => d.online && job.requiredSkills.every((s) => d.skills.includes(s)));
  if (skilled.length === 0) return `no online driver has skills: ${job.requiredSkills.join(", ")}`;
  const fresh = skilled.filter((d) => c.now - d.locationAt <= c.maxLocationAgeMs);
  if (fresh.length === 0) return "qualified drivers have stale GPS";
  if (fresh.every((d) => (c.load.get(d.id) ?? 0) >= d.capacity)) return "qualified drivers are at capacity";
  return "no qualified driver can finish before shift end";
}
