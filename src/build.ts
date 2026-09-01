import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const resources = path.join(root, "resources");
const viewOutput = path.join(resources, "views", "main");
const extensionOutput = path.join(root, "extensions", "backend");
const binaryOutput = path.join(root, "extensions", "bin");
const electronOutput = path.join(root, ".electron");

await Promise.all([
  rm(resources, { recursive: true, force: true }),
  rm(path.join(root, "extensions"), { recursive: true, force: true }),
  rm(electronOutput, { recursive: true, force: true }),
]);
await Promise.all([
  mkdir(viewOutput, { recursive: true }),
  mkdir(extensionOutput, { recursive: true }),
  mkdir(binaryOutput, { recursive: true }),
  mkdir(electronOutput, { recursive: true }),
]);

await bundle(path.join(root, "src", "backend", "index.ts"), extensionOutput);
await Promise.all([
  bundleNode(path.join(root, "src", "electron", "main.ts"), electronOutput, "main.cjs"),
  bundleNode(path.join(root, "src", "electron", "preload.ts"), electronOutput, "preload.cjs"),
]);
await Promise.all([
  copyFile(path.join(root, "src", "frontend", "index.html"), path.join(viewOutput, "index.html")),
  copyFile(path.join(root, "assets", "catalog.json"), path.join(viewOutput, "catalog.json")),
  copyFile(path.join(root, "assets", "favicon.ico"), path.join(resources, "favicon.ico")),
  copyFile(process.execPath, path.join(binaryOutput, process.platform === "win32" ? "bun.exe" : "bun")),
  cp(path.join(root, "assets", "fonts"), path.join(viewOutput, "fonts"), { recursive: true }),
  cp(path.join(root, "assets", "icons"), path.join(viewOutput, "icons"), { recursive: true }),
]);
console.log(`ValeMarket Desktop prepared in ${root}`);

async function bundle(entrypoint: string, outdir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "external",
    naming: "index.[ext]",
  });
  if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entrypoint}`);
}

async function bundleNode(entrypoint: string, outdir: string, filename: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "node",
    format: "cjs",
    minify: false,
    sourcemap: "external",
    naming: filename,
    external: ["electron"],
  });
  if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entrypoint}`);
}
