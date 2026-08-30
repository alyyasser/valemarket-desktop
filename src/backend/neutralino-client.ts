interface ExtensionBootstrap {
  nlPort: number;
  nlToken: string;
  nlConnectToken: string;
  nlExtensionId: string;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class NeutralinoClient {
  private readonly pending = new Map<string, PendingCall>();
  private readonly closeListeners = new Set<() => void>();
  private nextId = 0;

  private constructor(
    private readonly socket: WebSocket,
    private readonly accessToken: string,
  ) {}

  static async fromStdin(): Promise<NeutralinoClient> {
    const raw = (await Bun.stdin.text()).trim();
    if (!raw) throw new Error("Neutralino did not provide extension bootstrap data on stdin");
    const bootstrap = JSON.parse(raw) as ExtensionBootstrap;
    const url = `ws://127.0.0.1:${bootstrap.nlPort}?extensionId=${encodeURIComponent(bootstrap.nlExtensionId)}&connectToken=${encodeURIComponent(bootstrap.nlConnectToken)}`;
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect the Neutralino extension socket")), { once: true });
    });
    const client = new NeutralinoClient(socket, bootstrap.nlToken);
    socket.addEventListener("message", (event) => client.receive(String(event.data)));
    socket.addEventListener("close", () => {
      for (const pending of client.pending.values()) pending.reject(new Error("Neutralino extension socket closed"));
      client.pending.clear();
      for (const listener of client.closeListeners) listener();
    });
    return client;
  }

  call<T = unknown>(method: string, data: Record<string, unknown> = {}): Promise<T> {
    const id = `valemarket-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, accessToken: this.accessToken, data }));
    });
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  private receive(raw: string): void {
    let packet: Record<string, unknown>;
    try { packet = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (typeof packet.id !== "string") return;
    const pending = this.pending.get(packet.id);
    if (!pending) return;
    this.pending.delete(packet.id);
    const envelope = packet.data as { success?: boolean; returnValue?: unknown; error?: unknown } | undefined;
    if (envelope?.success === false) pending.reject(new Error(String(envelope.error ?? "Neutralino native call failed")));
    else pending.resolve(envelope && "returnValue" in envelope ? envelope.returnValue : packet.data);
  }
}
