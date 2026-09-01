export const DESKTOP_API_PORT = 47831;
export const MARKET_API_URL = "https://market-api.spiritvalers.com";

export interface MarketStat {
  type: number;
  name?: string;
  value?: number;
  percent: boolean;
}

export interface MarketGem {
  itemId: string;
  refine: number;
}

export interface MarketEnhancements {
  refine: number;
  startingPotential: number;
  spentPotential: number;
  cards: string[];
  gems: MarketGem[];
}

export interface MarketListing {
  marketId: string;
  listingKey: string;
  listingVersion: number;
  payloadHash: string;
  itemType: number;
  itemId: string;
  displayName: string | null;
  unitPrice: number;
  quantity: number;
  status: number;
  stats: MarketStat[];
  enhancements?: MarketEnhancements;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
}

export interface ListingsResponse {
  marketId: string;
  generatedAt: string;
  listings: MarketListing[];
}

export interface ItemHistoryResponse {
  marketId: string;
  itemType: number;
  itemId: string;
  generatedAt: string;
  history: MarketListing[];
}

export interface CaptureDevice {
  name: string;
  description: string;
  addresses: string[];
  loopback: boolean;
  automaticCandidate: boolean;
}

export type LinuxCaptureMode = "auto" | "dumpcap" | "libpcap";
export type CollectorPhase = "disabled" | "capture-unavailable" | "waiting-for-game" | "capturing" | "error";

export interface DesktopState {
  version: string;
  contributionEnabled: boolean;
  deviceName: string | null;
  linuxCaptureMode: LinuxCaptureMode;
  captureAdapter?: {
    name: string;
    description: string;
    selection: "automatic" | "manual";
    automaticCandidate: boolean;
  };
  phase: CollectorPhase;
  detail: string;
  captureBackend: {
    platform: "windows" | "linux" | "unsupported";
    name: string;
    availability: "ready" | "missing" | "error";
    detail: string;
    version?: string;
    mode?: LinuxCaptureMode;
    effectiveMode?: "npcap" | "dumpcap" | "libpcap";
  };
  gameDetected: boolean;
  captureStartedWithGameActive: boolean;
  packetsObserved: number;
  lastAttributedPacketAt?: string;
  automaticCaptureRestarts: number;
  marketEventsDecoded: number;
  lateSessionResponsesRecovered: number;
  searchRequestsDecoded: number;
  listingEventsDecoded: number;
  listingsDecoded: number;
  observationsNormalized: number;
  normalizationDropped: number;
  normalizationErrors: number;
  duplicatesSuppressed: number;
  unresolvedInboundRpcLinks: number;
  fragmentedMessagesReassembled: number;
  fragmentAssembliesDropped: number;
  objectSpawnPacketsObserved: number;
  objectSpawnsDecoded: number;
  bulkSpawnPacketsObserved: number;
  rpcLinkRegistrationsObserved: number;
  resolvedInboundRpcLinks: number;
  unresolvedInboundRpcLinkIds: number[];
  droppedFlows: Array<{
    flow: string;
    packets: number;
    verdict: "game traffic" | "unrelated" | "unknown";
  }>;
  observationsPrepared: number;
  observationsUploaded: number;
  queuedBatches: number;
  latestObservationAt?: string;
  latestUploadAt?: string;
  warning?: string;
}

export interface DesktopSettingsUpdate {
  contributionEnabled?: boolean;
  deviceName?: string | null;
  linuxCaptureMode?: LinuxCaptureMode;
}
