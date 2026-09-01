import {
  CString,
  dlopen,
  FFIType,
  read,
  toArrayBuffer,
  type Library,
  type Pointer,
} from "bun:ffi";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import type { LinuxCaptureMode } from "../../shared/contracts.ts";

export interface CaptureBackendStatus {
  availability: "ready" | "missing" | "error";
  detail: string;
  version?: string;
}

export interface CaptureDeviceRecord {
  name: string;
  description: string;
  addresses: string[];
  loopback: boolean;
}

export interface CapturedPacketRecord {
  capturedAt: Date;
  timestampTicks: bigint;
  data: Buffer;
  originalLength: number;
}

export interface CaptureSession {
  readonly device: CaptureDeviceRecord;
  readonly dataLink: number;
  nextPacket(): CapturedPacketRecord | undefined;
  close(): void;
}

const ERROR_BUFFER_SIZE = 512;
const PCAP_ERROR_PERM_DENIED = -8;
const MAX_CAPTURED_PACKET_SIZE = 16 * 1024 * 1024;
const PCAP_SYMBOLS = {
  pcap_lib_version: { args: [], returns: FFIType.cstring },
  pcap_findalldevs: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  pcap_freealldevs: { args: [FFIType.ptr], returns: FFIType.void },
  pcap_create: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.ptr },
  pcap_set_snaplen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  pcap_set_promisc: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  pcap_set_timeout: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  pcap_set_buffer_size: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  pcap_set_immediate_mode: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  pcap_activate: { args: [FFIType.ptr], returns: FFIType.i32 },
  pcap_datalink: { args: [FFIType.ptr], returns: FFIType.i32 },
  pcap_compile: { args: [FFIType.ptr, FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  pcap_setfilter: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  pcap_freecode: { args: [FFIType.ptr], returns: FFIType.void },
  pcap_setnonblock: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  pcap_next_ex: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  pcap_geterr: { args: [FFIType.ptr], returns: FFIType.cstring },
  pcap_close: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

type PcapLibrary = Library<typeof PCAP_SYMBOLS>;

export class LinuxPcapRuntime {
  private api?: PcapLibrary;
  private readyStatus: CaptureBackendStatus | undefined;
  private captureMode: LinuxCaptureMode;
  private activeMode: "dumpcap" | "libpcap" | undefined;

  constructor(captureMode: LinuxCaptureMode = "auto") {
    this.captureMode = captureMode;
  }

  setMode(captureMode: LinuxCaptureMode): boolean {
    if (captureMode === this.captureMode) return false;
    this.captureMode = captureMode;
    this.readyStatus = undefined;
    this.activeMode = undefined;
    return true;
  }

  get mode(): LinuxCaptureMode {
    return this.captureMode;
  }

  get effectiveMode(): "dumpcap" | "libpcap" | undefined {
    return this.activeMode;
  }

  async status(): Promise<CaptureBackendStatus> {
    if (this.readyStatus) return this.readyStatus;
    if (process.platform !== "linux") {
      return { availability: "error", detail: "libpcap capture is supported only on Linux" };
    }
    try {
      const api = this.load();
      const version = String(api.symbols.pcap_lib_version());
      const devices = this.enumerateDevices(api);
      if (devices.length === 0) {
        return { availability: "error", detail: "libpcap reported no captureable network adapters", version };
      }
      const dumpcap = findDumpcap();
      const dumpcapReady = dumpcap !== undefined && await probeDumpcap(dumpcap);
      if (this.captureMode === "dumpcap" && !dumpcapReady) {
        return {
          availability: "error",
          detail: "dumpcap mode is selected, but a working dumpcap executable was not found; install Wireshark or set VALEMARKET_DUMPCAP",
          version,
        };
      }
      const detail = this.captureMode === "dumpcap"
        ? "dumpcap is ready"
        : this.captureMode === "libpcap"
          ? "Direct libpcap is ready; packet access requires CAP_NET_RAW and CAP_NET_ADMIN"
          : dumpcapReady
            ? "Automatic capture is ready through dumpcap with direct libpcap fallback"
            : "Automatic capture is ready through direct libpcap; packet access requires CAP_NET_RAW and CAP_NET_ADMIN";
      this.readyStatus = { availability: "ready", detail, version };
      return this.readyStatus;
    } catch (error) {
      const detail = errorMessage(error);
      const missing = /cannot open shared object|no such file|library not found|dlopen/i.test(detail);
      return {
        availability: missing ? "missing" : "error",
        detail: missing ? "libpcap is not installed" : detail,
      };
    }
  }

  async listDevices(): Promise<CaptureDeviceRecord[]> {
    const status = await this.status();
    if (status.availability !== "ready") throw new Error(status.detail);
    return this.enumerateDevices(this.load());
  }

  async open(device: CaptureDeviceRecord, filter: string): Promise<CaptureSession> {
    const status = await this.status();
    if (status.availability !== "ready") throw new Error(status.detail);
    const dumpcap = findDumpcap();
    if (this.captureMode !== "libpcap" && dumpcap && await probeDumpcap(dumpcap)) {
      try {
        const session = await DumpcapSession.open(dumpcap, device, filter);
        this.activeMode = "dumpcap";
        return session;
      } catch (dumpcapError) {
        if (this.captureMode === "dumpcap") throw dumpcapError;
        try {
          const session = this.openDirect(device, filter);
          this.activeMode = "libpcap";
          return session;
        } catch (libpcapError) {
          throw new Error(`dumpcap failed (${errorMessage(dumpcapError)}); direct libpcap fallback failed (${errorMessage(libpcapError)})`);
        }
      }
    }
    const session = this.openDirect(device, filter);
    this.activeMode = "libpcap";
    return session;
  }

  private openDirect(device: CaptureDeviceRecord, filter: string): CaptureSession {
    const api = this.load();
    const errorBuffer = new Uint8Array(ERROR_BUFFER_SIZE);
    const handle = nullablePointer(api.symbols.pcap_create(cString(device.name), errorBuffer));
    if (!handle) throw new Error(readCStringBuffer(errorBuffer) || `libpcap could not open ${device.description}`);
    try {
      checkPcap(api.symbols.pcap_set_snaplen(handle, 65_535), handle, api, "set snapshot length");
      checkPcap(api.symbols.pcap_set_promisc(handle, 0), handle, api, "disable promiscuous mode");
      checkPcap(api.symbols.pcap_set_timeout(handle, 1), handle, api, "set capture timeout");
      checkPcap(api.symbols.pcap_set_buffer_size(handle, 10 * 1024 * 1024), handle, api, "set capture buffer size");
      checkPcap(api.symbols.pcap_set_immediate_mode(handle, 1), handle, api, "enable immediate mode");
      const activated = api.symbols.pcap_activate(handle);
      if (activated === PCAP_ERROR_PERM_DENIED) {
        throw new Error(`libpcap denied access to ${device.description}; install/configure dumpcap or grant the packaged Bun executable CAP_NET_RAW and CAP_NET_ADMIN: ${pcapError(api, handle)}`);
      }
      if (activated < 0) throw new Error(`libpcap could not activate ${device.description}: ${pcapError(api, handle)}`);
      const rawDataLink = api.symbols.pcap_datalink(handle);
      const program = new Uint8Array(16);
      if (api.symbols.pcap_compile(handle, program, cString(filter), 1, 0xffff_ffff) !== 0) {
        throw new Error(`libpcap rejected BPF filter "${filter}": ${pcapError(api, handle)}`);
      }
      try {
        checkPcap(api.symbols.pcap_setfilter(handle, program), handle, api, "apply BPF filter");
      } finally {
        api.symbols.pcap_freecode(program);
      }
      errorBuffer.fill(0);
      checkPcap(api.symbols.pcap_setnonblock(handle, 1, errorBuffer), handle, api, "enable nonblocking capture");
      return new DirectPcapSession(api, handle, device, rawDataLink);
    } catch (error) {
      api.symbols.pcap_close(handle);
      throw error;
    }
  }

  private enumerateDevices(api: PcapLibrary): CaptureDeviceRecord[] {
    const resultPointer = new Uint8Array(8);
    const errorBuffer = new Uint8Array(ERROR_BUFFER_SIZE);
    const result = api.symbols.pcap_findalldevs(resultPointer, errorBuffer);
    if (result !== 0) throw new Error(readCStringBuffer(errorBuffer) || "libpcap could not enumerate network adapters");
    const head = pointerFromBuffer(resultPointer);
    if (!head) return [];
    const devices: CaptureDeviceRecord[] = [];
    try {
      let current: Pointer | null = head;
      while (current) {
        const namePointer = nullablePointer(read.ptr(current, 8));
        const descriptionPointer = nullablePointer(read.ptr(current, 16));
        const addressHead = nullablePointer(read.ptr(current, 24));
        const flags = read.u32(current, 32);
        if (namePointer) {
          const name = new CString(namePointer).toString();
          devices.push({
            name,
            description: descriptionPointer ? new CString(descriptionPointer).toString() : name,
            addresses: readAddresses(addressHead),
            loopback: (flags & 1) !== 0 || name.toLowerCase().includes("loopback"),
          });
        }
        current = nullablePointer(read.ptr(current, 0));
      }
    } finally {
      api.symbols.pcap_freealldevs(head);
    }
    return devices;
  }

  private load(): PcapLibrary {
    if (this.api) return this.api;
    const requested = process.env.VALEMARKET_PCAP_LIBRARY;
    const candidates = requested ? [requested] : ["libpcap.so.1", "libpcap.so.0.8", "libpcap.so"];
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        this.api = dlopen(candidate, PCAP_SYMBOLS);
        return this.api;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("libpcap could not be loaded");
  }
}

class DirectPcapSession implements CaptureSession {
  private closed = false;
  readonly dataLink: number;

  constructor(
    private readonly api: PcapLibrary,
    private readonly handle: Pointer,
    readonly device: CaptureDeviceRecord,
    private readonly rawDataLink: number,
  ) {
    this.dataLink = normalizeDataLinkForPacketCapture(rawDataLink);
  }

  nextPacket(): CapturedPacketRecord | undefined {
    if (this.closed) return undefined;
    const headerPointer = new Uint8Array(8);
    const dataPointer = new Uint8Array(8);
    const result = this.api.symbols.pcap_next_ex(this.handle, headerPointer, dataPointer);
    if (result === 0) return undefined;
    if (result < 0) throw new Error(`libpcap capture failed: ${pcapError(this.api, this.handle)}`);
    const header = pointerFromBuffer(headerPointer);
    const data = pointerFromBuffer(dataPointer);
    if (!header || !data) throw new Error("libpcap returned an invalid packet pointer");
    const seconds = read.i64(header, 0);
    const microseconds = read.i64(header, 8);
    const capturedLength = read.u32(header, 16);
    const originalLength = read.u32(header, 20);
    if (capturedLength > MAX_CAPTURED_PACKET_SIZE) throw new Error(`libpcap returned an oversized packet (${capturedLength} bytes)`);
    const frame = Buffer.from(new Uint8Array(toArrayBuffer(data, 0, capturedLength), 0, capturedLength));
    return normalizedPacketRecord({
      capturedAt: new Date(Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000)),
      timestampTicks: seconds * 10_000_000n + microseconds * 10n,
      data: frame,
      originalLength,
    }, this.rawDataLink);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.api.symbols.pcap_close(this.handle);
  }
}

class DumpcapSession implements CaptureSession {
  private readonly packets: CapturedPacketRecord[] = [];
  private packetIndex = 0;
  private streamError: Error | undefined;
  private closed = false;

  private constructor(
    private readonly child: ChildProcessByStdio<null, Readable, Readable>,
    private readonly decoder: PcapStreamDecoder,
    readonly device: CaptureDeviceRecord,
  ) {}

  static async open(executable: string, device: CaptureDeviceRecord, filter: string): Promise<DumpcapSession> {
    const child = spawn(executable, ["-q", "-F", "pcap", "-i", device.name, "-f", filter, "-w", "-"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const decoder = new PcapStreamDecoder();
    const session = new DumpcapSession(child, decoder, device);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(new Error("dumpcap did not start within 10 seconds")), 10_000);
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        child.once("error", (error) => finish(error));
        child.once("exit", (code) => finish(new Error(stderr.trim() || `dumpcap exited before capture started (${code ?? "signal"})`)));
        child.stdout.on("data", (chunk: Buffer) => {
          try {
            session.packets.push(...decoder.feed(chunk));
            if (decoder.dataLink !== undefined) finish();
          } catch (error) {
            session.streamError = toError(error);
            finish(session.streamError);
          }
        });
      });
    } catch (error) {
      child.kill();
      throw error;
    }
    child.once("exit", (code) => {
      if (!session.closed && code !== 0) session.streamError = new Error(stderr.trim() || `dumpcap exited unexpectedly (${code ?? "signal"})`);
    });
    return session;
  }

  get dataLink(): number {
    if (this.decoder.dataLink === undefined) throw new Error("dumpcap did not provide a pcap data-link type");
    return this.decoder.dataLink;
  }

  nextPacket(): CapturedPacketRecord | undefined {
    if (this.streamError) {
      const error = this.streamError;
      this.streamError = undefined;
      throw error;
    }
    const packet = this.packets[this.packetIndex];
    if (!packet) return undefined;
    this.packetIndex += 1;
    if (this.packetIndex >= 1_024 && this.packetIndex * 2 >= this.packets.length) {
      this.packets.splice(0, this.packetIndex);
      this.packetIndex = 0;
    }
    return packet;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
    this.packets.length = 0;
    this.packetIndex = 0;
  }
}

export class PcapStreamDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private littleEndian = true;
  private nanosecondTimestamps = false;
  private rawDataLink?: number;
  dataLink?: number;

  feed(chunk: Buffer): CapturedPacketRecord[] {
    if (chunk.length > 0) this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.dataLink === undefined && !this.readGlobalHeader()) return [];
    const packets: CapturedPacketRecord[] = [];
    while (this.buffer.length >= 16) {
      const capturedLength = this.readUint32(8);
      const originalLength = this.readUint32(12);
      if (capturedLength > MAX_CAPTURED_PACKET_SIZE) throw new Error(`dumpcap returned an oversized packet (${capturedLength} bytes)`);
      if (this.buffer.length < 16 + capturedLength) break;
      const seconds = this.readUint32(0);
      const fraction = this.readUint32(4);
      const microseconds = this.nanosecondTimestamps ? Math.floor(fraction / 1_000) : fraction;
      packets.push(normalizedPacketRecord({
        capturedAt: new Date(seconds * 1_000 + Math.floor(microseconds / 1_000)),
        timestampTicks: BigInt(seconds) * 10_000_000n + BigInt(microseconds) * 10n,
        data: Buffer.from(this.buffer.subarray(16, 16 + capturedLength)),
        originalLength,
      }, this.rawDataLink!));
      this.buffer = this.buffer.subarray(16 + capturedLength);
    }
    return packets;
  }

  private readGlobalHeader(): boolean {
    if (this.buffer.length < 24) return false;
    const magic = this.buffer.subarray(0, 4).toString("hex");
    if (magic === "d4c3b2a1" || magic === "4d3cb2a1") this.littleEndian = true;
    else if (magic === "a1b2c3d4" || magic === "a1b23c4d") this.littleEndian = false;
    else throw new Error("dumpcap returned an invalid pcap stream");
    this.nanosecondTimestamps = magic === "4d3cb2a1" || magic === "a1b23c4d";
    this.rawDataLink = this.littleEndian ? this.buffer.readUInt32LE(20) : this.buffer.readUInt32BE(20);
    this.dataLink = normalizeDataLinkForPacketCapture(this.rawDataLink);
    this.buffer = this.buffer.subarray(24);
    return true;
  }

  private readUint32(offset: number): number {
    return this.littleEndian ? this.buffer.readUInt32LE(offset) : this.buffer.readUInt32BE(offset);
  }
}

export function normalizeDataLinkForPacketCapture(dataLink: number): number {
  if (dataLink === 101 || dataLink === 228 || dataLink === 229 || dataLink === 276) return 12;
  return dataLink;
}

export function normalizeCapturedFrame(data: Buffer, dataLink: number): Buffer {
  if (dataLink !== 276) return data;
  return data.length >= 20 ? data.subarray(20) : Buffer.alloc(0);
}

function normalizedPacketRecord(packet: CapturedPacketRecord, dataLink: number): CapturedPacketRecord {
  if (dataLink !== 276) return packet;
  const data = normalizeCapturedFrame(packet.data, dataLink);
  return { ...packet, data, originalLength: Math.max(0, packet.originalLength - 20) };
}

export function findDumpcap(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const requested = environment.VALEMARKET_DUMPCAP;
  if (requested) return existsSync(requested) ? requested : undefined;
  const directories = new Set<string>();
  for (const entry of (environment.PATH ?? "").split(delimiter)) {
    const trimmed = entry.trim();
    if (trimmed) directories.add(trimmed);
  }
  const home = environment.HOME;
  if (home) {
    directories.add(join(home, ".linuxbrew", "bin"));
    directories.add(join(home, "bin"));
    directories.add(join(home, ".local", "bin"));
  }
  for (const directory of [
    "/home/linuxbrew/.linuxbrew/bin", "/home/linuxbrew/.linuxbrew/sbin", "/usr/local/bin", "/usr/local/sbin", // localref-allow
    "/usr/bin", "/usr/sbin", "/bin", "/sbin",
  ]) directories.add(directory);
  for (const directory of directories) {
    const candidate = join(directory, "dumpcap");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function probeDumpcap(executable: string): Promise<boolean> {
  try {
    const child = spawn(executable, ["--version"], { stdio: "ignore", windowsHide: true });
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(ready);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(false);
      }, 3_000);
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
    });
  } catch {
    return false;
  }
}

function readAddresses(head: Pointer | null): string[] {
  const addresses: string[] = [];
  let current = head;
  while (current) {
    const socketAddress = nullablePointer(read.ptr(current, 8));
    const family = socketAddress ? read.u16(socketAddress, 0) : 0;
    if (socketAddress && family === 2) {
      addresses.push(`${read.u8(socketAddress, 4)}.${read.u8(socketAddress, 5)}.${read.u8(socketAddress, 6)}.${read.u8(socketAddress, 7)}`);
    } else if (socketAddress && family === 10) {
      const bytes = Array.from({ length: 16 }, (_, index) => read.u8(socketAddress, 8 + index));
      addresses.push(formatIpv6(bytes));
    }
    current = nullablePointer(read.ptr(current, 0));
  }
  return addresses;
}

function formatIpv6(bytes: readonly number[]): string {
  const groups = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== "0") { index += 1; continue; }
    let end = index;
    while (end < groups.length && groups[end] === "0") end += 1;
    if (end - index > bestLength) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  if (bestLength < 2) return groups.join(":");
  const before = groups.slice(0, bestStart).join(":");
  const after = groups.slice(bestStart + bestLength).join(":");
  if (!before && !after) return "::";
  if (!before) return `::${after}`;
  if (!after) return `${before}::`;
  return `${before}::${after}`;
}

function pcapError(api: PcapLibrary, handle: Pointer): string {
  return String(api.symbols.pcap_geterr(handle)) || "unknown libpcap error";
}

function checkPcap(result: number, handle: Pointer, api: PcapLibrary, operation: string): void {
  if (result !== 0) throw new Error(`libpcap could not ${operation}: ${pcapError(api, handle)}`);
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf8");
}

function pointerFromBuffer(buffer: Uint8Array): Pointer | null {
  const value = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getBigUint64(0, true);
  return value === 0n ? null : Number(value) as Pointer;
}

function nullablePointer(value: number | bigint | Pointer | null): Pointer | null {
  return value === null || value === 0 || value === 0n ? null : Number(value) as Pointer;
}

function readCStringBuffer(buffer: Uint8Array): string {
  const end = buffer.indexOf(0);
  return new TextDecoder().decode(buffer.subarray(0, end < 0 ? buffer.length : end));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
