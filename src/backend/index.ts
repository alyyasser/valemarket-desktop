import { existsSync } from "node:fs";
import path from "node:path";
import type { DesktopSettingsUpdate } from "../shared/contracts.ts";
import { DESKTOP_API_PORT } from "../shared/contracts.ts";
import { CaptureService } from "./capture-service.ts";
import { NeutralinoClient } from "./neutralino-client.ts";
import { errorMessage, isRecord } from "./storage.ts";
import neutralinoConfig from "../../neutralino.config.json" with { type: "json" };

const applicationRoot = path.resolve(import.meta.dir, "../..");
const portable = existsSync(path.join(applicationRoot, ".valemarket-portable"));
const dataDirectory = portable
  ? path.join(applicationRoot, "data")
  : path.join(process.env.LOCALAPPDATA ?? applicationRoot, "ValeMarket Desktop");
const capture = new CaptureService(dataDirectory, neutralinoConfig.version);
await capture.start();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: DESKTOP_API_PORT,
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/v1/state") return json(capture.state(), 200, request);
      if (request.method === "GET" && url.pathname === "/v1/devices") return json({ devices: await capture.devices() }, 200, request);
      if (request.method === "PUT" && url.pathname === "/v1/settings") {
        const update = await settingsBody(request);
        return json(await capture.updateSettings(update), 200, request);
      }
      if (request.method === "POST" && url.pathname === "/v1/capture/restart") {
        return json(await capture.restart(), 200, request);
      }
      return json({ error: "not found" }, 404, request);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400, request);
    }
  },
});

let native: NeutralinoClient | undefined;
try {
  native = await NeutralinoClient.fromStdin();
  native.onClose(() => void shutdown());
  await native.call("app.broadcast", { event: "valeMarketBackendReady", data: { port: server.port } });
} catch (error) {
  console.warn(`[valemarket] Neutralino lifecycle connection unavailable: ${errorMessage(error)}`);
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await capture.shutdown();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
console.log(`[valemarket] backend ready on 127.0.0.1:${server.port}; data ${dataDirectory}`);

async function settingsBody(request: Request): Promise<DesktopSettingsUpdate> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("content-type must be application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 4096) throw new Error("settings request is too large");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("settings body must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "contributionEnabled" && key !== "deviceName") throw new Error(`unsupported setting ${key}`);
  }
  if (value.contributionEnabled !== undefined && typeof value.contributionEnabled !== "boolean") {
    throw new Error("contributionEnabled must be boolean");
  }
  if (value.deviceName !== undefined && value.deviceName !== null && typeof value.deviceName !== "string") {
    throw new Error("deviceName must be a string or null");
  }
  return {
    ...(value.contributionEnabled === undefined ? {} : { contributionEnabled: value.contributionEnabled as boolean }),
    ...(value.deviceName === undefined ? {} : { deviceName: value.deviceName as string | null }),
  };
}

function json(value: unknown, status: number, request: Request): Response {
  return Response.json(value, {
    status,
    headers: {
      ...corsHeaders(request),
      "cache-control": "no-store",
    },
  });
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = origin !== null && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin)
    ? origin
    : "http://localhost";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin",
  };
}
