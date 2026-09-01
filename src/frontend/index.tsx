import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import itemIconCatalog from "./item-icons.json";
import {
  DESKTOP_API_PORT,
  MARKET_API_URL,
  type CaptureDevice,
  type DesktopSettingsUpdate,
  type DesktopState,
  type ItemHistoryResponse,
  type ListingsResponse,
  type MarketListing,
  type MarketStat,
} from "../shared/contracts.ts";

declare global {
  interface Window {
    valeMarketDesktop?: {
      openDiagnostics(path: string): Promise<void>;
    };
  }
}

const desktopApi = `http://127.0.0.1:${DESKTOP_API_PORT}`;
const formatter = new Intl.NumberFormat("en-US");


function App() {
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [marketError, setMarketError] = useState<string>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"price-asc" | "price-desc">("price-asc");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [stat, setStat] = useState("");
  const [appliedMinPrice, appliedMaxPrice, appliedStat] = useDebouncedValue(
    [minPrice, maxPrice, stat.trim()].join("\u0000"),
    450,
  ).split("\u0000");
  const [offset, setOffset] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<Date>();
  const [selected, setSelected] = useState<MarketListing>();
  const [history, setHistory] = useState<MarketListing[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [desktopState, setDesktopState] = useState<DesktopState>();
  const [devices, setDevices] = useState<CaptureDevice[]>([]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const requestSequence = useRef(0);

  const loadListings = async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setMarketError(undefined);
    const url = new URL("/v2/markets/global/snapshot", MARKET_API_URL);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const data = await response.json() as ListingsResponse;
      if (sequence !== requestSequence.current) return;
      const now = Date.now();
      const statFilter = (appliedStat ?? "").toLowerCase();
      const filtered = data.listings.filter((listing) =>
        (listing.expiresAt === null || Date.parse(listing.expiresAt) > now)
        && (appliedMinPrice === "" || listing.unitPrice >= Number(appliedMinPrice))
        && (appliedMaxPrice === "" || listing.unitPrice <= Number(appliedMaxPrice))
        && (statFilter === "" || listing.stats.some((stat) =>
          String(stat.type) === appliedStat || stat.name?.toLowerCase() === statFilter)));
      filtered.sort((left, right) =>
        (sort === "price-desc" ? right.unitPrice - left.unitPrice : left.unitPrice - right.unitPrice)
        || left.listingKey.localeCompare(right.listingKey));
      setListings(filtered.slice(offset, offset + 100));
      setLastRefresh(new Date(data.generatedAt));
    } catch (error) {
      if ((error as Error).name !== "AbortError" && sequence === requestSequence.current) setMarketError(errorMessage(error));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadListings(controller.signal);
    return () => controller.abort();
  }, [sort, appliedMinPrice, appliedMaxPrice, appliedStat, offset]);

  useEffect(() => {
    const timer = setInterval(() => void loadListings(), 15_000);
    return () => clearInterval(timer);
  }, [sort, appliedMinPrice, appliedMaxPrice, appliedStat, offset]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(`${desktopApi}/v1/state`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (active) setDesktopState(await response.json() as DesktopState);
      } catch {
        if (active) setDesktopState(undefined);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (desktopState?.npcap.availability !== "ready") {
      setDevices([]);
      return;
    }
    void fetch(`${desktopApi}/v1/devices`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: { devices: CaptureDevice[] }) => setDevices(data.devices))
      .catch(() => setDevices([]));
  }, [desktopState?.npcap.availability]);

  useEffect(() => {
    if (!selected) {
      setHistory([]);
      return;
    }
    const controller = new AbortController();
    setHistoryLoading(true);
    const path = `/v2/markets/global/items/${selected.itemType}/${encodeURIComponent(selected.itemId)}/history`;
    void fetch(new URL(path, MARKET_API_URL), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return response.json() as Promise<ItemHistoryResponse>;
      })
      .then((data) => setHistory(data.history))
      .catch((error) => { if ((error as Error).name !== "AbortError") setHistory([]); })
      .finally(() => setHistoryLoading(false));
    return () => controller.abort();
  }, [selected?.itemType, selected?.itemId]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  const visibleListings = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return listings;
    return listings.filter((listing) => searchableListing(listing).includes(needle));
  }, [listings, query]);

  const updateSettings = async (update: DesktopSettingsUpdate) => {
    setSettingsBusy(true);
    try {
      const response = await fetch(`${desktopApi}/v1/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setDesktopState(await response.json() as DesktopState);
    } finally {
      setSettingsBusy(false);
    }
  };

  return (
    <div class="app-shell">
      <aside class="rail">
        <div class="brand-block">
          <div class="brand-mark" aria-hidden="true"><span>V</span></div>
          <div>
            <div class="brand">ValeMarket</div>
            <div class="brand-subtitle">Desktop ledger</div>
          </div>
        </div>

        <nav class="rail-nav" aria-label="Workspace">
          <button class="nav-item active" type="button">
            <LedgerIcon />
            <span>Market</span>
            <span class="nav-count">{formatter.format(listings.length)}</span>
          </button>
        </nav>

        <section class="collector" aria-labelledby="collector-heading">
          <div class="section-kicker" id="collector-heading">Passive collector</div>
          <div class="collector-state">
            <span class={`state-light ${desktopState?.phase ?? "offline"}`} aria-hidden="true" />
            <div>
              <strong>{desktopState?.detail ?? "Desktop service starting"}</strong>
              <span>{collectorCaption(desktopState)}</span>
            </div>
          </div>

          <label class="switch-row">
            <span>
              <strong>Contribute sightings</strong>
              <small>On by default</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={desktopState?.contributionEnabled ?? true}
              disabled={!desktopState || settingsBusy}
              onChange={(event) => void updateSettings({ contributionEnabled: event.currentTarget.checked })}
            />
          </label>

          {desktopState?.npcap.availability === "ready" && devices.length > 0 && (
            <label class="device-field">
              <span>Network adapter</span>
              <select
                value={desktopState.deviceName ?? ""}
                disabled={settingsBusy}
                onChange={(event) => void updateSettings({ deviceName: event.currentTarget.value || null })}
              >
                <option value="">Automatic</option>
                {devices.filter((device) => !device.loopback).map((device) => (
                  <option key={device.name} value={device.name}>{device.description || device.name}</option>
                ))}
              </select>
            </label>
          )}

          {desktopState?.npcap.availability === "missing" && (
            <button class="text-action" type="button" onClick={() => openExternal("https://npcap.com/#download")}>Install Npcap ↗</button>
          )}

          {desktopState?.warning && <p class="collector-warning">{desktopState.warning}</p>}
          <p class="privacy-note">Separate passive capture. No DLL injection, game hooks, input, or modification of other tools.</p>
        </section>

        <div class="rail-foot">
          <span>Protocol v2</span>
          <span>{desktopState ? `Desktop ${desktopState.version}` : "Connecting"}</span>
        </div>
      </aside>

      <main class="workspace">
        <header class="workspace-header">
          <div>
            <div class="eyebrow">Global market · confirmed listings</div>
            <h1>Market ledger</h1>
          </div>
          <div class="header-actions">
            <div class="freshness">
              <span class={`live-dot ${marketError ? "error" : ""}`} />
              {marketError ? "Market unavailable" : lastRefresh ? `Updated ${relativeTime(lastRefresh.toISOString())}` : "Connecting"}
            </div>
            <button class="refresh-button" type="button" disabled={loading} onClick={() => void loadListings()}>
              <RefreshIcon />
              {loading ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </header>

        <section class="filters" aria-label="Market filters">
          <label class="search-field">
            <SearchIcon />
            <input value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search this page by item or stat" />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>×</button>}
          </label>
          <label>
            <span>Order</span>
            <select value={sort} onChange={(event) => { setOffset(0); setSort(event.currentTarget.value as typeof sort); }}>
              <option value="price-asc">Lowest price</option>
              <option value="price-desc">Highest price</option>
            </select>
          </label>
          <label>
            <span>Minimum</span>
            <input class="number-input" inputMode="numeric" value={minPrice} onInput={(event) => { setOffset(0); setMinPrice(integerInput(event.currentTarget.value)); }} placeholder="0" />
          </label>
          <label>
            <span>Maximum</span>
            <input class="number-input" inputMode="numeric" value={maxPrice} onInput={(event) => { setOffset(0); setMaxPrice(integerInput(event.currentTarget.value)); }} placeholder="Any" />
          </label>
          <label>
            <span>Stat</span>
            <input value={stat} onInput={(event) => { setOffset(0); setStat(event.currentTarget.value); }} placeholder="Name or type" />
          </label>
        </section>

        <section class="ledger" aria-live="polite">
          <div class="ledger-head">
            <span>Item</span>
            <span>Traits</span>
            <span class="numeric">Qty</span>
            <span class="numeric">Unit price</span>
            <span class="numeric">Seen</span>
          </div>
          {marketError ? (
            <EmptyState title="Market data could not be loaded" detail={marketError} action="Try again" onAction={() => void loadListings()} />
          ) : loading && listings.length === 0 ? (
            <div class="loading-lines" aria-label="Loading market listings">{Array.from({ length: 8 }, (_, index) => <span key={index} />)}</div>
          ) : visibleListings.length === 0 ? (
            <EmptyState title="No listings match" detail="Clear a filter or wait for new confirmed observations." action="Clear filters" onAction={() => { setQuery(""); setMinPrice(""); setMaxPrice(""); setStat(""); }} />
          ) : (
            <div class="ledger-body">
              {visibleListings.map((listing, index) => (
                <button
                  class={`listing-row ${selected?.listingKey === listing.listingKey ? "selected" : ""}`}
                  style={{ "--row-index": index } as preact.JSX.CSSProperties}
                  type="button"
                  key={`${listing.listingKey}:${listing.listingVersion}`}
                  onClick={() => setSelected(listing)}
                >
                  <span class="item-cell">
                    <ItemIcon listing={listing} />
                    <span>
                      <strong>{listing.displayName ?? listing.itemId}</strong>
                      <small>Type {listing.itemType} · {listing.itemId}</small>
                    </span>
                  </span>
                  <span class="stats-cell">{listing.stats.length ? listing.stats.slice(0, 3).map((entry) => <StatLabel key={`${entry.type}:${entry.name}`} stat={entry} />) : <em>Standard</em>}</span>
                  <span class="numeric quantity">{formatter.format(listing.quantity)}</span>
                  <span class="numeric price">{formatter.format(listing.unitPrice)}</span>
                  <span class="numeric seen">{relativeTime(listing.lastSeenAt)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <footer class="pagination">
          <span>Showing {offset + 1}–{offset + visibleListings.length} · up to 100 confirmed listings per page</span>
          <div>
            <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</button>
            <button type="button" disabled={listings.length < 100 || loading} onClick={() => setOffset(offset + 100)}>Next</button>
          </div>
        </footer>
      </main>

      {selected && (
        <Inspector listing={selected} history={history} loading={historyLoading} onClose={() => setSelected(undefined)} />
      )}
    </div>
  );
}

function Inspector({ listing, history, loading, onClose }: { listing: MarketListing; history: MarketListing[]; loading: boolean; onClose(): void }) {
  const prices = history.map((entry) => entry.unitPrice);
  const low = prices.length ? Math.min(...prices) : listing.unitPrice;
  const high = prices.length ? Math.max(...prices) : listing.unitPrice;
  return (
    <aside class="inspector" aria-label="Listing details">
      <header>
        <div class="inspector-title">
          <ItemIcon listing={listing} large />
          <div>
            <div class="eyebrow">Item record</div>
            <h2>{listing.displayName ?? listing.itemId}</h2>
            <p>{listing.itemId} · Type {listing.itemType}</p>
          </div>
        </div>
        <button type="button" class="close-button" aria-label="Close details" onClick={onClose}>×</button>
      </header>

      <div class="price-callout">
        <span>Current unit price</span>
        <strong>{formatter.format(listing.unitPrice)}</strong>
        <small>{formatter.format(listing.quantity)} available in this listing</small>
      </div>

      <section class="inspector-section">
        <div class="section-kicker">Listing traits</div>
        <div class="trait-list">
          {listing.stats.length ? listing.stats.map((entry) => <StatLabel key={`${entry.type}:${entry.name}`} stat={entry} />) : <span class="muted">No listed traits</span>}
        </div>
      </section>

      <section class="inspector-section history-section">
        <div class="history-heading">
          <div>
            <div class="section-kicker">Recent history</div>
            <strong>{loading ? "Loading…" : `${history.length} observations`}</strong>
          </div>
          {!loading && history.length > 0 && <span>{formatter.format(low)}–{formatter.format(high)}</span>}
        </div>
        <div class="price-tape">
          {history.slice(0, 18).map((entry, index) => {
            const width = high === low ? 72 : 22 + ((entry.unitPrice - low) / (high - low)) * 70;
            return (
              <div class="tape-entry" key={`${entry.listingKey}:${entry.listingVersion}:${index}`}>
                <span class="tape-time">{shortDate(entry.lastSeenAt)}</span>
                <span class="tape-track"><i style={{ width: `${width}%` }} /></span>
                <strong>{formatter.format(entry.unitPrice)}</strong>
              </div>
            );
          })}
          {!loading && history.length === 0 && <p class="muted">No eligible history is available yet.</p>}
        </div>
      </section>

      <dl class="listing-meta">
        <div><dt>First seen</dt><dd>{fullDate(listing.firstSeenAt)}</dd></div>
        <div><dt>Last seen</dt><dd>{fullDate(listing.lastSeenAt)}</dd></div>
        <div><dt>Expires</dt><dd>{listing.expiresAt ? fullDate(listing.expiresAt) : "Unknown"}</dd></div>
        <div><dt>Version</dt><dd>{listing.listingVersion}</dd></div>
      </dl>
    </aside>
  );
}

function ItemIcon({ listing, large = false }: { listing: MarketListing; large?: boolean }) {
  const icons = itemIconCatalog as Record<string, string>;
  const filename = icons[`${listing.itemType}:${listing.itemId}`] ?? icons[listing.itemId];
  const [failedSource, setFailedSource] = useState<string>();
  const showImage = filename !== undefined && failedSource !== filename;
  return (
    <span class={`item-sigil ${large ? "large" : ""}`} aria-hidden="true">
      {showImage ? (
        <img
          src={`./icons/${encodeURIComponent(filename)}`}
          alt=""
          loading={large ? "eager" : "lazy"}
          onError={() => setFailedSource(filename)}
        />
      ) : (
        <span>{itemInitials(listing)}</span>
      )}
    </span>
  );
}

function StatLabel({ stat }: { stat: MarketStat }) {
  const value = stat.value === undefined ? "" : ` ${stat.value}${stat.percent ? "%" : ""}`;
  return <span class="stat-label" title={`Stat type ${stat.type}`}>{stat.name ?? `Stat ${stat.type}`}{value}</span>;
}

function EmptyState({ title, detail, action, onAction }: { title: string; detail: string; action: string; onAction(): void }) {
  return <div class="empty-state"><div class="empty-rune">◇</div><h2>{title}</h2><p>{detail}</p><button type="button" onClick={onAction}>{action}</button></div>;
}

function LedgerIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14v15H5zM8 8h8M8 12h8M8 16h5" /></svg>;
}
function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>;
}
function RefreshIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 7v5h-5M5 17v-5h5M18 12a6 6 0 0 0-10.3-4.2L5 10M6 12a6 6 0 0 0 10.3 4.2L19 14" /></svg>;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function collectorCaption(state?: DesktopState): string {
  if (!state) return "Connecting to local backend";
  if (state.phase === "capturing") return `${formatter.format(state.observationsPrepared)} prepared · ${formatter.format(state.observationsUploaded)} uploaded`;
  if (state.phase === "npcap-unavailable") return "Npcap is required only for contribution";
  if (state.phase === "error") return "Open the warning below for details";
  return state.npcap.version ? `Npcap ${state.npcap.version}` : "Read access remains available";
}

function searchableListing(listing: MarketListing): string {
  return [listing.displayName, listing.itemId, ...listing.stats.flatMap((entry) => [entry.name, String(entry.type)])]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();
}

function itemInitials(listing: MarketListing): string {
  const value = listing.displayName ?? listing.itemId;
  const words = value.split(/\s+/).filter(Boolean);
  return words.length > 1 ? `${words[0]![0]}${words[1]![0]}`.toUpperCase() : value.slice(0, 2).toUpperCase();
}

function integerInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 16);
}

function relativeTime(value: string): string {
  const difference = Date.now() - Date.parse(value);
  if (!Number.isFinite(difference)) return "Unknown";
  const seconds = Math.max(0, Math.floor(difference / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function fullDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {}
  return `HTTP ${response.status}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener");
}

render(<App />, document.getElementById("app")!);
