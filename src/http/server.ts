import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { Dispatcher, NotFound } from "../dispatch/dispatcher.js";
import { InvalidTransition } from "../events/jobEvents.js";
import { ConcurrencyError } from "../events/eventStore.js";
import { RealtimeHub } from "../realtime/hub.js";

const LatLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/**
 * Tenant is resolved from the `x-tenant-id` header here for clarity; in production it comes from
 * the verified JWT and is never trusted from the client directly.
 */
export function buildServer(dispatcher = new Dispatcher(), hub = new RealtimeHub()): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(websocket);

  const tenantOf = (headers: Record<string, unknown>) => {
    const t = headers["x-tenant-id"];
    if (typeof t !== "string" || !/^[a-z0-9-]{2,40}$/.test(t)) throw Object.assign(new Error("missing tenant"), { statusCode: 401 });
    return t;
  };

  dispatcher.events.subscribe((stored) => {
    const job = dispatcher.job(stored.event.jobId);
    hub.publish(job.tenantId, stored);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof NotFound) return reply.code(404).send({ error: "not_found" });
    if (err instanceof InvalidTransition || err instanceof ConcurrencyError) return reply.code(409).send({ error: "conflict", message: err.message });
    if (err instanceof RangeError) return reply.code(400).send({ error: "invalid_request", message: err.message });
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(code).send({ error: code === 500 ? "internal" : (err as Error).message });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/v1/drivers", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const b = z.object({
      id: z.string().min(1), name: z.string().min(1), skills: z.array(z.string()).default([]), location: LatLng,
      shiftEndsAt: z.number().int(), capacity: z.number().int().min(1).max(20).default(3), online: z.boolean().default(true),
    }).parse(req.body);
    return reply.code(201).send(dispatcher.upsertDriver({ ...b, tenantId }));
  });

  app.post("/v1/drivers/:id/location", async (req) => {
    tenantOf(req.headers);
    const { id } = req.params as { id: string };
    const b = z.object({ location: LatLng, at: z.number().int() }).parse(req.body);
    return { events: dispatcher.updateLocation(id, b.location, b.at) };
  });

  app.post("/v1/drivers/:id/status", async (req) => {
    tenantOf(req.headers);
    const { id } = req.params as { id: string };
    const b = z.object({ online: z.boolean() }).parse(req.body);
    return { events: dispatcher.setOnline(id, b.online) };
  });

  app.post("/v1/jobs", async (req, reply) => {
    const tenantId = tenantOf(req.headers);
    const b = z.object({
      location: LatLng, requiredSkills: z.array(z.string()).default([]), priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      dueBy: z.number().int(), serviceMinutes: z.number().int().min(1).max(480).default(30),
    }).parse(req.body);
    return reply.code(201).send(dispatcher.createJob({ ...b, tenantId }));
  });

  app.get("/v1/jobs", async (req) => ({ data: dispatcher.listJobs(tenantOf(req.headers)) }));

  app.get("/v1/jobs/:id/history", async (req) => {
    const tenantId = tenantOf(req.headers);
    const { id } = req.params as { id: string };
    if (dispatcher.job(id).tenantId !== tenantId) throw new NotFound(id);
    return { events: dispatcher.events.read(id) };
  });

  app.post("/v1/dispatch", async (req) => dispatcher.autoDispatch(tenantOf(req.headers)));

  app.post("/v1/jobs/:id/:action", async (req) => {
    const tenantId = tenantOf(req.headers);
    const { id, action } = req.params as { id: string; action: string };
    if (dispatcher.job(id).tenantId !== tenantId) throw new NotFound(id);
    const body = (req.body ?? {}) as { detail?: string; driverId?: string; by?: string };
    const map = { "en-route": "DriverEnRoute", complete: "JobCompleted", fail: "JobFailed", cancel: "JobCancelled" } as const;
    if (action === "assign") return dispatcher.assignManually(id, z.string().parse(body.driverId), body.by ?? "dispatcher");
    const type = map[action as keyof typeof map];
    if (!type) throw new NotFound(action);
    return dispatcher.transition(id, type, body.detail);
  });

  app.get("/v1/reports/sla", async (req) => dispatcher.slaReport(tenantOf(req.headers)));

  app.register(async (scoped) => {
    scoped.get("/v1/live", { websocket: true }, (socket, req) => {
      const query = req.query as { tenant?: string; since?: string };
      let tenantId: string;
      try {
        tenantId = tenantOf({ "x-tenant-id": query.tenant });
      } catch {
        socket.close(4401, "tenant required");
        return;
      }
      // Replay missed events first, then go live: no gaps after a reconnect.
      const since = Number(query.since ?? 0);
      for (const s of dispatcher.events.readAll(since)) {
        if (dispatcher.job(s.event.jobId).tenantId === tenantId) socket.send(JSON.stringify({ seq: s.seq, ...s.event }));
      }
      const leave = hub.join(tenantId, socket);
      socket.on("close", leave);
    });
  });

  return app;
}
