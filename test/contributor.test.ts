import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CapturedFishNetPacket } from "@kar-mi/spirit-vale-tools-capture";
import type { PacketCapture, NpcapDevice } from "@kar-mi/spirit-vale-tools-capture/capture";
import type { FishNetMarketEvent, FishNetMarketListing } from "@kar-mi/spirit-vale-tools-market";
import { MarketContributor, type ContributorSnapshot } from "../src/backend/contributor.ts";
import { CaptureService } from "../src/backend/capture-service.ts";
import { canonicalObservationPayload, sha256Hex, type MarketObservationBatch } from "../src/backend/market-contracts.ts";
import { normalizeListing } from "../src/backend/normalizer.ts";

let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe("market upload contract", () => {
  test("hashes the canonical public payload", async () => {
    const payload = canonicalObservationPayload({
      itemType: 1,
      itemId: "Flax",
      displayName: "Flax",
      unitPrice: 10,
      quantity: 58,
      status: 1,
      stats: [],
      expiresAt: "2026-09-01T16:05:50.000Z",
    });
    expect(payload).toBe('[1,"Flax","Flax",10,58,1,[],"2026-09-01T16:05:50.000Z"]');
    expect(await sha256Hex(payload)).toBe("4930103c67eb9e98267f00190a63ae0edf4b9833e04250be87e5345327b794ad");
  });

  test("keeps captured enhancements outside listing identity", async () => {
    const observation = {
      itemType: 3,
      itemId: "Stormcall Kunai",
      displayName: "Stormcall Kunai",
      unitPrice: 100_000,
      quantity: 1,
      status: 1,
      stats: [],
      expiresAt: null,
    };
    const baseline = canonicalObservationPayload(observation);
    const enrichedObservation = {
      ...observation,
      enhancements: {
        refine: 7,
        startingPotential: 20,
        spentPotential: 4,
        cards: ["Wolf Card"],
        gems: [{ itemId: "Ruby", refine: 3 }],
      },
    };
    const enriched = canonicalObservationPayload(enrichedObservation);
    expect(enriched).toBe(baseline);
    expect(await sha256Hex(enriched)).toBe(await sha256Hex(baseline));
  });

  test("normalizes equipment potential, refine, and cards", async () => {
    const source = listing(0);
    source.item.itemId = "Stormcall Kunai";
    source.item.payloadJson = JSON.stringify({
      Id: "Stormcall Kunai",
      Refine: 7,
      StartingPotential: 20,
      SpentPotential: 4,
      Cards: ["Wolf Card", "Bat Card"],
      Substats: [],
    });
    const observation = await normalizeListing(source);
    expect(observation?.enhancements).toEqual({
      refine: 7,
      startingPotential: 20,
      spentPotential: 4,
      cards: ["Wolf Card", "Bat Card"],
      gems: [],
    });
  });

  test("normalizes artifact gems and their refine levels", async () => {
    const source = listing(1);
    source.item.itemId = "Holy Vow";
    source.item.payloadJson = JSON.stringify({
      Id: "Acolyte",
      Refine: 9,
      Gems: [
        { Id: "Ruby", Refine: 3 },
        { Id: "Sapphire", Refine: 5 },
      ],
      Substats: [],
    });
    const observation = await normalizeListing(source);
    expect(observation?.enhancements).toEqual({
      refine: 9,
      startingPotential: 0,
      spentPotential: 0,
      cards: [],
      gems: [
        { itemId: "Ruby", refine: 3 },
        { itemId: "Sapphire", refine: 5 },
      ],
    });
  });

  test("registers once and uploads a privacy-safe 50-observation batch", async () => {
    const statePath = await createStatePath();
    const requests: Array<{ url: string; body?: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.endsWith("/v2/installations")) return Response.json({ token: "a".repeat(43) }, { status: 201 });
      return new Response(null, { status: 202 });
    };
    const contributor = await MarketContributor.load({
      statePath,
      collectorVersion: "test-collector",
      endpoint: "https://market.test",
      fetch: fakeFetch as typeof fetch,
      now: () => new Date("2026-08-30T16:20:00.000Z"),
    });
    contributor.setEnabled(true);
    let sequence = 0;
    trackerOf(contributor).consume = () => [searchEvent(sequence++)];

    for (let index = 0; index < 50; index += 1) contributor.consume({} as CapturedFishNetPacket);
    await contributor.shutdown();

    expect(requests.map((request) => request.url)).toEqual([
      "https://market.test/v2/installations",
      "https://market.test/v2/observations",
    ]);
    const upload = JSON.parse(requests[1]!.body!) as MarketObservationBatch;
    expect(upload.protocolVersion).toBe(2);
    expect(upload.collector.version).toBe("test-collector");
    expect(upload.observations).toHaveLength(50);
    expect(JSON.stringify(upload)).not.toContain("seller-account");
    expect(JSON.stringify(upload)).not.toContain("Seller Secret");
    expect(JSON.stringify(upload)).not.toContain("raw");

    const state = JSON.parse(await readFile(statePath, "utf8")) as { installationToken: string; outbox: unknown[] };
    expect(state.installationToken).toBe("a".repeat(43));
    expect(state.outbox).toEqual([]);
  });

  test("keeps a failed batch queued for the next launch", async () => {
    const statePath = await createStatePath();
    const contributor = await MarketContributor.load({
      statePath,
      collectorVersion: "test-collector",
      endpoint: "https://market.test",
      fetch: (async (input: string | URL | Request) => String(input).endsWith("/v2/installations")
        ? Response.json({ token: "b".repeat(43) }, { status: 201 })
        : new Response(null, { status: 503 })) as typeof fetch,
    });
    contributor.setEnabled(true);
    let sequence = 0;
    trackerOf(contributor).consume = () => [searchEvent(sequence++)];

    for (let index = 0; index < 50; index += 1) contributor.consume({} as CapturedFishNetPacket);
    await contributor.shutdown();

    const state = JSON.parse(await readFile(statePath, "utf8")) as { outbox: Array<{ attempts: number; batch: MarketObservationBatch }> };
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.attempts).toBe(1);
    expect(state.outbox[0]?.batch.observations).toHaveLength(50);
  });

  test("distinguishes market events, normalization drops, and duplicates", async () => {
    const statePath = await createStatePath();
    const contributor = await MarketContributor.load({
      statePath,
      collectorVersion: "test-collector",
    });
    contributor.setEnabled(true);
    const droppedEvent = searchEvent(1);
    if (droppedEvent.kind !== "searchPage") throw new Error("expected search page");
    droppedEvent.page.listings[0]!.item.itemId = null;
    const eventBatches: FishNetMarketEvent[][] = [
      [{ kind: "collectResult", tick: 0, success: true, message: null }, searchEvent(0)],
      [searchEvent(0)],
      [droppedEvent],
    ];
    trackerOf(contributor).consume = () => eventBatches.shift() ?? [];

    contributor.consume({} as CapturedFishNetPacket);
    contributor.consume({} as CapturedFishNetPacket);
    contributor.consume({} as CapturedFishNetPacket);
    await contributor.shutdown();

    expect(contributor.snapshot()).toMatchObject({
      marketEventsDecoded: 4,
      listingEventsDecoded: 3,
      listingsDecoded: 3,
      observationsNormalized: 2,
      normalizationDropped: 1,
      normalizationErrors: 0,
      duplicatesSuppressed: 1,
      prepared: 1,
    });
  });

  test("recovers a validated market page after attaching mid-session", async () => {
    const contributor = await MarketContributor.load({
      statePath: await createStatePath(),
      collectorVersion: "test-collector",
    });
    contributor.setEnabled(true);

    contributor.consume(searchRequestPacket());
    contributor.consume(unresolvedSearchPagePacket({
      Success: true,
      Code: 0,
      Message: null,
      Listings: [],
      NextCursor: null,
      HasMore: false,
    }));

    expect(contributor.snapshot()).toMatchObject({
      marketEventsDecoded: 2,
      searchRequestsDecoded: 1,
      listingEventsDecoded: 1,
      unresolvedInboundRpcLinks: 1,
      lateSessionResponsesRecovered: 1,
    });
    await contributor.shutdown();
  });

  test("recovers a validated market page when stale link metadata misresolves it", async () => {
    const contributor = await MarketContributor.load({
      statePath: await createStatePath(),
      collectorVersion: "test-collector",
    });
    contributor.setEnabled(true);
    const response = unresolvedSearchPagePacket({
      Success: true,
      Code: 0,
      Message: null,
      Listings: [],
      NextCursor: null,
      HasMore: false,
    });
    response.linkResolved = true;
    response.rpcName = "UnrelatedTargetRpc";
    response.networkBehaviourType = "UnrelatedBehaviour";

    contributor.consume(searchRequestPacket());
    contributor.consume(response);

    expect(contributor.snapshot()).toMatchObject({
      marketEventsDecoded: 2,
      searchRequestsDecoded: 1,
      listingEventsDecoded: 1,
      unresolvedInboundRpcLinks: 0,
      lateSessionResponsesRecovered: 1,
    });
    await contributor.shutdown();
  });

  test("does not recover an unrelated unresolved JSON response", async () => {
    const contributor = await MarketContributor.load({
      statePath: await createStatePath(),
      collectorVersion: "test-collector",
    });
    contributor.setEnabled(true);

    contributor.consume(searchRequestPacket());
    contributor.consume(unresolvedSearchPagePacket({ unrelated: true }));

    expect(contributor.snapshot()).toMatchObject({
      marketEventsDecoded: 1,
      searchRequestsDecoded: 1,
      listingEventsDecoded: 0,
      unresolvedInboundRpcLinks: 1,
      lateSessionResponsesRecovered: 0,
    });
    expect(contributor.snapshot().warning).toBeUndefined();
    await contributor.shutdown();
  });

  test("diagnoses genuinely unresolved inbound RPC links", async () => {
    const contributor = await MarketContributor.load({
      statePath: await createStatePath(),
      collectorVersion: "test-collector",
    });
    contributor.setEnabled(true);
    trackerOf(contributor).consume = (packet) => packet.packetName === "serverRpc"
      ? [{
          kind: "searchRequest",
          tick: 1,
          request: { query: null, cursor: null, pageSize: 20 },
        }]
      : [];

    contributor.consume({
      packetName: "rpcLink",
      linkResolved: false,
      liteNetPacket: { udpPacket: { direction: "inbound" } },
    } as CapturedFishNetPacket);
    contributor.consume({ packetName: "serverRpc" } as CapturedFishNetPacket);

    expect(contributor.snapshot()).toMatchObject({
      marketEventsDecoded: 1,
      searchRequestsDecoded: 1,
      listingEventsDecoded: 0,
      unresolvedInboundRpcLinks: 1,
    });

    const service = new CaptureService("unused", "0.1.4");
    Object.assign(contributorStateOf(service), contributor.snapshot());
    expect(service.state().warning).toBe(
      "Market requests are visible, but linked responses are unresolved. Share this diagnostic state; restarting alone will not fix this capture path.",
    );

    trackerOf(contributor).consume = () => [searchEvent(2)];
    contributor.consume({ packetName: "targetRpc" } as CapturedFishNetPacket);
    Object.assign(contributorStateOf(service), contributor.snapshot());
    const recoveredState = service.state();
    expect(recoveredState).toMatchObject({
      listingEventsDecoded: 1,
      listingsDecoded: 1,
    });
    expect(recoveredState.warning).toBeUndefined();
    await contributor.shutdown();
  });

  test("surfaces dropped-flow verdicts in desktop state", () => {
    const service = new CaptureService("unused", "0.1.3");
    captureOf(service).emit("droppedFlows", [
      { flow: "udp 10.0.0.2:5000 <-> 203.0.113.5:6000", packets: 33, verdict: "unknown" },
    ]);

    expect(service.state().droppedFlows).toEqual([
      { flow: "udp 10.0.0.2:5000 <-> 203.0.113.5:6000", packets: 33, verdict: "unknown" },
    ]);
  });

  test("opens Automatic on an active adapter and exposes the resolved choice", async () => {
    const dataDirectory = path.dirname(await createStatePath());
    const capture = new FakePacketCapture();
    const ethernet = captureDevice("ethernet", "Realtek Ethernet", ["192.168.86.20"]);
    const staleTap = captureDevice("stale-tap", "TAP-Windows Adapter", ["169.254.20.4"]);
    const service = captureService(dataDirectory, capture, () => [staleTap, ethernet]);

    await service.start();

    expect(capture.starts).toEqual(["ethernet"]);
    expect(service.state()).toMatchObject({
      deviceName: null,
      captureAdapter: {
        name: "ethernet",
        description: "Realtek Ethernet",
        selection: "automatic",
        automaticCandidate: true,
      },
      automaticCaptureRestarts: 0,
    });
    expect((await service.devices()).map(({ name, automaticCandidate }) => ({ name, automaticCandidate }))).toEqual([
      { name: "ethernet", automaticCandidate: true },
      { name: "stale-tap", automaticCandidate: false },
    ]);

    await service.shutdown();
  });

  test("restarts Automatic capture when the routed adapter changes", async () => {
    const dataDirectory = path.dirname(await createStatePath());
    const capture = new FakePacketCapture();
    const ethernet = captureDevice("ethernet", "Realtek Ethernet", ["192.168.86.20"]);
    const tunnel = captureDevice("tunnel", "Active tunnel", ["10.8.0.2"]);
    let devices = [ethernet];
    const service = captureService(dataDirectory, capture, () => devices);
    await service.start();
    capture.emit("targetStatus", { state: "active", processIds: [42] });
    let decoderResets = 0;
    internalsOf(service).fishNetDecoder.reset = () => { decoderResets += 1; };

    devices = [tunnel];
    await internalsOf(service).checkAutomaticDevice();

    expect(capture.starts).toEqual(["ethernet", "tunnel"]);
    expect(capture.stops).toBe(1);
    expect(service.state()).toMatchObject({
      captureAdapter: { name: "tunnel", selection: "automatic" },
      automaticCaptureRestarts: 1,
    });
    expect(decoderResets).toBe(0);

    await service.shutdown();
  });

  test("applies a manual adapter selection immediately", async () => {
    const dataDirectory = path.dirname(await createStatePath());
    const capture = new FakePacketCapture();
    const ethernet = captureDevice("ethernet", "Realtek Ethernet", ["192.168.86.20"]);
    const tunnel = captureDevice("tunnel", "Active tunnel", ["10.8.0.2"]);
    const service = captureService(dataDirectory, capture, () => [ethernet, tunnel]);
    await service.start();

    await service.updateSettings({ deviceName: "tunnel" });

    expect(capture.starts).toEqual(["ethernet", "tunnel"]);
    expect(capture.stops).toBe(1);
    expect(service.state()).toMatchObject({
      deviceName: "tunnel",
      captureAdapter: { name: "tunnel", selection: "manual" },
    });

    await service.shutdown();
  });
  test("persists and applies Linux capture mode changes immediately", async () => {
    const dataDirectory = path.dirname(await createStatePath());
    const capture = new FakePacketCapture();
    const ethernet = captureDevice("ethernet", "Ethernet", ["192.168.86.20"]);
    const service = captureService(dataDirectory, capture, () => [ethernet]);
    await service.start();

    const state = await service.updateSettings({ linuxCaptureMode: "libpcap" });

    expect(capture.starts).toEqual(["ethernet", "ethernet"]);
    expect(capture.stops).toBe(1);
    expect(state.linuxCaptureMode).toBe("libpcap");
    expect(JSON.parse(await readFile(path.join(dataDirectory, "settings.json"), "utf8"))).toMatchObject({
      linuxCaptureMode: "libpcap",
    });

    await service.shutdown();
  });


  test("reports an active game with no attributed traffic on the resolved adapter", async () => {
    const dataDirectory = path.dirname(await createStatePath());
    const capture = new FakePacketCapture();
    const ethernet = captureDevice("ethernet", "Realtek Ethernet", ["192.168.86.20"]);
    let now = new Date("2026-09-01T20:00:00.000Z");
    const service = captureService(dataDirectory, capture, () => [ethernet], () => now);
    await service.start();
    capture.emit("targetStatus", { state: "active", processIds: [42] });

    now = new Date("2026-09-01T20:00:21.000Z");
    internalsOf(service).updateCaptureHealth();

    expect(service.state().warning).toBe(
      "Spirit Vale is running, but no attributed game traffic reached Realtek Ethernet. A VPN or route optimizer may be using another adapter; select its active adapter below.",
    );

    await service.shutdown();
  });

  test("explains when capture started after the active game session", async () => {
    const dataDirectory = path.dirname(await createStatePath());
    const capture = new FakePacketCapture();
    const ethernet = captureDevice("ethernet", "Realtek Ethernet", ["192.168.86.20"]);
    const service = captureService(dataDirectory, capture, () => [ethernet]);
    capture.emit("targetStatus", { state: "active", processIds: [42] });
    await service.start();
    Object.assign(contributorStateOf(service), {
      searchRequestsDecoded: 2,
      listingEventsDecoded: 0,
      unresolvedInboundRpcLinks: 100,
    });

    expect(service.state()).toMatchObject({
      captureStartedWithGameActive: true,
      warning: "ValeMarket started after Spirit Vale's current network session was already active. Leave ValeMarket running, fully close and relaunch Spirit Vale, then search the market again.",
    });

    capture.emit("targetStatus", { state: "inactive", processIds: [] });
    expect(service.state().captureStartedWithGameActive).toBe(false);
    await service.shutdown();
  });
  test("separates spawn parsing from RPC-link resolution", () => {
    const service = new CaptureService("unused", "0.1.7");
    const consume = consumeOf(service);
    consume({
      packetName: "objectSpawn",
      objectId: 5,
      rpcLinkRegistrations: [{ linkId: 22 }, { linkId: 23 }],
    } as CapturedFishNetPacket);
    consume({ packetName: "objectSpawn" } as CapturedFishNetPacket);
    consume({ packetName: "bulkSpawnOrDespawn" } as CapturedFishNetPacket);
    consume({
      packetName: "rpcLink",
      linkId: 22,
      linkResolved: true,
      liteNetPacket: { udpPacket: { direction: "inbound" } },
    } as CapturedFishNetPacket);
    const unresolved = {
      packetName: "rpcLink",
      linkId: 907,
      linkResolved: false,
      liteNetPacket: { udpPacket: { direction: "inbound" } },
    } as CapturedFishNetPacket;
    consume(unresolved);
    consume(unresolved);

    expect(service.state()).toMatchObject({
      packetsObserved: 6,
      objectSpawnPacketsObserved: 2,
      objectSpawnsDecoded: 1,
      bulkSpawnPacketsObserved: 1,
      rpcLinkRegistrationsObserved: 2,
      resolvedInboundRpcLinks: 1,
      unresolvedInboundRpcLinkIds: [907],
    });
  });

});

interface MarketContributorInternals {
  tracker: { consume(packet: CapturedFishNetPacket): FishNetMarketEvent[] };
}

function trackerOf(contributor: MarketContributor): MarketContributorInternals["tracker"] {
  return (contributor as unknown as MarketContributorInternals).tracker;
}

interface CaptureServiceInternals {
  capture: {
    emit(
      event: "droppedFlows",
      flows: Array<{ flow: string; packets: number; verdict: "game traffic" | "unrelated" | "unknown" }>,
    ): boolean;
  };
  contributorState: ContributorSnapshot;
  consume(packet: CapturedFishNetPacket): void;
  checkAutomaticDevice(): Promise<void>;
  updateCaptureHealth(): void;
  fishNetDecoder: { reset(): void };
}

function captureOf(service: CaptureService): CaptureServiceInternals["capture"] {
  // Tests intentionally access the owned capture emitter without starting a live backend.
  const internals = service as unknown as CaptureServiceInternals;
  return internals.capture;
}

function internalsOf(service: CaptureService): CaptureServiceInternals {
  return service as unknown as CaptureServiceInternals;
}

function contributorStateOf(service: CaptureService): ContributorSnapshot {
  // Tests inject an observed contributor snapshot without starting the desktop service.
  const internals = service as unknown as CaptureServiceInternals;
  return internals.contributorState;
}
function searchRequestPacket(): CapturedFishNetPacket {
  return {
    packetName: "serverRpc",
    rpcResolution: "verified",
    rpcName: "RequestVendorItemList_S",
    networkBehaviourType: "PlayerController",
    decodedFields: [
      { name: "dto.Query", codec: "stringUtf8Packed", value: null },
      { name: "dto.Cursor", codec: "stringUtf8Packed", value: null },
      { name: "dto.PageSize", codec: "packedInt32", value: 20 },
    ],
    liteNetPacket: { udpPacket: { direction: "outbound" } },
  } as CapturedFishNetPacket;
}

function unresolvedSearchPagePacket(page: unknown): CapturedFishNetPacket {
  return {
    packetName: "rpcLink",
    linkId: 34_244,
    linkResolved: false,
    payload: packedString(JSON.stringify(page)),
    liteNetPacket: {
      packet: { property: "channeled" },
      udpPacket: { direction: "inbound" },
    },
  } as CapturedFishNetPacket;
}

function packedString(value: string): Buffer {
  const text = Buffer.from(value, "utf8");
  let encodedLength = BigInt(text.length) << 1n;
  const length: number[] = [];
  do {
    let byte = Number(encodedLength & 0x7fn);
    encodedLength >>= 7n;
    if (encodedLength !== 0n) byte |= 0x80;
    length.push(byte);
  } while (encodedLength !== 0n);
  return Buffer.concat([Buffer.from(length), text]);
}


function consumeOf(service: CaptureService): (packet: CapturedFishNetPacket) => void {
  const internals = service as unknown as CaptureServiceInternals;
  return (packet) => internals.consume(packet);
}

class FakePacketCapture extends EventEmitter {
  state: "stopped" | "running" = "stopped";
  readonly starts: string[] = [];
  stops = 0;

  async start(config: { deviceName?: string }): Promise<void> {
    this.starts.push(config.deviceName ?? "");
    this.state = "running";
    this.emit("started");
  }

  async stop(): Promise<void> {
    if (this.state === "running") this.stops += 1;
    this.state = "stopped";
    this.emit("stopped");
  }
}

function captureService(
  dataDirectory: string,
  capture: FakePacketCapture,
  devices: () => NpcapDevice[],
  now: () => Date = () => new Date(),
): CaptureService {
  return new CaptureService(dataDirectory, "test", undefined, {
    capture: capture as unknown as PacketCapture,
    getCaptureStatus: async () => ({ availability: "ready", detail: "ready" }),
    listCaptureDevices: async () => devices(),
    resolveCaptureDevice: async (candidates) => {
      const device = candidates[0];
      return device === undefined ? { usedFallback: false } : { device, usedFallback: false };
    },
    captureBackendMetadata: () => ({ platform: "windows", name: "Npcap", effectiveMode: "npcap" }),
    setLinuxCaptureMode: () => false,
    now,
    routeCheckIntervalMs: 0,
  });
}

function captureDevice(name: string, description: string, addresses: string[]): NpcapDevice {
  return { name, description, addresses, loopback: false };
}

function searchEvent(sequence: number): FishNetMarketEvent {
  return {
    kind: "searchPage",
    tick: sequence,
    page: {
      success: true,
      code: 0,
      message: null,
      listings: [listing(sequence)],
      nextCursor: null,
      hasMore: false,
    },
  };
}

function listing(sequence: number): FishNetMarketListing {
  return {
    listingId: `listing-${sequence}`,
    sellerAccountId: `seller-account-${sequence}`,
    sellerDisplayName: "Seller Secret",
    itemDisplayName: "Moonstone",
    item: {
      itemId: "moonstone",
      instanceId: `instance-${sequence}`,
      itemType: 4,
      quantity: 2,
      payloadJson: null,
      payloadSchemaVersion: null,
      compatibilityFingerprint: null,
    },
    initialQuantity: 2,
    availableQuantity: 2,
    soldQuantity: 0,
    unitPrice: BigInt(1000 + sequence),
    status: 1,
    version: BigInt(sequence + 1),
    createdAt: 1_700_000_000n,
    updatedAt: 1_700_000_010n,
    expiresAt: 1_700_086_400n,
  };
}

async function createStatePath(): Promise<string> {
  temporaryRoot ??= await mkdtemp(path.join(tmpdir(), "valemarket-desktop-"));
  return path.join(temporaryRoot, "contributor.json");
}
