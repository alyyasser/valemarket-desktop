import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CapturedFishNetPacket } from "@kar-mi/spirit-vale-tools-capture";
import type { FishNetMarketEvent, FishNetMarketListing } from "@kar-mi/spirit-vale-tools-market";
import { MarketContributor } from "../src/backend/contributor.ts";
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
});

interface MarketContributorInternals {
  tracker: { consume(packet: CapturedFishNetPacket): FishNetMarketEvent[] };
}

function trackerOf(contributor: MarketContributor): MarketContributorInternals["tracker"] {
  return (contributor as unknown as MarketContributorInternals).tracker;
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
