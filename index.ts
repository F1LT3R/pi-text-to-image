/**
 * pi-text-to-image 🖼️🤖
 *
 * Pi Coding Agent extension: generate images from text prompts via a local
 * OpenAI-compatible FLUX endpoint, and save the PNG inside the workspace.
 *
 * Agent-controllable:  prompt · path (workspace-only) · size
 * Operator-configured: endpoint · model · apiKey · defaults (see CONFIG / env)
 *
 * The endpoint generates ONE image at a time, so every request is serialized
 * through an in-process FIFO queue.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Setup configuration — operator-controlled. The agent CANNOT change these.
// Each value can be overridden with an environment variable.
// ---------------------------------------------------------------------------
const CONFIG = {
  /** OpenAI-compatible /images/generations endpoint */
  endpoint:
    process.env.TEXT_TO_IMAGE_ENDPOINT ??
    "http://192.168.0.110:8002/v1/images/generations",
  /** Model served at the endpoint — fixed at setup time, not an agent parameter */
  model: process.env.TEXT_TO_IMAGE_MODEL ?? "flux2-klein-4b",
  /** Optional; sent as "Authorization: Bearer <key>" when non-empty */
  apiKey: process.env.TEXT_TO_IMAGE_API_KEY ?? "",
  /** Size used when the agent does not pass one (WIDTHxHEIGHT) */
  defaultSize: process.env.TEXT_TO_IMAGE_DEFAULT_SIZE ?? "1280x720",
  /** Per-request timeout in seconds */
  timeoutSeconds: Number(process.env.TEXT_TO_IMAGE_TIMEOUT_SECONDS ?? 300),
};

// ---------------------------------------------------------------------------
// Tool parameters — everything the agent is allowed to control
// ---------------------------------------------------------------------------
export const textToImageSchema = Type.Object({
  prompt: Type.String({
    description:
      "Text description of the image to generate. Be specific: subject, setting, lighting, style.",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "Where the PNG lands, inside the workspace (relative or absolute). " +
        "Relative paths resolve against the working directory. " +
        "Defaults to images/<prompt-slug>-<timestamp>.png. " +
        "Paths outside the workspace are rejected.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description:
        `Image size as WIDTHxHEIGHT (e.g. "1280x720", "512x512"). ` +
        `Default: ${CONFIG.defaultSize}.`,
    }),
  ),
});

export type TextToImageInput = Static<typeof textToImageSchema>;

// ---------------------------------------------------------------------------
// FIFO queue — the endpoint handles one image at a time
// ---------------------------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();
let pending = 0; // items that entered the queue and have not finished

function enqueue<T>(fn: () => Promise<T>): { run: Promise<T>; position: number } {
  const position = pending; // how many images are ahead of this one
  pending += 1;
  const run = chain.then(() => fn());
  const done = run.finally(() => {
    pending = Math.max(0, pending - 1);
  });
  chain = done.then(
    () => undefined,
    () => undefined, // a failed item must never clog the queue
  );
  return { run, position };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slugify(text: string, max = 32): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "image";
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 102.4) / 10} KB`;
}

/**
 * Resolve the destination and enforce the workspace boundary:
 * the image may ONLY land inside the workspace.
 */
function resolveDest(cwd: string, requested: string | undefined, prompt: string): string {
  let target: string;
  if (requested !== undefined) {
    const raw = requested.trim().replace(/^@/, ""); // tolerate "@path" prefixes
    if (raw.length === 0) {
      throw new Error(
        'destination "path" is empty — pass a file path inside the workspace, or omit it for the default location',
      );
    }
    target = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  } else {
    target = join(cwd, "images", `${slugify(prompt)}-${stamp()}.png`);
  }

  const rel = relative(cwd, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to write outside the workspace (${cwd}): ${target}`);
  }

  const ext = extname(target).toLowerCase();
  if (ext === "") {
    target = `${target}.png`;
  } else if (ext !== ".png") {
    throw new Error(`this endpoint produces PNG — use a .png destination (got "${ext}")`);
  }

  if (existsSync(target) && statSync(target).isDirectory()) {
    throw new Error(`destination is a directory: ${target}`);
  }
  return target;
}

/**
 * Call the endpoint once and return the raw PNG bytes.
 * `signal` (the agent's abort signal) and the per-request timeout are
 * combined into one AbortController.
 */
async function requestImage(prompt: string, size: string, signal?: AbortSignal): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("timeout")),
    CONFIG.timeoutSeconds * 1000,
  );
  const onAbort = (): void => controller.abort(new Error("cancelled"));
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (CONFIG.apiKey) headers.Authorization = `Bearer ${CONFIG.apiKey}`;

    const res = await fetch(CONFIG.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: CONFIG.model, prompt, size }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 500);
      } catch {
        /* no body */
      }
      throw new Error(
        `endpoint returned HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
      );
    }

    const data: any = await res.json();
    const item = data?.data?.[0];
    if (!item) {
      throw new Error(`unexpected response shape (no data[0]): ${JSON.stringify(data).slice(0, 300)}`);
    }
    if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
      return Buffer.from(item.b64_json, "base64");
    }
    if (typeof item.url === "string" && item.url.length > 0) {
      const img = await fetch(item.url, { signal: controller.signal });
      if (!img.ok) throw new Error(`failed to download ${item.url} (HTTP ${img.status})`);
      return Buffer.from(await img.arrayBuffer());
    }
    throw new Error("response contained neither b64_json nor url");
  } catch (err) {
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new Error("generation cancelled");
      throw new Error(`generation timed out after ${CONFIG.timeoutSeconds}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "text_to_image",
    label: "Text to Image",
    description: [
      "Generate an image from a text prompt using the local FLUX endpoint and save the PNG to the workspace.",
      `Model ${CONFIG.model} is fixed at setup time and cannot be changed by the agent.`,
      "The destination must stay inside the workspace; relative paths resolve against the working directory.",
      "The endpoint generates one image at a time; concurrent calls are queued automatically (FIFO).",
      "Returns the absolute path of the saved PNG. No pixels reach the main model — use the image_describe tool on the returned path to view or verify the image.",
    ].join(" "),
    promptSnippet:
      "Generate an image from a text prompt (local FLUX endpoint) and save the PNG inside the workspace",
    promptGuidelines: [
      "Use text_to_image to create images from text descriptions; it saves a PNG inside the workspace and returns the saved file path.",
      "After text_to_image returns a path, use image_describe on that path (with a prompt describing what to check) to verify the image matches the prompt before reporting it as done.",
    ],
    parameters: textToImageSchema,
    // ------------------------------------------------------------------ TUI
    // Show the requested image text (prompt) when the tool is called.
    renderCall(args: any, theme: any, context: any) {
      const text = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const prompt = typeof args?.prompt === "string" ? args.prompt : "";
      let content = theme.fg("toolTitle", theme.bold("text_to_image "));
      content += theme.fg("muted", prompt ? `"${prompt}"` : "(no prompt)");
      if (typeof args?.path === "string" && args.path) {
        content += theme.fg("dim", ` → ${args.path}`);
      }
      if (typeof args?.size === "string" && args.size) {
        content += theme.fg("dim", ` (${args.size})`);
      }
      text.setText(content);
      return text;
    },
    renderResult(result: any, { expanded, isPartial }: any, theme: any, _context: any) {
      if (isPartial) {
        return new Text(theme.fg("warning", "⏳ Generating… (queued: one image at a time)"), 0, 0);
      }
      const details = result?.details as
        | {
            error?: string;
            path?: string;
            width?: number;
            height?: number;
            elapsedSeconds?: number;
            queuePosition?: number;
          }
        | undefined;
      if (details?.error) {
        return new Text(theme.fg("error", details.error), 0, 0);
      }
      if (!details?.path) {
        const content = result?.content?.[0];
        const fallback = content?.type === "text" ? content.text : "(no result)";
        return new Text(theme.fg("error", fallback), 0, 0);
      }
      let text = theme.fg("success", `✓ ${details.path}`);
      if (details.width && details.height) {
        text += theme.fg("dim", ` ${details.width}x${details.height}`);
      }
      if (typeof details.elapsedSeconds === "number") {
        text += theme.fg("dim", ` · ${details.elapsedSeconds}s`);
      }
      if (typeof details.queuePosition === "number" && details.queuePosition > 0) {
        text += theme.fg("muted", ` · waited behind ${details.queuePosition}`);
      }
      if (expanded) {
        text += `\n${theme.fg("muted", "Verify with the image_describe tool on this path.")}`;
      }
      return new Text(text, 0, 0);
    },
    async execute(
      _toolCallId: string,
      params: TextToImageInput,
      signal: AbortSignal | undefined,
      onUpdate: ((partial: unknown) => void) | undefined,
      ctx: { cwd?: string } | undefined,
    ) {
      // Failures are returned as plain tool results (image-relay convention)
      // so the agent can read the message and self-correct.
      const err = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: { error: text },
      });

      const prompt = typeof params?.prompt === "string" ? params.prompt.trim() : "";
      if (!prompt) {
        return err('text_to_image: missing required parameter "prompt".');
      }

      const sizeRaw =
        typeof params?.size === "string" && params.size.trim().length > 0
          ? params.size.trim()
          : CONFIG.defaultSize;
      const sizeMatch = /^(\d{3,5})x(\d{3,5})$/i.exec(sizeRaw);
      if (!sizeMatch) {
        return err(
          `text_to_image: invalid size "${sizeRaw}" (expected WIDTHxHEIGHT, e.g. "1280x720").`,
        );
      }
      const size = `${sizeMatch[1]}x${sizeMatch[2]}`;

      const cwd = ctx?.cwd ?? process.cwd();
      let dest: string;
      try {
        dest = resolveDest(cwd, typeof params?.path === "string" ? params.path : undefined, prompt);
      } catch (e) {
        return err(`text_to_image: ${e instanceof Error ? e.message : String(e)}`);
      }

      onUpdate?.({
        content: [
          {
            type: "text" as const,
            text: `🖼️ Generating ${size} image via ${CONFIG.model} → ${dest}`,
          },
        ],
      });

      const started = Date.now();
      const { run, position } = enqueue(() => requestImage(prompt, size, signal));
      if (position > 0) {
        onUpdate?.({
          content: [
            {
              type: "text" as const,
              text: `⏳ ${position} image(s) ahead in the queue — waiting…`,
            },
          ],
        });
      }

      try {
        const buf = await run;
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        const elapsedSeconds = Math.round(((Date.now() - started) / 1000) * 10) / 10;
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Saved ${size} PNG to ${dest} (${formatBytes(buf.length)}, ${elapsedSeconds}s via ${CONFIG.model}). Use the image_describe tool on this path to view/verify the image.`,
            },
          ],
          details: {
            path: dest,
            width: Number(sizeMatch[1]),
            height: Number(sizeMatch[2]),
            bytes: buf.length,
            model: CONFIG.model,
            queuePosition: position,
            elapsedSeconds,
          },
        };
      } catch (e) {
        const msg = `text_to_image: ${e instanceof Error ? e.message : String(e)}`;
        return err(msg);
      }
    },
  });
}
