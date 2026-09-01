import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { DESKTOP_API_PORT } from "../shared/contracts.ts";
import { LocalLogger, errorLogFields } from "../backend/logger.ts";

const DESKTOP_API = `http://127.0.0.1:${DESKTOP_API_PORT}`;
const SOURCE_ROOT = path.resolve(app.getAppPath());
const BACKEND_START_TIMEOUT_MS = 15_000;

let backend: ChildProcessWithoutNullStreams | undefined;
let mainWindow: BrowserWindow | undefined;
let logger: LocalLogger | undefined;
let shuttingDown = false;

function applicationRoot(): string {
  return app.isPackaged ? path.dirname(process.execPath) : SOURCE_ROOT;
}

function dataDirectory(): string {
  const root = applicationRoot();
  if (process.platform === "win32" && existsSync(path.join(root, ".valemarket-portable"))) return path.join(root, "data");
  return process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? root, "ValeMarket Desktop")
    : app.getPath("userData");
}

function packagedPath(...segments: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : SOURCE_ROOT;
  return path.join(base, ...segments);
}

function startBackend(): ChildProcessWithoutNullStreams {
  const executable = packagedPath("extensions", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  const entrypoint = packagedPath("extensions", "backend", "index.js");
  const child = spawn(executable, ["--no-orphans", entrypoint], {
    cwd: applicationRoot(),
    env: {
      ...process.env,
      VALEMARKET_APP_ROOT: applicationRoot(),
      VALEMARKET_VERSION: app.getVersion(),
      VALEMARKET_DATA_DIR: dataDirectory(),
      VALEMARKET_SESSION_ID: logger?.sessionId,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.once("error", (error) => logger?.error("shell.backend.spawn_failed", errorLogFields(error)));
  child.once("exit", (code, signal) => {
    logger?.info("shell.backend.exited", { code, signal, shuttingDown });
    if (backend === child) backend = undefined;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (message: string) => {
    logger?.warn("shell.backend.stderr", { message: message.trim().slice(0, 2_000) });
  });
  return child;
}

async function waitForBackend(child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + BACKEND_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Desktop backend exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${DESKTOP_API}/v1/state`, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error(`Desktop backend did not become ready within ${BACKEND_START_TIMEOUT_MS / 1_000} seconds`);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "ValeMarket Desktop",
    width: 1280,
    height: 760,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: "#0f1411",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    void openExternal(url);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logger?.error("shell.renderer.gone", { reason: details.reason, exitCode: details.exitCode });
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  return window;
}

function preloadPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar", ".electron", "preload.cjs")
    : path.join(SOURCE_ROOT, ".electron", "preload.cjs");
}

async function openExternal(rawUrl: string): Promise<void> {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || (url.hostname !== "spiritvalers.com" && !url.hostname.endsWith(".spiritvalers.com"))) {
      logger?.warn("shell.external_url.blocked", { host: url.hostname, protocol: url.protocol });
      return;
    }
    await shell.openExternal(url.href);
  } catch (error) {
    logger?.warn("shell.external_url.failed", errorLogFields(error));
  }
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function loadApplication(window: BrowserWindow): Promise<void> {
  try {
    backend = startBackend();
    await waitForBackend(backend);
    const frontend = packagedPath("app-resources", "views", "main", "index.html");
    const developmentFrontend = path.join(SOURCE_ROOT, "resources", "views", "main", "index.html");
    await window.loadFile(app.isPackaged ? frontend : developmentFrontend);
    logger?.info("shell.ready", { backendPort: DESKTOP_API_PORT });
  } catch (error) {
    logger?.error("shell.start.failed", errorLogFields(error));
    const message = error instanceof Error ? error.message : String(error);
    const html = `<!doctype html><meta charset="utf-8"><title>ValeMarket could not start</title><style>body{margin:0;padding:48px;background:#0f1411;color:#d2dad4;font:16px system-ui}main{max-width:720px}h1{color:#e7ede8}code{color:#5fd39a}</style><main><h1>ValeMarket could not start</h1><p>${escapeHtml(message)}</p><p>Diagnostics were written to <code>${escapeHtml(path.join(dataDirectory(), "logs"))}</code>.</p></main>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  } finally {
    if (!window.isVisible()) window.show();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

async function stopBackend(): Promise<void> {
  const child = backend;
  backend = undefined;
  if (!child || child.exitCode !== null) return;
  const { promise: exited, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  child.stdin.end();
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null) child.kill();
}

ipcMain.handle("valemarket:open-diagnostics", async (_event, requestedPath: unknown) => {
  if (typeof requestedPath !== "string" || requestedPath.length > 4_096 || !path.isAbsolute(requestedPath)) {
    throw new Error("Invalid diagnostics path");
  }
  const diagnosticsRoot = path.resolve(dataDirectory(), "diagnostics");
  const resolved = path.resolve(requestedPath);
  if (resolved !== diagnosticsRoot && !resolved.startsWith(`${diagnosticsRoot}${path.sep}`)) {
    throw new Error("Path is outside the diagnostics directory");
  }
  if (!(await stat(resolved)).isDirectory()) throw new Error("Diagnostics path is not a directory");
  const result = await shell.openPath(resolved);
  if (result) throw new Error(result);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void (async () => {
    logger?.info("shell.shutdown.started");
    await stopBackend();
    logger?.info("shell.shutdown.completed");
    await logger?.close();
    app.exit(0);
  })();
});

process.on("uncaughtException", (error) => logger?.error("shell.fatal.uncaught_exception", errorLogFields(error)));
process.on("unhandledRejection", (error) => logger?.error("shell.fatal.unhandled_rejection", errorLogFields(error)));

void app.whenReady().then(async () => {
  try {
    logger = await LocalLogger.create(dataDirectory(), app.getVersion(), { component: "shell" });
    logger.info("shell.starting", { packaged: app.isPackaged });
  } catch (error) {
    console.error(`[valemarket] shell logging unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  mainWindow = createWindow();
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  await loadApplication(mainWindow);
});
