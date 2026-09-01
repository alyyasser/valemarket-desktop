import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalLogger, errorLogFields } from "../src/backend/logger.ts";

let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe("local application logging", () => {
  test("writes structured records with errors and privacy redaction", async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "valemarket-logger-"));
    const logger = await LocalLogger.create(temporaryRoot, "1.2.3", {
      now: () => new Date("2026-09-01T12:34:56.000Z"),
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    const failure = new Error("upload failed", { cause: new Error("socket closed") });

    logger.info("app.ready", { port: 47831 });
    logger.error("contributor.upload.failed", {
      authorization: "Bearer top-secret",
      listing: { seller: "private" },
      message: "Bearer abc.def.ghi",
      ...errorLogFields(failure),
    });
    await logger.flush();

    const files = await readdir(path.join(temporaryRoot, "logs"));
    expect(files).toHaveLength(1);
    const lines = (await readFile(path.join(temporaryRoot, "logs", files[0]!), "utf8")).trim().split("\n");
    const records: unknown[] = lines.map((line) => JSON.parse(line) as unknown);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      at: "2026-09-01T12:34:56.000Z",
      sequence: 1,
      sessionId: logger.sessionId,
      version: "1.2.3",
      level: "info",
      event: "app.ready",
      data: { port: 47831 },
    });
    expect(records[1]).toMatchObject({
      sequence: 2,
      level: "error",
      event: "contributor.upload.failed",
      data: {
        authorization: "[REDACTED]",
        listing: "[REDACTED]",
        message: "Bearer [REDACTED]",
        errorName: "Error",
        errorMessage: "upload failed",
      },
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).toContain("socket closed");
    await logger.close();
  });

  test("rotates files and enforces bounded retention", async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "valemarket-logger-"));
    const logger = await LocalLogger.create(temporaryRoot, "1.2.3", {
      now: () => new Date("2026-09-01T12:34:56.000Z"),
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      maxFileBytes: 500,
      maxFiles: 3,
      maxTotalBytes: 10_000,
    });

    for (let index = 0; index < 12; index += 1) {
      logger.info("rotation.record", { index, message: "x".repeat(240) });
    }
    await logger.close();

    const files = (await readdir(path.join(temporaryRoot, "logs"))).filter((file) => file.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3);
    for (const file of files) {
      const lines = (await readFile(path.join(temporaryRoot, "logs", file), "utf8")).trim().split("\n");
      expect(lines.every((line) => {
        const record: unknown = JSON.parse(line);
        return typeof record === "object" && record !== null && "event" in record && record.event === "rotation.record";
      })).toBe(true);
    }
  });

  test("exports sanitized state with the current session logs", async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "valemarket-logger-"));
    const logger = await LocalLogger.create(temporaryRoot, "1.2.3", {
      now: () => new Date("2026-09-01T12:34:56.000Z"),
      sessionId: "12345678-abcd-4abc-8def-123456789abc",
    });
    logger.warn("capture.warning", { message: "adapter unavailable" });
    const logsDirectory = path.join(temporaryRoot, "logs");
    await writeFile(
      path.join(logsDirectory, `20260901T123455Z-${logger.sessionId}-999.jsonl`),
      "{\"event\":\"shell.ready\"}\n",
      "utf8",
    );
    await writeFile(
      path.join(logsDirectory, "20260901T123455Z-foreign-session-999.jsonl"),
      "{\"event\":\"unrelated\"}\n",
      "utf8",
    );

    const result = await logger.exportDiagnostics({
      phase: "error",
      installationToken: "z".repeat(43),
      observations: [{ seller: "private" }],
    });
    await logger.close();

    expect(result.logFiles).toBe(2);
    const exported = await readdir(result.path);
    expect(exported).toContain("desktop-state.json");
    expect(exported).toContain("manifest.json");
    expect(exported.filter((file) => file.endsWith(".jsonl"))).toHaveLength(2);
    expect(exported).not.toContain("20260901T123455Z-foreign-session-999.jsonl");
    const state = await readFile(path.join(result.path, "desktop-state.json"), "utf8");
    const manifest: unknown = JSON.parse(await readFile(path.join(result.path, "manifest.json"), "utf8"));
    expect(state).not.toContain("z".repeat(43));
    expect(state).not.toContain("private");
    expect(JSON.parse(state)).toEqual({
      phase: "error",
      installationToken: "[REDACTED]",
      observations: "[REDACTED]",
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      appVersion: "1.2.3",
      sessionId: logger.sessionId,
      logFiles: [expect.stringMatching(/\.jsonl$/), expect.stringMatching(/\.jsonl$/)],
    });
    expect(JSON.stringify(manifest)).not.toContain(temporaryRoot);
  });
});
