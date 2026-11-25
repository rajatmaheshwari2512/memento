// Shared by the tests: start the real service against fakes, and talk to it.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

export async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  probe.close();
  return port;
}

// Logins of the two test users, A and B, as a fake Immich sees them.
export const COOKIE = { A: "immich_access_token=usera0123456789abcdef", B: "immich_access_token=userb0123456789abcdef" };

// A fake llama-server (the caption model). `reply` gets the photo's bytes as text and gives
// the model's message, or null for a 500. `healthy` false makes /health fail too.
export function fakeLlama(opts: {
  reply: (image: string) => Record<string, unknown> | null;
  healthy?: () => boolean;
  modelId?: string;
}): Server {
  return createServer((req, res) => {
    void (async () => {
      if (req.url === "/v1/models") return json(res, 200, { data: [{ id: opts.modelId ?? "/models/fake-vl.gguf" }] });
      if (req.url === "/health") return json(res, opts.healthy?.() === false ? 503 : 200, {});
      const body = JSON.parse(await readBody(req)) as { messages: { content: { type: string; image_url?: { url: string } }[] }[] };
      const url = body.messages[0]!.content.find((c) => c.type === "image_url")!.image_url!.url;
      const message = opts.reply(Buffer.from(url.split(",")[1]!, "base64").toString());
      if (message === null) return json(res, 500, { error: "down" });
      json(res, 200, { choices: [{ message }], usage: { prompt_tokens: 300, completion_tokens: 20 } });
    })();
  });
}

// A fake server's JSON reply.
export function json(res: ServerResponse, status: number, data?: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(data === undefined ? "" : JSON.stringify(data));
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// The real service (src/server.ts) on `port`, with these settings. stop() then start()
// again restarts it on the same port and data folder.
export class Service {
  private child: ChildProcess | undefined;
  private readonly port: number;
  private readonly env: Record<string, string>;
  readonly base: string;
  // Everything it has logged, for the tests that check what's logged (and what isn't).
  logs = "";

  constructor(port: number, env: Record<string, string>) {
    this.port = port;
    this.env = env;
    this.base = `http://127.0.0.1:${port}`;
  }

  // The running service's process ID (the memory bench reads its memory).
  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.ts"], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, ...this.env, PORT: String(this.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    let output = "";
    child.stderr!.on("data", (d: Buffer) => (this.logs += d.toString()));
    child.stdout!.on("data", (d: Buffer) => (this.logs += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (output += d.toString()));
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on("data", (d: Buffer) => {
        output += d.toString();
        if (output.includes('"event":"started"')) resolve();
      });
      child.on("exit", (code) => reject(new Error(`service exited (${code}):\n${output}`)));
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
}

export type CallOptions = { cookie?: string; apiKey?: string; json?: unknown; contentType?: string };

export async function call(base: string, method: string, path: string, opts: CallOptions = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  if (opts.json !== undefined || opts.contentType) headers["content-type"] = opts.contentType ?? "application/json";
  const res = await fetch(base + path, { method, headers, body: opts.json === undefined ? undefined : JSON.stringify(opts.json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
