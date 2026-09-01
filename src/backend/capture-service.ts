import path from "node:path";
import { PacketCapture, getNpcapStatus, listNpcapDevices, type NpcapDevice } from "@kar-mi/spirit-vale-tools-capture/capture";
import type { CaptureTargetStatus, CapturedFishNetPacket } from "@kar-mi/spirit-vale-tools-capture";
import type { DesktopSettingsUpdate, DesktopState } from "../shared/contracts.ts";
import { FishNetCaptureDecoder } from "./fishnet-capture-decoder.ts";
import { MarketContributor, type ContributorSnapshot } from "./contributor.ts";
import { errorMessage, isRecord, loadJson, writeJsonAtomic } from "./storage.ts";
import { errorLogFields, type AppLogger } from "./logger.ts";

interface DesktopSettings {
  schemaVersion: 1;
  contributionEnabled: boolean;
  deviceName: string | null;
}

const defaultSettings = (): DesktopSettings => ({ schemaVersion: 1, contributionEnabled: true, deviceName: null });
const UNRESOLVED_LINK_WARNING = "Market requests are visible, but linked responses are unresolved. Share this diagnostic state; restarting alone will not fix this capture path.";
const FRAGMENT_DROP_WARNING = "Some fragmented game messages were incomplete. Select the network adapter carrying Spirit Vale traffic directly, then search again.";

export class CaptureService {
  private readonly capture = new PacketCapture();
  private readonly fishNetDecoder: FishNetCaptureDecoder;
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
    unresolvedInboundRpcLinks: 0,
  };
  private npcap: DesktopState["npcap"] = { availability: "error", detail: "Checking Npcap…" };
  private gameDetected = false;
  private packetsObserved = 0;
  private phase: DesktopState["phase"] = "disabled";
  private detail = "Starting contribution…";
  private warning?: string;
  private droppedFlows: DesktopState["droppedFlows"] = [];
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
  ) {
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
      this.phase = this.gameDetected ? "capturing" : "waiting-for-game";
      this.detail = this.gameDetected ? "Observing game traffic" : "Waiting for Spirit Vale";
      this.logger?.info("capture.started", { gameDetected: this.gameDetected });
    });
    this.capture.on("targetStatus", (status) => this.targetStatus(status));
    this.capture.on("liteNetPacket", (packet) => this.fishNetDecoder.consume(packet));
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
      this.fishNetDecoder.reset();
      this.logger?.info("capture.stopped");
    });
  }

  async start(): Promise<void> {
    this.settings = await loadJson(this.settingsPath, defaultSettings, parseSettings, (error) => {
      this.logger?.warn("state.load.invalid", { state: "settings", ...errorLogFields(error) });
    });
    this.contributor = await MarketContributor.load({
      statePath: this.contributorPath,
      collectorVersion: this.version,
      onState: (state) => { this.contributorState = state; },
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    });
    await this.refreshNpcap();
    await this.reconcile();
  }

  state(): DesktopState {
    const sessionSetupWarning = this.contributorState.searchRequestsDecoded > 0
      && this.contributorState.listingEventsDecoded === 0
      && this.contributorState.unresolvedInboundRpcLinks > 0
      ? UNRESOLVED_LINK_WARNING
      : undefined;
    const fragmentDropWarning = this.contributorState.searchRequestsDecoded > 0
      && this.contributorState.listingEventsDecoded === 0
      && this.fragmentAssembliesDropped > 0
      ? FRAGMENT_DROP_WARNING
      : undefined;
    const warning = this.contributorState.warning ?? fragmentDropWarning ?? sessionSetupWarning ?? this.warning;
    return {
      version: this.version,
      contributionEnabled: this.settings.contributionEnabled,
      deviceName: this.settings.deviceName,
      phase: this.phase,
      detail: this.detail,
      npcap: this.npcap,
      gameDetected: this.gameDetected,
      packetsObserved: this.packetsObserved,
      marketEventsDecoded: this.contributorState.marketEventsDecoded,
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

  async devices(): Promise<NpcapDevice[]> {
    if (this.npcap.availability !== "ready") return [];
    return listNpcapDevices();
  }

  async updateSettings(update: DesktopSettingsUpdate): Promise<DesktopState> {
    if (update.contributionEnabled !== undefined) this.settings.contributionEnabled = update.contributionEnabled;
    if (update.deviceName !== undefined) this.settings.deviceName = update.deviceName;
    this.logger?.info("settings.updated", {
      ...(update.contributionEnabled === undefined ? {} : { contributionEnabled: update.contributionEnabled }),
      ...(update.deviceName === undefined ? {} : { captureDevice: update.deviceName === null ? "automatic" : "configured" }),
    });
    await writeJsonAtomic(this.settingsPath, this.settings);
    await this.refreshNpcap();
    await this.reconcile();
    return this.state();
  }

  async restart(): Promise<DesktopState> {
    this.logger?.info("capture.restart.requested");
    await this.refreshNpcap();
    if (this.running) await this.capture.stop();
    this.running = false;
    await this.reconcile();
    this.logger?.info("capture.restart.completed");
    return this.state();
  }

  async shutdown(): Promise<void> {
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

  private async refreshNpcap(): Promise<void> {
    try {
      const status = await getNpcapStatus();
      this.npcap = {
        availability: status.availability,
        detail: status.detail,
        ...(status.version === undefined ? {} : { version: status.version }),
      };
      this.logger?.info("npcap.status", {
        availability: status.availability,
        ...(status.version === undefined ? {} : { version: status.version }),
      });
    } catch (error) {
      this.npcap = { availability: "error", detail: errorMessage(error) };
      this.logger?.warn("npcap.status.failed", errorLogFields(error));
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
    if (this.npcap.availability !== "ready") {
      await this.stopCapture();
      this.phase = "npcap-unavailable";
      this.detail = this.npcap.detail;
      return;
    }
    if (this.running) return;
    delete this.warning;
    this.contributor?.setEnabled(true);
    this.phase = "waiting-for-game";
    this.detail = "Starting packet capture…";
    this.logger?.info("capture.start.requested", { automaticDevice: this.settings.deviceName === null });
    try {
      this.droppedFlows = [];
      await this.capture.start({
        protocols: ["udp"],
        targetProcessName: "SpiritVale.exe",
        ...(this.settings.deviceName === null ? {} : { deviceName: this.settings.deviceName }),
        decodeLiteNetLib: true,
      });
      this.running = true;
      this.logger?.info("capture.start.completed");
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
    if (!this.running && this.capture.state === "stopped") return;
    await this.capture.stop().catch((error) => {
      this.warning = errorMessage(error);
      this.logger?.error("capture.stop.failed", errorLogFields(error));
    });
    this.running = false;
    this.gameDetected = false;
  }

  private targetStatus(status: CaptureTargetStatus): void {
    const wasDetected = this.gameDetected;
    this.gameDetected = status.state === "active";
    if (wasDetected !== this.gameDetected) {
      this.logger?.info("capture.target.changed", { state: status.state });
    }
    if (!this.running) return;
    this.phase = this.gameDetected ? "capturing" : "waiting-for-game";
    this.detail = this.gameDetected ? "Observing game traffic" : "Waiting for Spirit Vale";
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
}

function parseSettings(value: unknown): DesktopSettings {
  if (!isRecord(value) || value.schemaVersion !== 1) return defaultSettings();
  return {
    schemaVersion: 1,
    contributionEnabled: value.contributionEnabled === true,
    deviceName: typeof value.deviceName === "string" && value.deviceName.length > 0 ? value.deviceName : null,
  };
}
