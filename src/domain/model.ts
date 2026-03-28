import type { LatLng } from "./geo.js";

export type JobStatus = "pending" | "assigned" | "en_route" | "on_site" | "completed" | "failed" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent";

export interface Job {
  id: string;
  tenantId: string;
  location: LatLng;
  requiredSkills: string[];
  priority: Priority;
  /** Latest acceptable arrival (epoch ms). */
  dueBy: number;
  serviceMinutes: number;
  status: JobStatus;
  driverId: string | null;
  version: number;
}

export interface Driver {
  id: string;
  tenantId: string;
  name: string;
  skills: string[];
  location: LatLng;
  locationAt: number;
  shiftEndsAt: number;
  online: boolean;
  /** Max concurrently assigned (not yet completed) jobs. */
  capacity: number;
}

export const PRIORITY_WEIGHT: Record<Priority, number> = { low: 0.5, normal: 1, high: 2, urgent: 4 };

export const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);
