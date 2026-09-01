import path from "node:path";
import { isIP } from "node:net";
import type { PacketCapture } from "@kar-mi/spirit-vale-tools-capture/capture";
import type {
  CaptureTargetStatus,
  CapturedFishNetPacket,
  CapturedLiteNetLibPacket,
} from "@kar-mi/spirit-vale-tools-capture";
import type { CaptureDevice, DesktopSettingsUpdate, DesktopState, LinuxCaptureMode } from "../shared/contracts.ts";
import { FishNetCaptureDecoder } from "./fishnet-capture-decoder.ts";
import { MarketContributor, type ContributorSnapshot } from "./contributor.ts";
import { errorMessage, isRecord, loadJson, writeJsonAtomic } from "./storage.ts";
import { errorLogFields, type AppLogger } from "./logger.ts";
import {
  createPacketCapture,
  getCaptureBackendMetadata,
  getCaptureStatus,
  listCaptureDevices,
  resolveCaptureDevice,
  setLinuxCaptureMode,
  type CaptureBackendMetadata,
} from "./capture/platform-capture.ts";
import type { CaptureBackendStatus, CaptureDeviceRecord } from "./capture/linux-pcap.ts";

interface DesktopSettings {
  schemaVersion: 1;
  contributionEnabled: boolean;
  deviceName: string | null;
  linuxCaptureMode: LinuxCaptureMode;
}

interface CaptureServiceDependencies {
  capture?: PacketCapture;
  getCaptureStatus?: typeof getCaptureStatus;
  listCaptureDevices?: typeof listCaptureDevices;
  resolveCaptureDevice?: typeof resolveCaptureDevice;
  captureBackendMetadata?: typeof getCaptureBackendMetadata;
  setLinuxCaptureMode?: typeof setLinuxCaptureMode;
  now?: () => Date;
  routeCheckIntervalMs?: number;
}

interface ResolvedCaptureDevice {
  device: CaptureDeviceRecord;
  usedFallback: boolean;
  detail?: string;
}

const defaultSettings = (): DesktopSettings => ({
  schemaVersion: 1,
  contributionEnabled: true,
  deviceName: null,
  linuxCaptureMode: "auto",
});
const UNRESOLVED_LINK_WARNING = "Market requests are visible, but linked responses are unresolved. Share this diagnostic state; restarting alone will not fix this capture path.";
const LATE_SESSION_WARNING = "ValeMarket started after Spirit Vale's current network session was already active. Leave ValeMarket running, fully close and relaunch Spirit Vale, then search the market again.";
const FRAGMENT_DROP_WARNING = "Some fragmented game messages were incomplete. Select the network adapter carrying Spirit Vale traffic directly, then search again.";
const CAPTURE_HEALTH_TIMEOUT_MS = 20_000;
const ROUTE_CHECK_INTERVAL_MS = 5_000;

export class CaptureService {
  private readonly capture: PacketCapture;
  private readonly fishNetDecoder: FishNetCaptureDecoder;
  private readonly captureStatusProvider: typeof getCaptureStatus;
  private readonly deviceProvider: typeof listCaptureDevices;
  private readonly adapterResolver: typeof resolveCaptureDevice;
  private readonly captureBackendMetadata: typeof getCaptureBackendMetadata;
  private readonly linuxCaptureModeSetter: typeof setLinuxCaptureMode;
  private readonly now: () => Date;
  private readonly routeCheckIntervalMs: number;
  private readonly settingsPath: string;
  private readonly contributorPath: string;
  private settings: DesktopSettings = defaultSettings();
  private contributor?: MarketContributor;
  private contributorState: ContributorSnapshot = {
    prepared: 0,
    uploaded: 0,
    queuedBatches: 0,
    marketEventsDecoded: 0,
    searchRequestsDecoded: 0,
    listingEventsDecoded: 0,
    listingsDecoded: 0,
    observationsNormalized: 0,
    normalizationDropped: 0,
    normalizationErrors: 0,
    duplicatesSuppressed: 0,
    lateSessionResponsesRecovered: 0,
    unresolvedInboundRpcLinks: 0,
  };
  private captureStatus: CaptureBackendStatus = { availability: "error", detail: "Checking packet capture…" };
  private gameDetected = false;
  private captureStartedWithGameActive = false;
  private preserveDecoderForNextStart = false;
  private packetsObserved = 0;
  private phase: DesktopState["phase"] = "disabled";
  private detail = "Starting contribution…";
  private warning?: string;
  private droppedFlows: DesktopState["droppedFlows"] = [];
  private resolvedDevice: CaptureDeviceRecord | undefined;
  private captureHealthWarning: string | undefined;
  private lastAttributedPacketAt: string | undefined;
  private lastAttributedPacketAtMs: number | undefined;
  private targetActiveAtMs: number | undefined;
  private automaticCaptureRestarts = 0;
  private routeMonitor: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private fragmentedMessagesReassembled = 0;
  private fragmentAssembliesDropped = 0;
  private objectSpawnPacketsObserved = 0;
  private objectSpawnsDecoded = 0;
  private bulkSpawnPacketsObserved = 0;
  private rpcLinkRegistrationsObserved = 0;
  private resolvedInboundRpcLinks = 0;
  private readonly unresolvedInboundRpcLinkIds = new Set<number>();
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDirectory: string,
    private readonly version: string,
    private readonly logger?: AppLogger,
    dependencies: CaptureServiceDependencies = {},
  ) {
    this.capture = dependencies.capture ?? createPacketCapture();
    this.captureStatusProvider = dependencies.getCaptureStatus ?? getCaptureStatus;
    this.deviceProvider = dependencies.listCaptureDevices ?? listCaptureDevices;
    this.adapterResolver = dependencies.resolveCaptureDevice ?? resolveCaptureDevice;
    this.captureBackendMetadata = dependencies.captureBackendMetadata ?? getCaptureBackendMetadata;
    this.linuxCaptureModeSetter = dependencies.setLinuxCaptureMode ?? setLinuxCaptureMode;
    this.now = dependencies.now ?? (() => new Date());
    this.routeCheckIntervalMs = dependencies.routeCheckIntervalMs ?? ROUTE_CHECK_INTERVAL_MS;
    this.settingsPath = path.join(dataDirectory, "settings.json");
    this.contributorPath = path.join(dataDirectory, "contributor-v2.json");
    this.fishNetDecoder = new FishNetCaptureDecoder({
      onPacket: (packet) => this.consume(packet),
      onWarning: (message) => {
        this.warning = message;
        this.logger?.warn("capture.decode.warning", { message });
      },
      onFragmentReassembled: () => { this.fragmentedMessagesReassembled += 1; },
      onFragmentDropped: () => {
        this.fragmentAssembliesDropped += 1;
        this.logger?.warn("capture.fragment.dropped", { dropped: this.fragmentAssembliesDropped });
      },
    });
    this.capture.on("started", () => {
      this.running = true;
      if (!this.preserveDecoderForNextStart) this.captureStartedWithGameActive = this.gameDetected;
      const decoderPreserved = this.preserveDecoderForNextStart;
      this.preserveDecoderForNextStart = false;
      this.phase = this.gameDetected ? "capturing" : "waiting-for-game";
      const adapter = this.resolvedDevice?.description || this.resolvedDevice?.name;
      this.detail = this.gameDetected
        ? `Observing game traffic${adapter ? ` on ${adapter}` : ""}`
        : `Waiting for Spirit Vale${adapter ? ` on ${adapter}` : ""}`;
      this.logger?.info("capture.started", { gameDetected: this.gameDetected, decoderPreserved });
    });
    this.capture.on("targetStatus", (status) => this.targetStatus(status));
    this.capture.on("liteNetPacket", (packet) => this.observeLiteNetPacket(packet));
    this.capture.on("warning", (message) => {
      this.warning = message;
      this.logger?.warn("capture.warning", { message });
    });
    this.capture.on("droppedFlows", (flows) => {
      this.droppedFlows = flows.map((flow) => ({ ...flow }));
      this.logger?.warn("capture.flows.dropped", {
        flows: flows.length,
        packets: flows.reduce((total, flow) => total + flow.packets, 0),
        gameTrafficFlows: flows.filter((flow) => flow.verdict === "game traffic").length,
      });
    });
    this.capture.on("error", (error) => {
      this.running = false;
      this.phase = "error";
      this.detail = "Packet capture stopped";
      this.warning = error.message;
      this.contributor?.setEnabled(false);
      this.logger?.error("capture.failed", errorLogFields(error));
    });
    this.capture.on("stopped", () => {
      this.running = false;
      this.gameDetected = false;
      this.targetActiveAtMs = undefined;
      this.resolvedDevice = undefined;
      if (!this.preserveDecoderForNextStart) this.fishNetDecoder.reset();
      this.logger?.info("capture.stopped", { decoderPreserved: this.preserveDecoderForNextStart });
    });
  }

  async start(): Promise<void> {
    this.settings = await loadJson(this.settingsPath, defaultSettings, parseSettings, (error) => {
      this.logger?.warn("state.load.invalid", { state: "settings", ...errorLogFields(error) });
    });
    this.linuxCaptureModeSetter(this.settings.linuxCaptureMode);
    this.contributor = await MarketContributor.load({
      statePath: this.contributorPath,
      collectorVersion: this.version,
      onState: (state) => { this.contributorState = state; },
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    });
    await this.refreshCaptureBackend();
    await this.reconcile();
    this.startRouteMonitor();
  }

  state(): DesktopState {
    const sessionSetupWarning = this.contributorState.searchRequestsDecoded > 0
      && this.contributorState.listingEventsDecoded === 0
      && this.contributorState.unresolvedInboundRpcLinks > 0
      ? this.captureStartedWithGameActive ? LATE_SESSION_WARNING : UNRESOLVED_LINK_WARNING
      : undefined;
    const fragmentDropWarning = this.contributorState.searchRequestsDecoded > 0
      && this.contributorState.listingEventsDecoded === 0
      && this.fragmentAssembliesDropped > 0
      ? FRAGMENT_DROP_WARNING
      : undefined;
    const warning = this.contributorState.warning ?? this.captureHealthWarning ?? fragmentDropWarning ?? sessionSetupWarning ?? this.warning;
    return {
      version: this.version,
      contributionEnabled: this.settings.contributionEnabled,
      deviceName: this.settings.deviceName,
      linuxCaptureMode: this.settings.linuxCaptureMode,
      ...(this.resolvedDevice === undefined ? {} : {
        captureAdapter: {
          name: this.resolvedDevice.name,
          description: this.resolvedDevice.description || this.resolvedDevice.name,
          selection: this.settings.deviceName === null ? "automatic" as const : "manual" as const,
          automaticCandidate: isAutomaticCandidate(this.resolvedDevice),
        },
      }),
      phase: this.phase,
      detail: this.detail,
      captureBackend: {
        ...this.captureBackendMetadata(),
        ...this.captureStatus,
      },
      gameDetected: this.gameDetected,
      captureStartedWithGameActive: this.captureStartedWithGameActive,
      packetsObserved: this.packetsObserved,
      ...(this.lastAttributedPacketAt === undefined ? {} : { lastAttributedPacketAt: this.lastAttributedPacketAt }),
      automaticCaptureRestarts: this.automaticCaptureRestarts,
      marketEventsDecoded: this.contributorState.marketEventsDecoded,
      lateSessionResponsesRecovered: this.contributorState.lateSessionResponsesRecovered,
      searchRequestsDecoded: this.contributorState.searchRequestsDecoded,
      listingEventsDecoded: this.contributorState.listingEventsDecoded,
      listingsDecoded: this.contributorState.listingsDecoded,
      observationsNormalized: this.contributorState.observationsNormalized,
      normalizationDropped: this.contributorState.normalizationDropped,
      normalizationErrors: this.contributorState.normalizationErrors,
      duplicatesSuppressed: this.contributorState.duplicatesSuppressed,
      unresolvedInboundRpcLinks: this.contributorState.unresolvedInboundRpcLinks,
      fragmentedMessagesReassembled: this.fragmentedMessagesReassembled,
      fragmentAssembliesDropped: this.fragmentAssembliesDropped,
      objectSpawnPacketsObserved: this.objectSpawnPacketsObserved,
      objectSpawnsDecoded: this.objectSpawnsDecoded,
      bulkSpawnPacketsObserved: this.bulkSpawnPacketsObserved,
      rpcLinkRegistrationsObserved: this.rpcLinkRegistrationsObserved,
      resolvedInboundRpcLinks: this.resolvedInboundRpcLinks,
      unresolvedInboundRpcLinkIds: [...this.unresolvedInboundRpcLinkIds],
      droppedFlows: this.droppedFlows.map((flow) => ({ ...flow })),
      observationsPrepared: this.contributorState.prepared,
      observationsUploaded: this.contributorState.uploaded,
      queuedBatches: this.contributorState.queuedBatches,
      ...(this.contributorState.latestObservationAt === undefined ? {} : { latestObservationAt: this.contributorState.latestObservationAt }),
      ...(this.contributorState.latestUploadAt === undefined ? {} : { latestUploadAt: this.contributorState.latestUploadAt }),
      ...(warning === undefined ? {} : { warning }),
    };
  }

  async devices(): Promise<CaptureDevice[]> {
    if (this.captureStatus.availability !== "ready") return [];
    const resolvedName = this.resolvedDevice?.name;
    return (await this.deviceProvider())
      .map((device) => ({ ...device, addresses: [...device.addresses], automaticCandidate: isAutomaticCandidate(device) }))
      .sort((left, right) => {
        const selectedOrder = Number(right.name === resolvedName) - Number(left.name === resolvedName);
        if (selectedOrder !== 0) return selectedOrder;
        const candidateOrder = Number(right.automaticCandidate) - Number(left.automaticCandidate);
        if (candidateOrder !== 0) return candidateOrder;
        return (left.description || left.name).localeCompare(right.description || right.name);
      });
  }

  async updateSettings(update: DesktopSettingsUpdate): Promise<DesktopState> {
    const deviceChanged = update.deviceName !== undefined && update.deviceName !== this.settings.deviceName;
    const linuxCaptureModeChanged = update.linuxCaptureMode !== undefined
      && update.linuxCaptureMode !== this.settings.linuxCaptureMode;
    if (update.contributionEnabled !== undefined) this.settings.contributionEnabled = update.contributionEnabled;
    if (update.deviceName !== undefined) this.settings.deviceName = update.deviceName;
    if (update.linuxCaptureMode !== undefined) {
      this.settings.linuxCaptureMode = update.linuxCaptureMode;
      this.linuxCaptureModeSetter(update.linuxCaptureMode);
    }
    this.logger?.info("settings.updated", {
      ...(update.contributionEnabled === undefined ? {} : { contributionEnabled: update.contributionEnabled }),
      ...(update.deviceName === undefined ? {} : { captureDevice: update.deviceName === null ? "automatic" : "configured" }),
      ...(update.linuxCaptureMode === undefined ? {} : { linuxCaptureMode: update.linuxCaptureMode }),
    });
    await writeJsonAtomic(this.settingsPath, this.settings);
    await this.refreshCaptureBackend();
    if ((deviceChanged || linuxCaptureModeChanged) && this.running) {
      this.logger?.info("capture.configuration.changed", {
        selection: this.settings.deviceName === null ? "automatic" : "manual",
        linuxCaptureMode: this.settings.linuxCaptureMode,
      });
      this.preserveDecoderForNextStart = this.gameDetected;
      try {
        await this.capture.stop();
      } catch (error) {
        this.preserveDecoderForNextStart = false;
        throw error;
      }
      this.running = false;
    }
    await this.reconcile();
    return this.state();
  }

  async restart(): Promise<DesktopState> {
    this.logger?.info("capture.restart.requested");
    await this.refreshCaptureBackend();
    if (this.running) await this.capture.stop();
    this.running = false;
    await this.reconcile();
    this.logger?.info("capture.restart.completed");
    return this.state();
  }

  async shutdown(): Promise<void> {
    if (this.routeMonitor !== undefined) {
      clearInterval(this.routeMonitor);
      this.routeMonitor = undefined;
    }
    this.logger?.info("capture.shutdown.started");
    if (this.running) {
      await this.capture.stop().catch((error) => {
        this.logger?.error("capture.shutdown.stop_failed", errorLogFields(error));
      });
    }
    this.contributor?.setEnabled(false);
    await this.contributor?.shutdown();
    this.logger?.info("capture.shutdown.completed");
  }

  private async refreshCaptureBackend(): Promise<void> {
    try {
      const status = await this.captureStatusProvider();
      this.captureStatus = {
        availability: status.availability,
        detail: status.detail,
        ...(status.version === undefined ? {} : { version: status.version }),
      };
      this.logger?.info("capture.backend.status", {
        ...this.captureBackendMetadata(),
        availability: status.availability,
        ...(status.version === undefined ? {} : { version: status.version }),
      });
    } catch (error) {
      this.captureStatus = { availability: "error", detail: errorMessage(error) };
      this.logger?.warn("capture.backend.status_failed", errorLogFields(error));
    }
  }

  private reconcile(): Promise<void> {
    this.reconcileChain = this.reconcileChain
      .catch((error) => {
        this.logger?.error("capture.reconcile.failed", errorLogFields(error));
      })
      .then(() => this.applyDesiredState());
    return this.reconcileChain;
  }

  private async applyDesiredState(): Promise<void> {
    if (!this.settings.contributionEnabled) {
      await this.stopCapture();
      this.phase = "disabled";
      this.detail = "Contribution is off";
      return;
    }
    if (this.captureStatus.availability !== "ready") {
      await this.stopCapture();
      this.phase = "capture-unavailable";
      this.detail = this.captureStatus.detail;
      return;
    }
    if (this.running) return;
    delete this.warning;
    this.contributor?.setEnabled(true);
    this.phase = "waiting-for-game";
    this.detail = "Starting packet capture…";
    this.logger?.info("capture.start.requested", { automaticDevice: this.settings.deviceName === null });
    try {
      const resolution = await this.resolveDesiredDevice();
      this.resolvedDevice = resolution.device;
      this.droppedFlows = [];
      if (resolution.usedFallback && resolution.detail) this.warning = resolution.detail;
      await this.capture.start({
        protocols: ["udp"],
        targetProcessName: "SpiritVale.exe",
        deviceName: resolution.device.name,
        decodeLiteNetLib: true,
      });
      this.running = true;
      this.logger?.info("capture.start.completed", {
        adapter: resolution.device.description || resolution.device.name,
        selection: this.settings.deviceName === null ? "automatic" : "manual",
        usedFallback: resolution.usedFallback,
      });
    } catch (error) {
      this.contributor?.setEnabled(false);
      this.phase = "error";
      this.detail = "Could not start packet capture";
      this.warning = errorMessage(error);
      this.logger?.error("capture.start.failed", errorLogFields(error));
    }
  }

  private async stopCapture(): Promise<void> {
    this.contributor?.setEnabled(false);
    this.preserveDecoderForNextStart = false;
    if (!this.running && this.capture.state === "stopped") return;
    await this.capture.stop().catch((error) => {
      this.warning = errorMessage(error);
      this.logger?.error("capture.stop.failed", errorLogFields(error));
    });
    this.running = false;
    this.gameDetected = false;
    this.captureStartedWithGameActive = false;
    this.resolvedDevice = undefined;
    this.targetActiveAtMs = undefined;
    this.captureHealthWarning = undefined;
  }

  private targetStatus(status: CaptureTargetStatus): void {
    const wasDetected = this.gameDetected;
    this.gameDetected = status.state === "active";
    if (wasDetected !== this.gameDetected) {
      this.logger?.info("capture.target.changed", { state: status.state });
      this.targetActiveAtMs = this.gameDetected ? this.now().getTime() : undefined;
      if (!this.gameDetected) {
        this.captureHealthWarning = undefined;
        this.captureStartedWithGameActive = false;
      }
    }
    if (!this.running) return;
    this.phase = this.gameDetected ? "capturing" : "waiting-for-game";
    const adapter = this.resolvedDevice?.description || this.resolvedDevice?.name;
    this.detail = this.gameDetected
      ? `Observing game traffic${adapter ? ` on ${adapter}` : ""}`
      : `Waiting for Spirit Vale${adapter ? ` on ${adapter}` : ""}`;
  }

  private observeLiteNetPacket(packet: CapturedLiteNetLibPacket): void {
    const now = this.now();
    this.lastAttributedPacketAt = now.toISOString();
    this.lastAttributedPacketAtMs = now.getTime();
    this.captureHealthWarning = undefined;
    this.fishNetDecoder.consume(packet);
  }

  private consume(packet: CapturedFishNetPacket): void {
    this.packetsObserved += 1;
    if (packet.packetName === "objectSpawn") {
      this.objectSpawnPacketsObserved += 1;
      if (packet.objectId !== undefined) this.objectSpawnsDecoded += 1;
      this.rpcLinkRegistrationsObserved += packet.rpcLinkRegistrations?.length ?? 0;
    } else if (packet.packetName === "bulkSpawnOrDespawn") {
      this.bulkSpawnPacketsObserved += 1;
    } else if (packet.packetName === "rpcLink" && packet.liteNetPacket.udpPacket.direction === "inbound") {
      if (packet.linkResolved === true) this.resolvedInboundRpcLinks += 1;
      else if (packet.linkResolved === false && packet.linkId !== undefined && this.unresolvedInboundRpcLinkIds.size < 16) {
        this.unresolvedInboundRpcLinkIds.add(packet.linkId);
      }
    }
    this.contributor?.consume(packet);
  }
  private startRouteMonitor(): void {
    if (this.routeMonitor !== undefined || this.routeCheckIntervalMs <= 0) return;
    this.routeMonitor = setInterval(() => this.scheduleAutomaticDeviceCheck(), this.routeCheckIntervalMs);
    this.routeMonitor.unref();
  }

  private scheduleAutomaticDeviceCheck(): void {
    this.reconcileChain = this.reconcileChain
      .catch((error) => {
        this.logger?.error("capture.reconcile.failed", errorLogFields(error));
      })
      .then(() => this.checkAutomaticDevice())
      .catch((error) => {
        this.logger?.warn("capture.route_check.failed", errorLogFields(error));
      });
  }

  private async checkAutomaticDevice(): Promise<void> {
    this.updateCaptureHealth();
    if (!this.running || this.settings.deviceName !== null || this.captureStatus.availability !== "ready") return;
    const resolution = await this.resolveDesiredDevice();
    if (resolution.device.name === this.resolvedDevice?.name) return;
    const previous = this.resolvedDevice;
    this.automaticCaptureRestarts += 1;
    this.logger?.info("capture.route.changed", {
      from: previous?.description || previous?.name || "unknown",
      to: resolution.device.description || resolution.device.name,
      restart: this.automaticCaptureRestarts,
    });
    this.preserveDecoderForNextStart = this.gameDetected;
    try {
      await this.capture.stop();
    } catch (error) {
      this.preserveDecoderForNextStart = false;
      throw error;
    }
    this.running = false;
    await this.applyDesiredState();
  }

  private updateCaptureHealth(): void {
    if (!this.running || !this.gameDetected || this.targetActiveAtMs === undefined) {
      this.captureHealthWarning = undefined;
      return;
    }
    if (this.lastAttributedPacketAtMs !== undefined && this.lastAttributedPacketAtMs >= this.targetActiveAtMs) {
      this.captureHealthWarning = undefined;
      return;
    }
    if (this.now().getTime() - this.targetActiveAtMs < CAPTURE_HEALTH_TIMEOUT_MS) return;
    const adapter = this.resolvedDevice?.description || this.resolvedDevice?.name || "the selected adapter";
    const warning = `Spirit Vale is running, but no attributed game traffic reached ${adapter}. A VPN or route optimizer may be using another adapter; select its active adapter below.`;
    if (warning !== this.captureHealthWarning) {
      this.logger?.warn("capture.health.no_traffic", {
        adapter,
        automaticDevice: this.settings.deviceName === null,
      });
    }
    this.captureHealthWarning = warning;
  }

  private async resolveDesiredDevice(): Promise<ResolvedCaptureDevice> {
    const devices = await this.deviceProvider();
    const automaticCandidates = devices.filter(isAutomaticCandidate);
    if (this.settings.deviceName !== null) {
      const requested = devices.find((device) => device.name === this.settings.deviceName);
      if (requested) return { device: requested, usedFallback: false };
      const fallback = await this.adapterResolver(automaticCandidates);
      if (!fallback.device) throw new Error("The saved capture adapter is unavailable and no active fallback adapter was found");
      return {
        ...fallback,
        device: fallback.device,
        usedFallback: true,
        detail: "The saved adapter is unavailable; capture is using the active default-route adapter",
      };
    }
    const resolution = await this.adapterResolver(automaticCandidates);
    if (!resolution.device) throw new Error("No active capture adapter with a routable address was found");
    return { ...resolution, device: resolution.device };
  }

}
function isAutomaticCandidate(device: CaptureDeviceRecord): boolean {
  return !device.loopback && device.addresses.some(isRoutableAddress);
}

function isRoutableAddress(address: string): boolean {
  const normalized = address.split("%", 1)[0]!.toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return normalized !== "0.0.0.0" && !normalized.startsWith("127.") && !normalized.startsWith("169.254.");
  if (version === 6) return normalized !== "::" && normalized !== "::1" && !normalized.startsWith("fe80:");
  return false;
}

function parseSettings(value: unknown): DesktopSettings {
  if (!isRecord(value) || value.schemaVersion !== 1) return defaultSettings();
  const linuxCaptureMode = value.linuxCaptureMode === "dumpcap" || value.linuxCaptureMode === "libpcap"
    ? value.linuxCaptureMode
    : "auto";
  return {
    schemaVersion: 1,
    contributionEnabled: value.contributionEnabled === true,
    deviceName: typeof value.deviceName === "string" && value.deviceName.length > 0 ? value.deviceName : null,
    linuxCaptureMode,
  };
}
