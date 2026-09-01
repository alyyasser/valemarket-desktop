import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findDumpcap,
  normalizeCapturedFrame,
  normalizeDataLinkForPacketCapture,
  PcapStreamDecoder,
} from "../src/backend/capture/linux-pcap.ts";
import { matchesLinuxProcessName, parseProcNetTable } from "../src/backend/capture/linux-target-provider.ts";
import { parseProcDefaultRoute, parseProcIpv6DefaultRoute } from "../src/backend/capture/platform-capture.ts";

let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe("Linux packet capture compatibility", () => {
  test("normalizes Linux raw-IP and cooked-v2 link types for the shared decoder", () => {
    expect(normalizeDataLinkForPacketCapture(101)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(228)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(229)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(276)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(113)).toBe(113);
  });

  test("decodes fragmented dumpcap streams and strips Linux SLL2 headers", () => {
    const ipPacket = Buffer.from([0x45, 0, 0, 20, 0, 0, 0, 0, 64, 17, 0, 0, 127, 0, 0, 1, 127, 0, 0, 1]);
    const cookedHeader = Buffer.alloc(20);
    cookedHeader.writeUInt16BE(0x0800, 0);
    const stream = pcapStream(276, Buffer.concat([cookedHeader, ipPacket]));
    const decoder = new PcapStreamDecoder();

    expect(decoder.feed(stream.subarray(0, 17))).toEqual([]);
    const packets = decoder.feed(stream.subarray(17));

    expect(decoder.dataLink).toBe(12);
    expect(packets).toHaveLength(1);
    expect(packets[0]!.data).toEqual(ipPacket);
    expect(packets[0]!.originalLength).toBe(ipPacket.length);
    expect(packets[0]!.capturedAt.toISOString()).toBe("2023-11-14T22:13:20.250Z");
  });

  test("leaves ordinary Ethernet and raw-IP frames unchanged", () => {
    const frame = Buffer.from([0x45, 1, 2, 3]);
    expect(normalizeCapturedFrame(frame, 1)).toBe(frame);
    expect(normalizeCapturedFrame(frame, 101)).toBe(frame);
    expect(normalizeCapturedFrame(Buffer.alloc(12), 276)).toEqual(Buffer.alloc(0));
  });

  test("selects the lowest-metric active default route", () => {
    const table = [
      "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask",
      "eth0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000",
      "tailscale0\t00000000\t00000000\t0001\t0\t0\t5\t00000000",
      "down0\t00000000\t00000000\t0000\t0\t0\t1\t00000000",
    ].join("\n");
    expect(parseProcDefaultRoute(table)).toBe("tailscale0");
  });

  test("falls back to an active IPv6 default route", () => {
    const zero = "0".repeat(32);
    const table = [
      `${zero} 00 ${zero} 00 ${zero} 00000064 00000000 00000000 00000001 eth0`,
      `${zero} 00 ${zero} 00 ${zero} 00000005 00000000 00000000 00000001 tun0`,
    ].join("\n");
    expect(parseProcIpv6DefaultRoute(table)).toBe("tun0");
  });

  test("finds dumpcap from PATH and an explicit override", async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "valemarket-linux-capture-"));
    const bin = path.join(temporaryRoot, "bin");
    await mkdir(bin);
    const executable = path.join(bin, "dumpcap");
    await writeFile(executable, "");

    expect(findDumpcap({ PATH: bin })).toBe(executable);
    expect(findDumpcap({ VALEMARKET_DUMPCAP: executable, PATH: "" })).toBe(executable);
    expect(findDumpcap({ VALEMARKET_DUMPCAP: path.join(bin, "missing"), PATH: "" })).toBeUndefined();
  });
});

describe("Linux process-scoped attribution", () => {
  test("recognizes native and Proton executable paths", () => {
    expect(matchesLinuxProcessName("SpiritVale.exe", "SpiritVale.exe\n", "Z:\\games\\SpiritVale.exe\0-windowed\0")).toBe(true);
    expect(matchesLinuxProcessName("SpiritVale.exe", "wine64-preloader\n", "/usr/bin/wine64-preloader\0Z:\\games\\SpiritVale.exe\0")).toBe(true);
    expect(matchesLinuxProcessName("SpiritVale.exe", "other-game\n", "/games/other-game\0")).toBe(false);
  });

  test("parses only sockets owned by the target process", () => {
    const table = [
      " sl  local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode",
      " 46: 0100007F:C350 00000000:0000 07 00000000:00000000 00:00000000 00000000 1000 0 12345",
      " 47: 00000000:9999 00000000:0000 07 00000000:00000000 00:00000000 00000000 1000 0 99999",
    ].join("\n");
    expect(parseProcNetTable("udp", false, table, 42, new Set(["12345"]))).toEqual([
      { protocol: "udp", address: "127.0.0.1", port: 50_000, processId: 42 },
    ]);
  });
});

function pcapStream(dataLink: number, packet: Buffer): Buffer {
  const globalHeader = Buffer.alloc(24);
  globalHeader.writeUInt32LE(0xa1b2c3d4, 0);
  globalHeader.writeUInt16LE(2, 4);
  globalHeader.writeUInt16LE(4, 6);
  globalHeader.writeUInt32LE(65_535, 16);
  globalHeader.writeUInt32LE(dataLink, 20);
  const packetHeader = Buffer.alloc(16);
  packetHeader.writeUInt32LE(1_700_000_000, 0);
  packetHeader.writeUInt32LE(250_000, 4);
  packetHeader.writeUInt32LE(packet.length, 8);
  packetHeader.writeUInt32LE(packet.length, 12);
  return Buffer.concat([globalHeader, packetHeader, packet]);
}
