import { existsSync } from "node:fs";
import path from "node:path";
import type { DesktopSettingsUpdate, DesktopState } from "../shared/contracts.ts";
import { DESKTOP_API_PORT } from "../shared/contracts.ts";
import { CaptureService } from "./capture-service.ts";
import { LocalLogger, errorLogFields } from "./logger.ts";
import { errorMessage, isRecord } from "./storage.ts";
import packageMetadata from "../../package.json" with { type: "json" };

interface ClientLogEvent {
  level: "warn" | "error";
  event: string;
  message: string;
  stack?: string;
}

const CLIENT_LOG_EVENTS: Record<string, true> = {
  "frontend.diagnostics.export_failed": true,
  "frontend.market.load_failed": true,
  "frontend.native.init_failed": true,
  "frontend.runtime.error": true,
  "frontend.runtime.unhandled_rejection": true,
};

const applicationRoot = path.resolve(process.env.VALEMARKET_APP_ROOT ?? path.resolve(import.meta.dir, "../.."));
const applicationVersion = process.env.VALEMARKET_VERSION ?? packageMetadata.version;
const portable = process.platform === "win32" && existsSync(path.join(applicationRoot, ".valemarket-portable"));
const dataDirectory = process.env.VALEMARKET_DATA_DIR
  ? path.resolve(process.env.VALEMARKET_DATA_DIR)
  : portable
    ? path.join(applicationRoot, "data")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? applicationRoot, "ValeMarket Desktop")
      : path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? applicationRoot, ".local", "share"), "valemarket-desktop");
const logger = await LocalLogger.create(dataDirectory, applicationVersion, {
  component: "backend",
  ...(process.env.VALEMARKET_SESSION_ID ? { sessionId: process.env.VALEMARKET_SESSION_ID } : {}),
});
logger.info("app.starting", { portable });
const capture = new CaptureService(dataDirectory, applicationVersion, logger);
try {
  await capture.start();
} catch (error) {
  logger.error("app.start.failed", errorLogFields(error));
  await logger.close().catch((logError) => {
    console.error(`[valemarket] could not close failed startup log: ${errorMessage(logError)}`);
  });
  throw error;
}

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
      if (request.method === "POST" && url.pathname === "/v1/logs/client") {
        const event = await clientLogBody(request);
        const fields = { message: event.message, ...(event.stack === undefined ? {} : { stack: event.stack }) };
        if (event.level === "error") logger.error(event.event, fields);
        else logger.warn(event.event, fields);
        return new Response(null, {
          status: 204,
          headers: { ...corsHeaders(request), "cache-control": "no-store" },
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/diagnostics/export") {
        await emptyObjectBody(request);
        return json(await logger.exportDiagnostics(privacySafeDiagnosticState(capture.state())), 201, request);
      }
      return json({ error: "not found" }, 404, request);
    } catch (error) {
      logger.warn("api.request.failed", {
        method: request.method,
        path: url.pathname,
        ...errorLogFields(error),
      });
      const status = url.pathname === "/v1/diagnostics/export" ? 500 : 400;
      return json({ error: errorMessage(error) }, status, request);
    }
  },
});

let stopping = false;
let failing = false;

async function shutdown(reason: string): Promise<void> {
  if (stopping || failing) return;
  stopping = true;
  logger.info("app.shutdown.started", { reason });
  server.stop(true);
  await capture.shutdown().catch((error) => {
    logger.error("app.shutdown.capture_failed", errorLogFields(error));
  });
  logger.info("app.shutdown.completed");
  await logger.close().catch((error) => {
    console.error(`[valemarket] local log close failed: ${errorMessage(error)}`);
  });
  process.exit(0);
}

async function fail(event: string, error: unknown): Promise<void> {
  if (failing || stopping) return;
  failing = true;
  logger.error(event, errorLogFields(error));
  server.stop(true);
  await capture.shutdown().catch((shutdownError) => {
    logger.error("app.fatal.capture_shutdown_failed", errorLogFields(shutdownError));
  });
  await logger.close().catch((logError) => {
    console.error(`[valemarket] local log close failed after fatal error: ${errorMessage(logError)}`);
  });
  process.exit(1);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => void fail("app.fatal.uncaught_exception", error));
process.on("unhandledRejection", (error) => void fail("app.fatal.unhandled_rejection", error));

process.stdin.resume();
process.stdin.on("end", () => void shutdown("parent-stdin-closed"));
logger.info("app.ready", { port: server.port });
console.log(`[valemarket] backend ready on 127.0.0.1:${server.port}; data ${dataDirectory}`);

async function settingsBody(request: Request): Promise<DesktopSettingsUpdate> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("content-type must be application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 4096) throw new Error("settings request is too large");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("settings body must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "contributionEnabled" && key !== "deviceName" && key !== "linuxCaptureMode") {
      throw new Error(`unsupported setting ${key}`);
    }
  }
  if (value.contributionEnabled !== undefined && typeof value.contributionEnabled !== "boolean") {
    throw new Error("contributionEnabled must be boolean");
  }
  if (value.deviceName !== undefined && value.deviceName !== null && typeof value.deviceName !== "string") {
    throw new Error("deviceName must be a string or null");
  }
  if (value.linuxCaptureMode !== undefined
      && value.linuxCaptureMode !== "auto"
      && value.linuxCaptureMode !== "dumpcap"
      && value.linuxCaptureMode !== "libpcap") {
    throw new Error("linuxCaptureMode must be auto, dumpcap, or libpcap");
  }
  return {
    ...(value.contributionEnabled === undefined ? {} : { contributionEnabled: value.contributionEnabled as boolean }),
    ...(value.deviceName === undefined ? {} : { deviceName: value.deviceName as string | null }),
    ...(value.linuxCaptureMode === undefined ? {} : { linuxCaptureMode: value.linuxCaptureMode }),
  };
}

async function clientLogBody(request: Request): Promise<ClientLogEvent> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("content-type must be application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 8_192) throw new Error("client log request is too large");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("client log body must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "level" && key !== "event" && key !== "message" && key !== "stack") {
      throw new Error(`unsupported client log field ${key}`);
    }
  }
  if (value.level !== "warn" && value.level !== "error") throw new Error("unsupported client log level");
  if (typeof value.event !== "string" || CLIENT_LOG_EVENTS[value.event] !== true) throw new Error("unsupported client log event");
  if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > 2_000) {
    throw new Error("client log message must contain 1 to 2000 characters");
  }
  if (value.stack !== undefined && (typeof value.stack !== "string" || value.stack.length > 4_000)) {
    throw new Error("client log stack is too large");
  }
  return {
    level: value.level,
    event: value.event,
    message: value.message,
    ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
  };
}

async function emptyObjectBody(request: Request): Promise<void> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("content-type must be application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 64) throw new Error("diagnostics request is too large");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || Object.keys(value).length > 0) throw new Error("diagnostics body must be an empty object");
}

function privacySafeDiagnosticState(state: DesktopState): unknown {
  const { deviceName, captureAdapter, droppedFlows, ...safeState } = state;
  return {
    ...safeState,
    deviceConfigured: deviceName !== null,
    ...(captureAdapter === undefined ? {} : {
      captureAdapter: {
        selection: captureAdapter.selection,
        automaticCandidate: captureAdapter.automaticCandidate,
      },
    }),
    droppedFlows: droppedFlows.map(({ packets, verdict }) => ({ packets, verdict })),
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
  const allowed = origin === "null"
    ? "null"
    : origin !== null && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin)
      ? origin
      : "http://localhost";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin",
  };
}
