// SpiritVale Analytics — local, read-only market intelligence over a real ValeMarket snapshot.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";

const SNAPSHOT_URL = "https://market-api.spiritvalers.com/v2/markets/global/snapshot";
const CACHE_DIR = ".tmp/spiritvale-analytics";
const SNAPSHOT_PATH = `${CACHE_DIR}/snapshot.json`;
const DB_PATH = `${CACHE_DIR}/spiritvale-analytics.sqlite`;
const HTML_PATH = "spiritvale-analytics/index.html";
const DIST_DIR = "spiritvale-analytics/dist";
const PORT = Number(Bun.env.PORT ?? 47832);
const refresh = process.argv.includes("--refresh");
const buildOnly = process.argv.includes("--build");

interface MarketStat {
  type: number;
  name?: string;
  value?: number;
  percent: boolean;
}

interface Enhancements {
  refine: number;
  startingPotential: number;
  spentPotential: number;
  cards: string[];
  gems: Array<{ itemId: string; refine: number }>;
}

interface Listing {
  listingKey: string;
  itemType: number;
  itemId: string;
  displayName: string | null;
  unitPrice: number;
  quantity: number;
  stats: MarketStat[];
  enhancements?: Enhancements;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
}

interface Snapshot {
  generatedAt: string;
  listings: Listing[];
}

interface CatalogEntry {
  name: string;
  kind: string;
  section?: string | null;
  slot?: string | null;
}

mkdirSync(CACHE_DIR, { recursive: true });

async function loadSnapshot(): Promise<Snapshot> {
  const cached = Bun.file(SNAPSHOT_PATH);
  if (!refresh && await cached.exists()) return cached.json() as Promise<Snapshot>;

  const response = await fetch(SNAPSHOT_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Snapshot request failed: HTTP ${response.status}`);
  const body = await response.text();
  await Bun.write(SNAPSHOT_PATH, body);
  return JSON.parse(body) as Snapshot;
}

const [snapshot, catalog] = await Promise.all([
  loadSnapshot(),
  Bun.file("assets/catalog.json").json() as Promise<Record<string, CatalogEntry>>,
]);
const generatedAtMs = Date.parse(snapshot.generatedAt);
const activeListings = snapshot.listings.filter((listing) =>
  listing.unitPrice > 0
  && listing.quantity > 0
  && (listing.expiresAt === null || Date.parse(listing.expiresAt) > generatedAtMs));

const fungibleKinds = new Set(["Material", "Consumable", "Card"]);
function kindOf(listing: Listing): string {
  return catalog[listing.itemId]?.kind ?? "Unknown";
}
function nameOf(listing: Listing): string {
  return listing.displayName ?? catalog[listing.itemId]?.name ?? listing.itemId;
}
function isFungible(listing: Listing): boolean {
  return fungibleKinds.has(kindOf(listing))
    && [1, 2, 5].includes(listing.itemType)
    && listing.stats.length === 0
    && listing.enhancements === undefined;
}

rmSync(DB_PATH, { force: true });
const db = new Database(DB_PATH, { create: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE listings (
    listing_key TEXT PRIMARY KEY,
    item_type INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    catalog_kind TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    is_fungible INTEGER NOT NULL,
    refine INTEGER NOT NULL,
    spent_potential INTEGER NOT NULL,
    card_count INTEGER NOT NULL,
    gem_count INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT
  );
  CREATE TABLE listing_stats (
    listing_key TEXT NOT NULL,
    position INTEGER NOT NULL,
    stat_type INTEGER NOT NULL,
    stat_name TEXT NOT NULL,
    stat_value REAL,
    is_percent INTEGER NOT NULL,
    PRIMARY KEY (listing_key, position)
  );
  CREATE INDEX listings_item_idx ON listings(item_type, item_id);
  CREATE INDEX listing_stats_name_idx ON listing_stats(stat_name, listing_key);
`);

const insertListing = db.prepare(`
  INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertStat = db.prepare(`
  INSERT INTO listing_stats VALUES (?, ?, ?, ?, ?, ?)
`);
const populate = db.transaction((rows: Listing[]) => {
  for (const listing of rows) {
    const enhancements = listing.enhancements;
    insertListing.run(
      listing.listingKey,
      listing.itemType,
      listing.itemId,
      nameOf(listing),
      kindOf(listing),
      listing.unitPrice,
      listing.quantity,
      isFungible(listing) ? 1 : 0,
      enhancements?.refine ?? 0,
      enhancements?.spentPotential ?? 0,
      enhancements?.cards.length ?? 0,
      enhancements?.gems.length ?? 0,
      listing.firstSeenAt,
      listing.lastSeenAt,
      listing.expiresAt,
    );
    listing.stats.forEach((stat, position) => insertStat.run(
      listing.listingKey,
      position,
      stat.type,
      stat.name ?? `Stat ${stat.type}`,
      stat.value ?? null,
      stat.percent ? 1 : 0,
    ));
  }
});
populate(activeListings);

function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lowValue = sorted[low]!;
  const highValue = sorted[high]!;
  return lowValue + (highValue - lowValue) * (position - low);
}

function median(values: number[]): number {
  return quantile(values, 0.5);
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const group = groups.get(value);
    if (group) group.push(row);
    else groups.set(value, [row]);
  }
  return groups;
}

function enhancementBand(listing: Listing): string {
  const enhancements = listing.enhancements;
  const refine = enhancements?.refine ?? 0;
  const spent = enhancements?.spentPotential ?? 0;
  const refineBand = refine === 0 ? "r0" : refine <= 4 ? "r1-4" : refine <= 8 ? "r5-8" : refine <= 12 ? "r9-12" : "r13+";
  const potentialBand = spent === 0 ? "p0" : spent <= 20 ? "p1-20" : "p21+";
  return `${listing.stats.length}|${refineBand}|${potentialBand}|c${enhancements?.cards.length ? 1 : 0}|g${enhancements?.gems.length ? 1 : 0}`;
}

function statPremiums(rows: Listing[]) {
  const statNames = [...new Set(rows.flatMap((row) => row.stats.map((stat) => stat.name ?? `Stat ${stat.type}`)))];
  const results = [];
  for (const statName of statNames) {
    const strata = new Map<string, { yes: number[]; no: number[] }>();
    let listingCount = 0;
    for (const row of rows) {
      const stratum = enhancementBand(row);
      const values = strata.get(stratum) ?? { yes: [], no: [] };
      const hasStat = row.stats.some((stat) => (stat.name ?? `Stat ${stat.type}`) === statName);
      values[hasStat ? "yes" : "no"].push(Math.log(row.unitPrice));
      if (hasStat) listingCount += 1;
      strata.set(stratum, values);
    }

    let weightSum = 0;
    let weightedDelta = 0;
    let positiveWeight = 0;
    let matchedWith = 0;
    let matchedWithout = 0;
    let strataUsed = 0;
    for (const values of strata.values()) {
      if (values.yes.length < 5 || values.no.length < 5) continue;
      const delta = median(values.yes) - median(values.no);
      const weight = 2 * values.yes.length * values.no.length / (values.yes.length + values.no.length);
      weightSum += weight;
      weightedDelta += weight * delta;
      if (delta > 0) positiveWeight += weight;
      matchedWith += values.yes.length;
      matchedWithout += values.no.length;
      strataUsed += 1;
    }
    if (weightSum === 0 || Math.min(matchedWith, matchedWithout) < 20) continue;

    const premiumPct = 100 * Math.expm1(weightedDelta / weightSum);
    const positiveAgreement = 100 * positiveWeight / weightSum;
    const directionAgreementPct = premiumPct >= 0 ? positiveAgreement : 100 - positiveAgreement;
    const effectiveSupport = Math.min(matchedWith, matchedWithout);
    const confidence = effectiveSupport >= 200 && directionAgreementPct >= 75 && strataUsed >= 3
      ? "high"
      : effectiveSupport >= 75 && directionAgreementPct >= 60
        ? "medium"
        : "low";
    results.push({
      stat: statName,
      premiumPct: Math.round(premiumPct * 10) / 10,
      prevalencePct: Math.round(1000 * listingCount / rows.length) / 10,
      matchedWith,
      matchedWithout,
      strata: strataUsed,
      directionAgreementPct: Math.round(directionAgreementPct),
      confidence,
    });
  }
  return results.sort((left, right) => right.premiumPct - left.premiumPct);
}

const rolledGroups = groupBy(
  activeListings.filter((listing) => listing.stats.length > 0),
  (listing) => `${listing.itemType}:${listing.itemId}`,
);
const itemAnalytics = [...rolledGroups.entries()]
  .filter(([, rows]) => rows.length >= 100)
  .map(([key, rows]) => {
    const prices = rows.map((row) => row.unitPrice);
    const first = rows[0]!;
    return {
      key,
      itemType: first.itemType,
      itemId: first.itemId,
      name: nameOf(first),
      kind: kindOf(first),
      section: catalog[first.itemId]?.section ?? null,
      slot: catalog[first.itemId]?.slot ?? null,
      listingCount: rows.length,
      p25Price: Math.round(quantile(prices, 0.25)),
      medianPrice: Math.round(median(prices)),
      p75Price: Math.round(quantile(prices, 0.75)),
      stats: statPremiums(rows),
    };
  })
  .sort((left, right) => right.listingCount - left.listingCount);

const fungibleListings = activeListings.filter(isFungible);
const fungibleGroups = groupBy(fungibleListings, (listing) => `${listing.itemType}\u0000${listing.itemId}`);
const priceOutliers = [];
const stockClusters = [];

for (const rows of fungibleGroups.values()) {
  if (rows.length < 20) continue;
  const prices = rows.map((row) => row.unitPrice);
  const logPrices = prices.map(Math.log);
  const medianLogPrice = median(logPrices);
  const medianPrice = Math.exp(medianLogPrice);
  const mad = Math.max(median(logPrices.map((value) => Math.abs(value - medianLogPrice))), 0.15);
  const first = rows[0]!;

  for (const row of rows) {
    const robustZ = 0.6745 * (Math.log(row.unitPrice) - medianLogPrice) / mad;
    const ratio = row.unitPrice / medianPrice;
    if (robustZ < 4 && ratio < 20) continue;
    priceOutliers.push({
      listingKey: row.listingKey,
      itemType: row.itemType,
      itemId: row.itemId,
      name: nameOf(row),
      listingCount: rows.length,
      unitPrice: row.unitPrice,
      quantity: row.quantity,
      lotValue: row.unitPrice * row.quantity,
      baselineMedian: Math.round(medianPrice),
      priceRatio: Math.round(ratio * 10) / 10,
      robustZ: Math.round(robustZ * 10) / 10,
      firstSeenAt: row.firstSeenAt,
      reviewPriority: robustZ >= 15 || ratio >= 500 ? "high" : robustZ >= 8 || ratio >= 100 ? "medium" : "low",
      reason: "Extreme unit-price distance from the current item market",
    });
  }

  const totalUnits = rows.reduce((sum, row) => sum + row.quantity, 0);
  const cells = groupBy(rows, (row) => `${row.unitPrice}\u0000${row.quantity}`);
  for (const cellRows of cells.values()) {
    if (cellRows.length < 3) continue;
    const row = cellRows[0]!;
    const cellUnits = cellRows.reduce((sum, value) => sum + value.quantity, 0);
    const unitSharePct = 100 * cellUnits / totalUnits;
    const firstSeenTimes = cellRows.map((value) => Date.parse(value.firstSeenAt));
    const firstSeenSpanMinutes = (Math.max(...firstSeenTimes) - Math.min(...firstSeenTimes)) / 60_000;
    if (unitSharePct < 5 || firstSeenSpanMinutes > 10) continue;
    stockClusters.push({
      itemType: first.itemType,
      itemId: first.itemId,
      name: nameOf(first),
      unitPrice: row.unitPrice,
      quantity: row.quantity,
      repeatedListings: cellRows.length,
      totalUnits: cellUnits,
      unitSharePct: Math.round(unitSharePct * 10) / 10,
      medianPrice: Math.round(medianPrice),
      priceRatio: Math.round(10 * row.unitPrice / medianPrice) / 10,
      firstSeenSpanMinutes: Math.round(firstSeenSpanMinutes * 10) / 10,
      reason: "Repeated same-price, same-quantity listings first observed as one cohort",
    });
  }
}

priceOutliers.sort((left, right) => right.robustZ - left.robustZ || right.lotValue - left.lotValue);
stockClusters.sort((left, right) => right.unitSharePct - left.unitSharePct || right.repeatedListings - left.repeatedListings);

const databaseCounts = db.query(`
  SELECT
    (SELECT count(*) FROM listings) AS listings,
    (SELECT count(*) FROM listing_stats) AS stats,
    (SELECT count(*) FROM listings WHERE is_fungible = 1) AS fungible
`).get() as { listings: number; stats: number; fungible: number };

const payload = JSON.stringify({
  generatedAt: snapshot.generatedAt,
  summary: {
    activeListings: databaseCounts.listings,
    normalizedStats: databaseCounts.stats,
    fungibleListings: databaseCounts.fungible,
    analyzableRolledItems: itemAnalytics.length,
    priceOutliers: priceOutliers.length,
    stockClusters: stockClusters.length,
  },
  itemAnalytics,
  priceOutliers: priceOutliers.slice(0, 150),
  stockClusters: stockClusters.slice(0, 100),
  methodology: {
    statValue: "Within each base item, compare median log asking prices for listings with and without a stat inside matched bands for stat count, refine, spent potential, cards, and gems. Combine matched bands by effective sample size.",
    priceOutlier: "Compare log unit price with the current per-item median using a median absolute deviation score. A 0.15 log floor prevents a nearly uniform market from producing infinite scores.",
    stockCluster: "Flag three or more identical unit-price and quantity listings that represent at least 5% of current units and were first observed within ten minutes.",
    boundary: "These are listing observations, not completed sales. No seller, buyer, account, character, or shop identity is collected. Signals can prioritize review; they cannot identify an actor or prove RMT.",
  },
});
const html = await Bun.file(HTML_PATH).text();

if (buildOnly) {
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(`${DIST_DIR}/assets/fonts`, { recursive: true });
  const fonts = [
    "atkinson-hyperlegible-next-latin.woff2",
    "crimson-pro-latin.woff2",
    "jetbrains-mono-latin.woff2",
  ];
  await Promise.all([
    Bun.write(`${DIST_DIR}/index.html`, html),
    Bun.write(`${DIST_DIR}/data.json`, payload),
    Bun.write(`${DIST_DIR}/robots.txt`, "User-agent: *\nDisallow: /\n"),
    ...fonts.map((font) => Bun.write(`${DIST_DIR}/assets/fonts/${font}`, Bun.file(`assets/fonts/${font}`))),
  ]);
  console.log(`Built SpiritVale Analytics: ${DIST_DIR}`);
  console.log(`Snapshot ${snapshot.generatedAt}: ${databaseCounts.listings.toLocaleString()} active listings`);
} else {
  const server = Bun.serve({
    port: PORT,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/data") {
        return new Response(payload, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      }
      if (url.pathname === "/health") return Response.json({ name: "spiritvale-analytics", status: "ok", generatedAt: snapshot.generatedAt });
      if (url.pathname.startsWith("/assets/fonts/")) {
        const path = url.pathname.slice(1);
        return new Response(Bun.file(path), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=3600" } });
      }
      if (
        url.pathname === "/"
        || url.pathname === "/index.html"
        || url.pathname === "/items"
        || url.pathname.startsWith("/items/")
        || url.pathname === "/anomalies"
      ) {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`SpiritVale Analytics ready: http://localhost:${server.port}/items`);
  console.log(`Snapshot ${snapshot.generatedAt}: ${databaseCounts.listings.toLocaleString()} active listings, ${databaseCounts.stats.toLocaleString()} normalized stats`);
  console.log(`Local SQLite: ${DB_PATH}`);
}
