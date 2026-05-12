import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Dispatcher } from "../src/dispatch/dispatcher.js";
import { buildServer } from "../src/http/server.js";
import { HOUR, ROSEBANK, SANDTON, T0 } from "./fixtures.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

async function start() {
  const app = buildServer(new Dispatcher({ now: () => T0 }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  close = () => app.close();
  const addr = app.server.address() as { port: number };
  return { app, base: `127.0.0.1:${addr.port}` };
}

const H = (tenant = "acme") => ({ "x-tenant-id": tenant, "content-type": "application/json" });

describe("HTTP + WebSocket", () => {
  it("streams tenant-scoped live events and replays missed ones", async () => {
    const { app, base } = await start();
    await app.inject({ method: "POST", url: "/v1/drivers", headers: H(), payload: { id: "d1", name: "Thabo", location: SANDTON, shiftEndsAt: T0 + 8 * HOUR } });

    const ws = new WebSocket(`ws://${base}/v1/live?tenant=acme`);
    const spy = new WebSocket(`ws://${base}/v1/live?tenant=globex`);
    const received: Array<{ type: string; seq: number }> = [];
    const spied: unknown[] = [];
    ws.on("message", (m) => received.push(JSON.parse(String(m))));
    spy.on("message", (m) => spied.push(m));
    await Promise.all([new Promise((r) => ws.once("open", r)), new Promise((r) => spy.once("open", r))]);

    const created = await app.inject({ method: "POST", url: "/v1/jobs", headers: H(), payload: { location: ROSEBANK, dueBy: T0 + HOUR } });
    expect(created.statusCode).toBe(201);
    const dispatched = (await app.inject({ method: "POST", url: "/v1/dispatch", headers: H(), payload: {} })).json();
    expect(dispatched.assignments).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 100));
    expect(received.map((e) => e.type)).toEqual(["JobCreated", "JobAssigned"]);
    expect(spied).toEqual([]); // other tenant sees nothing

    // Reconnect with ?since: only events after seq 1 are replayed.
    const resumed = new WebSocket(`ws://${base}/v1/live?tenant=acme&since=1`);
    const replayed: Array<{ type: string }> = [];
    resumed.on("message", (m) => replayed.push(JSON.parse(String(m))));
    await new Promise((r) => resumed.once("open", r));
    await new Promise((r) => setTimeout(r, 100));
    expect(replayed.map((e) => e.type)).toEqual(["JobAssigned"]);

    for (const s of [ws, spy, resumed]) s.close();
  });

  it("enforces tenancy, validation and lifecycle rules over HTTP", async () => {
    const { app } = await start();
    expect((await app.inject({ method: "GET", url: "/v1/jobs" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/jobs", headers: H(), payload: { location: { lat: 999, lng: 0 }, dueBy: 1 } })).statusCode).toBe(400);

    const job = (await app.inject({ method: "POST", url: "/v1/jobs", headers: H(), payload: { location: ROSEBANK, dueBy: T0 + HOUR } })).json();
    expect((await app.inject({ method: "GET", url: `/v1/jobs/${job.id}/history`, headers: H("globex") })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/jobs/${job.id}/complete`, headers: H(), payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/v1/jobs/${job.id}/cancel`, headers: H(), payload: { detail: "customer cancelled" } })).json().status).toBe("cancelled");
  });
});
