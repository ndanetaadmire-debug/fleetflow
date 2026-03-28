import { buildServer } from "./http/server.js";

const app = buildServer();
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
console.log(`fleetflow listening on :${port}`);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
