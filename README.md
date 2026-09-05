# 🖼️🤖 pi-text-to-image

> **Generate images from text with Pi.** A Pi Coding Agent extension that lets any agent
> summon 🎨 artwork from a plain text prompt — powered by your **local FLUX endpoint**,
> saved safely **inside the workspace**, and serialized through a built-in 🚦 queue.

✨ *Agents can't see pixels. This plugin makes them able to make them.*

---

## 📦 What it does

- 🧠 **Agent-facing tool** — `text_to_image` is registered as a first-class Pi tool the LLM can call like `bash` or `read`.
- ⚡ **Local generation** — POSTs to an OpenAI-compatible `/v1/images/generations` endpoint (default: `flux2-klein-4b` on `http://192.168.0.110:8002`). No cloud, no API bills. 💸
- 📁 **Workspace-only output** — the agent chooses *where* the PNG lands, but it **cannot** land outside the workspace. Ever. 🔒
- 🚦 **FIFO queue** — the endpoint generates **one image at a time**; concurrent requests are automatically serialized, and the agent is told how many images are ahead of it. ⏳
- 👀 **Verify with `image_describe`** — pixels never reach the main model. The tool returns a path; the agent feeds it to the `image_describe` tool to *see* the result. 🔄 That tool comes from the companion plugin [pi-paste-image-to-model](https://github.com/F1LT3R/pi-paste-image-to-model#%EF%B8%8F-agent-tool-image_describe) — optional, not a dependency (see [Related](#-related)).
- 🐢 **No dependencies** — plain TypeScript + Node builtins. Zero `npm install`. 🪶

---

## 🛠️ The `text_to_image` tool

### 🎛️ Agent-controllable parameters

| Parameter | Required | Default | Description |
|-----------|:--------:|---------|-------------|
| `prompt` | ✅ | — | Text description of the image. Be specific: subject, setting, lighting, style. 📝 |
| `path` | — | `images/<slug>-<timestamp>.png` | Where the PNG lands, **inside the workspace** (relative or absolute). Omit for the default location. 📍 |
| `size` | — | `1280x720` | Image size as `WIDTHxHEIGHT` (e.g. `"512x512"`, `"1280x720"`). 📐 |

### 🔐 Operator-configured (setup — the agent CANNOT change these)

| Setting | Env override | Default |
|---------|--------------|---------|
| `endpoint` | `TEXT_TO_IMAGE_ENDPOINT` | `http://192.168.0.110:8002/v1/images/generations` |
| `model` | `TEXT_TO_IMAGE_MODEL` | `flux2-klein-4b` |
| `apiKey` | `TEXT_TO_IMAGE_API_KEY` | *(empty — sent as `Bearer` only when set)* |
| `defaultSize` | `TEXT_TO_IMAGE_DEFAULT_SIZE` | `1280x720` |
| `timeoutSeconds` | `TEXT_TO_IMAGE_TIMEOUT_SECONDS` | `300` |

The model name is **locked at setup time** by design: it is not a tool parameter, so no
agent can point the tool at a different model. ✋

---

## 📲 Install

Drop it into the Pi plugin system (user scope, all projects):

Via npm (published):

```bash
pi install npm:pi-text-to-image
```

Via git:

```bash
pi install git:github.com/F1LT3R/pi-text-to-image
```

Check it's registered:

```bash
pi list
```

That's it — no `npm install`, no build step (Pi loads TypeScript directly via jiti). 🪄

### 🧪 Quick end-to-end test

```bash
cd /Users/user/repos/pi-text-to-image
pi -p "Use the text_to_image tool once: prompt='a red fox in a snowy pine forest at dusk', path='images/fox.png', size='512x512'. Then confirm the file exists." --model s2-qwen-3.8/qwen-3.8b-500k --thinking off --no-session
```

---

## 🚦 Queue behavior

The FLUX endpoint serves **one image at a time**. The plugin keeps an in-process FIFO
queue:

```
request A ──► [ A | B | C ] ──► endpoint ──► A done
request B ──►    ↑ (told "1 image ahead")
request C ──►    ↑ (told "2 images ahead")
```

- ⏭️ Requests run strictly one-after-another, in order.
- 💥 A failed request never clogs the queue — the next one goes straight ahead.
- ⏳ The tool reports the queue position to the agent via progress updates.

*(Queue scope is per Pi process — perfect for local single-user use.)*

---

## 🔒 Workspace safety

Images may **only** land inside the workspace:

- 📂 Relative paths resolve against the working directory.
- 🚫 Any destination that resolves outside the workspace (`..`, absolute paths escaping the root) is **rejected**.
- 🖼️ The endpoint produces PNG: missing extensions get `.png` appended; non-PNG extensions are rejected.
- 📁 Parent directories are created automatically (`images/foo/bar.png` just works).
- 🕊️ Default name: `images/<prompt-slug>-<timestamp>.png` — no accidental overwrites.

---

## 👀 Workflow: generate → verify

```
        ┌─────────────────┐   text_to_image    ┌────────────────────┐
 agent ─┤ prompt + path   ───────────────────► │ FLUX endpoint      │
        │ + size          │    (queued, 1 at a │ (flux2-klein-4b)   │
        └─────────────────┘         time)      └─────────┬──────────┘
                                                         │ b64_json PNG
        ┌─────────────────┐   image_describe   ┌─────────▼──────────┐
 agent ◄┤ "red fox? yes"  ◄─────────────────── │ workspace/fox.png  │
        └─────────────────┘ (vision model desc)└────────────────────┘
```

1. 🖌️ Agent calls `text_to_image` → gets back the saved file path.
2. 🔍 Agent calls `image_describe` on that path → gets a text description from the vision model.
3. ✅ Agent can now confirm the image matches the prompt before telling the user it's done.

---

## 🎨 What you see in the TUI

Custom `renderCall` / `renderResult` keep the requested image text visible on the call line:

```
🔧 text_to_image "a red fox in a snowy pine forest at dusk" → images/fox.png (512x512)
   ⏳ Generating… (queued: one image at a time)
   ✓ /Users/you/proj/images/fox.png 512x512 · 42.3s · waited behind 1
```

- 💬 The **prompt** is always shown, with `→ dest` and `(size)` dimmed beside it.
- ⏳ While running, the partial state shows the queue status instead of a blank box.
- ✅ On success: saved path, dimensions, and elapsed time. On failure: the error message.
- 📖 `ctrl+e` / expand adds a reminder to verify with `image_describe`.

---

## 🧪 Testing

```bash
# 1️⃣ The endpoint itself (raw curl)
curl -s http://192.168.0.110:8002/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"flux2-klein-4b","prompt":"a red fox","size":"512x512"}' \
  | jq -r '.data[0].b64_json' | base64 --decode > /tmp/flux.png

# 2️⃣ The plugin end-to-end (print mode) — see "Quick end-to-end test" above
pi -p "Use the text_to_image tool once: prompt='a red fox in a snowy pine forest at dusk', path='images/fox.png', size='512x512'. Then confirm the file exists."

# 3️⃣ Verify the result with image_describe (inside any Pi session)
#    → just ask the agent: "check images/fox.png with image_describe"
```

---

## 🗂️ Repo layout

```
pi-text-to-image/
├── index.ts        # 🧩 the extension: tool registration, queue, safety
├── package.json    # 📦 pi package metadata (pi.extensions)
├── test/
│   └── e2e.mjs     # 🧪 runs the real plugin code with a stubbed endpoint (queue, workspace safety, default path, TUI rendering)
└── README.md       # 📖 you are here
```

---

## ⚠️ Notes & scope

- 🏠 **Local plugin for local use** — single endpoint, single user, PNG output only.
- 🐢 512×512 ≈ 30–60 s on the local machine; 1280×720 takes longer. The agent is *told* the request is queued, not frozen.
- 🚫 Intentionally simple: no batching (endpoint can't), no model switching (locked by design), no cloud fallback.
- 🩹 Errors are returned as normal tool results (the `image_describe` convention) so the agent can read them and self-correct.

---

## 🧩 Related

- [pi-paste-image-to-model](https://github.com/F1LT3R/pi-paste-image-to-model) — the companion plugin that provides the `image_describe` tool referenced throughout this README (see [its `image_describe` section](https://github.com/F1LT3R/pi-paste-image-to-model#%EF%B8%8F-agent-tool-image_describe)). It sends an image file to a vision model and injects the text description into the agent's context — the "eyes" that let an agent verify a generated image matches the prompt. This plugin does **not** depend on it; install it if you want the verify step in the loop.

---

*Made with ⚡ and 🦊, powered by FLUX.*
