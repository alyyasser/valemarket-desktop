import path from "node:path";
import { PacketCapture, getNpcapStatus, listNpcapDevices, type NpcapDevice } from "@kar-mi/spirit-vale-tools-capture/capture";
import type { CaptureTargetStatus, CapturedFishNetPacket } from "@kar-mi/spirit-vale-tools-capture";
import type { DesktopSettingsUpdate, DesktopState } from "../shared/contracts.ts";
import { MarketContributor, type ContributorSnapshot } from "./contributor.ts";
import { errorMessage, isRecord, loadJson, writeJsonAtomic } from "./storage.ts";

interface DesktopSettings {
  schemaVersion: 1;
  contributionEnabled: boolean;
  deviceName: string | null;
}

const defaultSettings = (): DesktopSettings => ({ schemaVersion: 1, contributionEnabled: true, deviceName: null });
const RECONNECT_WARNING = "Market requests are visible, but linked responses are unresolved. Restart Spirit Vale while ValeMarket is already capturing, then search again.";

export class CaptureService {
  private readonly capture = new PacketCapture();
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
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDirectory: string,
    private readonly version: string,
  ) {
    this.settingsPath = path.join(dataDirectory, "settings.json");
    this.contributorPath = path.join(dataDirectory, "contributor-v2.json");
    this.capture.on("started", () => {
      this.running = true;
      this.phase = this.gameDetected ? "capturing" : "waiting-for-game";
      this.detail = this.gameDetected ? "Observing game traffic" : "Waiting for Spirit Vale";
    });
    this.capture.on("targetStatus", (status) => this.targetStatus(status));
    this.capture.on("fishNetPacket", (packet) => this.consume(packet));
    this.capture.on("warning", (message) => { this.warning = message; });
    this.capture.on("droppedFlows", (flows) => {
      this.droppedFlows = flows.map((flow) => ({ ...flow }));
    });
    this.capture.on("error", (error) => {
      this.running = false;
      this.phase = "error";
      this.detail = "Packet capture stopped";
      this.warning = error.message;
      this.contributor?.setEnabled(false);
    });
    this.capture.on("stopped", () => { this.running = false; });
  }

  async start(): Promise<void> {
    this.settings = await loadJson(this.settingsPath, defaultSettings, parseSettings);
    this.contributor = await MarketContributor.load({
      statePath: this.contributorPath,
      collectorVersion: this.version,
      onState: (state) => { this.contributorState = state; },
    });
    await this.refreshNpcap();
    await this.reconcile();
  }

  state(): DesktopState {
    const sessionSetupWarning = this.contributorState.searchRequestsDecoded > 0
      && this.contributorState.listingEventsDecoded === 0
      && this.contributorState.unresolvedInboundRpcLinks > 0
      ? RECONNECT_WARNING
      : undefined;
    const warning = this.contributorState.warning ?? sessionSetupWarning ?? this.warning;
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
    await writeJsonAtomic(this.settingsPath, this.settings);
    await this.refreshNpcap();
    await this.reconcile();
    return this.state();
  }

  async restart(): Promise<DesktopState> {
    await this.refreshNpcap();
    if (this.running) await this.capture.stop();
    this.running = false;
    await this.reconcile();
    return this.state();
  }

  async shutdown(): Promise<void> {
    if (this.running) await this.capture.stop().catch(() => {});
    this.contributor?.setEnabled(false);
    await this.contributor?.shutdown();
  }

  private async refreshNpcap(): Promise<void> {
    try {
      const status = await getNpcapStatus();
      this.npcap = {
        availability: status.availability,
        detail: status.detail,
        ...(status.version === undefined ? {} : { version: status.version }),
      };
    } catch (error) {
      this.npcap = { availability: "error", detail: errorMessage(error) };
    }
  }

  private reconcile(): Promise<void> {
    this.reconcileChain = this.reconcileChain.catch(() => {}).then(() => this.applyDesiredState());
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
    try {
      this.droppedFlows = [];
      await this.capture.start({
        protocols: ["udp"],
        targetProcessName: "SpiritVale.exe",
        ...(this.settings.deviceName === null ? {} : { deviceName: this.settings.deviceName }),
        decodeFishNet: true,
      });
      this.running = true;
    } catch (error) {
      this.contributor?.setEnabled(false);
      this.phase = "error";
      this.detail = "Could not start packet capture";
      this.warning = errorMessage(error);
    }
  }

  private async stopCapture(): Promise<void> {
    this.contributor?.setEnabled(false);
    if (!this.running && this.capture.state === "stopped") return;
    await this.capture.stop().catch((error) => { this.warning = errorMessage(error); });
    this.running = false;
    this.gameDetected = false;
  }

  private targetStatus(status: CaptureTargetStatus): void {
    this.gameDetected = status.state === "active";
    if (!this.running) return;
    this.phase = this.gameDetected ? "capturing" : "waiting-for-game";
    this.detail = this.gameDetected ? "Observing game traffic" : "Waiting for Spirit Vale";
  }

  private consume(packet: CapturedFishNetPacket): void {
    this.packetsObserved += 1;
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
