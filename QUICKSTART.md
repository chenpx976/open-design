# Quickstart

<p align="center"><b>English</b> · <a href="QUICKSTART.pt-BR.md">Português (Brasil)</a> · <a href="QUICKSTART.de.md">Deutsch</a> · <a href="QUICKSTART.fr.md">Français</a> · <a href="QUICKSTART.ja-JP.md">日本語</a> · <a href="QUICKSTART.zh-CN.md">简体中文</a> · <a href="QUICKSTART.zh-TW.md">繁體中文</a></p>

Run the full product locally.

## Environment requirements

- **Node.js:** `~24` (Node 24.x). The repo enforces this through `package.json#engines`.
- **pnpm:** `10.33.x`. The repo pins `pnpm@10.33.2` through `packageManager`; use Corepack so the pinned version is selected automatically.
- **OS:** macOS, Linux, and WSL2 are the primary paths. Windows native should work for most flows, but WSL2 is the safer baseline.
- **Agent runtime:** Open Design embeds Pi through the Node.js daemon; configure model access in Settings.

### Pi SDK runtime

The daemon hosts the Pi coding agent in-process for local development and can
enqueue Pi jobs to a separate worker for Docker/cluster deployments. Configure
models in **Settings → Pi agent & model settings** or use BYOK API mode from
Settings. The old local-CLI discovery flow is no longer part of the runtime.

`nvm` / `fnm` are optional convenience tools, not required project setup. If you use one, install/select Node 24 before running pnpm:

```bash
# nvm
nvm install 24
nvm use 24

# fnm
fnm install 24
fnm use 24
```

Then enable Corepack and let the repo select pnpm:

```bash
corepack enable
corepack pnpm --version   # should print 10.33.2
```

## Docker Setup

Run Open Design in a fully containerised environment without installing Node.js or pnpm locally.

### Requirements

* Docker Desktop
* Docker Compose v2

Verify Docker is installed correctly:

```bash
docker compose version
```

---

## Start Open Design

From the repository root:

```bash
cd deploy
docker compose --profile worker up -d --build
```

Open the app in your browser:

```text
http://localhost:7456
```

The first startup may take a few seconds while Docker pulls the latest image.
This starts the full local cluster shape: API/web, Pi worker, Redis, and
Postgres.

---

## Common Docker Commands

### View logs

```bash
docker compose logs -f
```

### Restart containers

```bash
docker compose restart
```

### Stop containers

```bash
docker compose down
```

### Pull the latest image

```bash
docker compose pull
docker compose up -d
```

### Remove all local app data

```bash
docker compose down -v
```

---

## Environment Configuration

Create a `deploy/.env` file to override the default configuration:

```env
# Port exposed on the host
OPEN_DESIGN_PORT=7456

# Container memory limit
OPEN_DESIGN_MEM_LIMIT=384m

# Allowed CORS origins
OPEN_DESIGN_ALLOWED_ORIGINS=https://yourdomain.com

# Docker image tag
OPEN_DESIGN_IMAGE=docker.io/vanjayak/open-design:latest
```

---

## Persistent Storage

Open Design stores projects and SQLite data inside a Docker volume:

```text
open_design_data
```

The volume is mounted to:

```text
/app/.od
```

Data persists across container restarts and image updates.

Inspect the volume:

```bash
docker volume inspect open-design_open_design_data
```

---

## Notes

* Docker mode is ideal for contributors who do not want a local Node.js or pnpm setup.
* The container exposes the production daemon build directly on port `7456`.
* For development workflows and advanced local setup, see the rest of this Quickstart guide.

---

## One-shot (dev mode)

```bash
corepack enable
pnpm install
pnpm tools-dev run web # starts daemon + web in the foreground
# open the web URL printed by tools-dev
```

For the desktop shell and all managed sidecars in the background:

```bash
pnpm tools-dev # starts daemon + web + desktop in the background
```

On first load, the app selects the daemon-hosted Pi agent and defaults to a prototype skill plus the starter design system. Type a prompt and hit **Send**. Pi thinking, tool calls, and tool results stream into the left pane while project files are written into `.od/projects/<id>/`; HTML renders live on the right as soon as the generated file appears.

The **Design system** dropdown ships with 71 built-in systems — 2 hand-authored starters (Neutral Modern, Warm Editorial) and 69 product systems imported from [`awesome-design-md`](https://github.com/VoltAgent/awesome-design-md), grouped by category (AI & LLM, Developer Tools, Productivity, Backend, Design Tools, Fintech, E-Commerce, Media, Automotive). Pick one to skin every prototype in that brand's aesthetic, and another set of 57 design skills sourced from [`awesome-design-skills`](https://github.com/bergside/awesome-design-skills).

The **Skill** dropdown groups by mode (Prototype / Deck / Template / Design system) and shows the default skill per mode with a `· default` suffix. Bundled skills:

- **Prototype** — `web-prototype` (generic), `saas-landing`, `dashboard`, `pricing-page`, `docs-page`, `blog-post`, `mobile-app`.
- **Deck / PPT** — `simple-deck` (single-file horizontal swipe) and `magazine-web-ppt` (the `guizang-ppt` bundle from [`op7418/guizang-ppt-skill`](https://github.com/op7418/guizang-ppt-skill) — default for deck mode, ships its own assets/template + 4 references). Skills with side files get an automatic "Skill root (absolute)" preamble so the agent can resolve `assets/template.html` and `references/*.md` against the real on-disk path instead of its CWD.

Pair a skill with a design system and a single prompt produces a layout-appropriate prototype or deck in the chosen visual language.

## Other scripts

```bash
pnpm tools-dev                 # daemon + web + desktop in the background
pnpm tools-dev start web       # daemon + web in the background
pnpm tools-dev run web         # daemon + web in the foreground (e2e/dev server)
pnpm tools-dev restart         # restart daemon + web + desktop
pnpm tools-dev restart --daemon-port 7457 --web-port 5175
pnpm tools-dev status          # inspect managed runtimes
pnpm tools-dev logs            # show daemon/web/desktop logs
pnpm tools-dev check           # status + recent logs + common diagnostics
pnpm tools-dev stop            # stop managed runtimes
pnpm --filter @open-design/daemon build  # build apps/daemon/dist/cli.js for `od`
pnpm --filter @open-design/web build     # build the web package when needed
pnpm typecheck                 # workspace typecheck
```

`pnpm tools-dev` is the only local lifecycle entry point. Do not use the removed legacy root aliases (`pnpm dev`, `pnpm dev:all`, `pnpm daemon`, `pnpm preview`, `pnpm start`).

During local development, `tools-dev` starts the daemon first, passes its port into `apps/web`, and `apps/web/next.config.ts` rewrites `/api/*`, `/artifacts/*`, and `/frames/*` to that daemon port so the App Router app can talk to the sibling Express process without CORS setup.

## Media generation / agent dispatcher checks

Image, video, audio, and HyperFrames skills call the local `od` CLI through environment variables injected by the daemon when it spawns an agent:

- `OD_BIN` — absolute path to `apps/daemon/dist/cli.js`.
- `OD_DAEMON_URL` — the running daemon URL.
- `OD_PROJECT_ID` — the active project id.
- `OD_PROJECT_DIR` — the active project's file directory.

If media generation fails with `OD_BIN: parameter not set`, `apps/daemon/dist/cli.js` missing, or `failed to reach daemon at http://127.0.0.1:0`, rebuild the daemon CLI and restart the managed runtime:

```bash
pnpm --filter @open-design/daemon build
pnpm tools-dev restart --daemon-port 7457 --web-port 5175
ls -la apps/daemon/dist/cli.js
curl -s http://127.0.0.1:7457/api/health
```

Then open the project from the Open Design app again instead of resuming an old terminal session. The Pi runtime should see values like:

```bash
echo "OD_BIN=$OD_BIN"
echo "OD_PROJECT_ID=$OD_PROJECT_ID"
echo "OD_PROJECT_DIR=$OD_PROJECT_DIR"
echo "OD_DAEMON_URL=$OD_DAEMON_URL"
ls -la "$OD_BIN"
```

`OD_DAEMON_URL` must be a real daemon port such as `http://127.0.0.1:7457`, not `http://127.0.0.1:0`. The `:0` value is only an internal "pick a free port" launch hint and should not leak into agent sessions.

For the daemon-only production mode, the daemon serves the static Next.js export itself at `http://localhost:7456`, so no reverse proxy is involved.

If you place nginx in front of the daemon, keep SSE routes unbuffered and uncompressed. A common failure is the browser console showing `net::ERR_INCOMPLETE_CHUNKED_ENCODING 200 (OK)` after 80-90 seconds because nginx `gzip on` buffers chunked SSE responses even when the daemon sends `X-Accel-Buffering: no`.

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:7456;

    proxy_buffering off;
    gzip off;

    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Execution modes

| Mode | Picker value | How a request flows |
|---|---|---|
| **Pi agent** | "Pi agent" | Frontend → daemon `/api/runs` → embedded Pi SDK → `ProjectFs` tools → SSE events → file workspace + preview |
| **BYOK API mode** | "Anthropic API" / "OpenAI API" / "Azure OpenAI" / "Google Gemini" | Frontend → daemon `/api/proxy/{provider}/stream` → provider SSE normalized to `delta/end/error` → artifact parser → preview |

Both modes feed the same chat surface and sandboxed iframe. The Pi path is the default because it owns the filesystem/tool loop inside the Node.js daemon and can move to a worker process for cluster deployments.

## Prompt composition

For every send, the app builds a system prompt from three layers and sends it to the provider:

```
BASE_SYSTEM_PROMPT   (output contract: wrap in <artifact>, no code fences)
   + active design system body  (DESIGN.md — palette/type/layout)
   + active skill body          (SKILL.md — workflow and output rules)
```

Swap the skill or the design system in the top bar and the next send uses the new stack. Bodies are cached in-memory per session so this is a single daemon fetch per pick.

## File map

```
open-design/
├── apps/
│   ├── daemon/                # Node/Express — hosts Pi SDK + serves APIs
│   │   └── src/
│   │       ├── cli.ts             # `od` bin entry
│   │       ├── server.ts          # /api/* + static serving
│   │       ├── agents.ts          # embedded Pi SDK agent catalog
│   │       ├── skills.ts          # SKILL.md loader (frontmatter parser)
│   │       └── design-systems.ts  # DESIGN.md loader
│   │   ├── sidecar/           # tools-dev daemon sidecar wrapper
│   │   └── tests/             # daemon package tests
│   ├── web/                   # Next.js 16 App Router + React client
│       ├── app/               # App Router entrypoints
│       ├── src/               # React + TypeScript client/runtime modules
│       │   ├── App.tsx        # orchestrates mode / skill / DS pickers + send
│       │   ├── providers/     # daemon + BYOK API transports
│       │   ├── prompts/       # system, discovery, directions, deck framework
│       │   ├── artifacts/     # streaming <artifact> parser + manifests
│       │   ├── runtime/       # iframe srcdoc, markdown, export helpers
│       │   └── state/         # localStorage + daemon-backed project state
│       ├── sidecar/           # tools-dev web sidecar wrapper
│       └── next.config.ts     # tools-dev rewrites + prod apps/web/out export config
│   └── desktop/               # Electron runtime, launched/inspected by tools-dev
├── packages/
│   ├── contracts/             # shared web/daemon app contracts
│   ├── sidecar-proto/         # Open Design sidecar protocol contract
│   ├── sidecar/               # generic sidecar runtime primitives
│   └── platform/              # generic process/platform primitives
├── tools/dev/                 # `pnpm tools-dev` lifecycle and inspect CLI
├── e2e/                       # Playwright UI + external integration/Vitest harness
├── skills/                    # SKILL.md — drops in from any Claude Code skill repo
│   ├── web-prototype/         # generic single-screen prototype (default for prototype mode)
│   ├── saas-landing/          # marketing page (hero / features / pricing / CTA)
│   ├── dashboard/             # admin / analytics dashboard
│   ├── pricing-page/          # standalone pricing + comparison
│   ├── docs-page/             # 3-column documentation layout
│   ├── blog-post/             # editorial long-form
│   ├── mobile-app/            # phone-frame single screen
│   ├── simple-deck/           # minimal horizontal-swipe deck
│   └── guizang-ppt/           # magazine-web-ppt — bundled deck/PPT default
│       ├── SKILL.md
│       ├── assets/template.html
│       └── references/{themes,layouts,components,checklist}.md
├── design-systems/            # DESIGN.md — 9-section schema (awesome-claude-design)
│   ├── default/               # Neutral Modern (starter)
│   ├── warm-editorial/        # Warm Editorial (starter)
│   ├── README.md              # catalog overview
│   └── …129 systems           # 2 starters · 70 product systems · 57 design skills
├── scripts/sync-design-systems.ts    # re-import from upstream getdesign tarball
├── docs/                      # product vision + spec
├── .od/                       # runtime data (gitignored, auto-created)
│   ├── app.sqlite              #   projects / conversations / messages / tabs
│   ├── artifacts/              #   one-off "Save to disk" renders
│   └── projects/<id>/          #   per-project working dir + agent cwd
├── pnpm-workspace.yaml        # apps/* + packages/* + tools/* + e2e
└── package.json               # root quality scripts + `od` bin
```

## Troubleshooting

- **`better-sqlite3` fails to load / ABI mismatch after a Node.js version change** — `pnpm install` re-runs `postinstall` automatically and rebuilds the native addon for the current Node.js. To rebuild manually or verify the fix: `pnpm --filter @open-design/daemon rebuild better-sqlite3` then `pnpm --filter @open-design/daemon exec node -e "require('better-sqlite3')"`. Requires build tools: `python3`, `make`, `g++` (or `clang++`). If you have `ignore-scripts=true` in your `.npmrc`, run `node scripts/postinstall.mjs` after `pnpm install`.
- **Pi agent run fails immediately** — check the daemon terminal for the Pi SDK error and verify the selected model/provider credentials in Settings.
- **media generation says `OD_BIN` is missing or daemon URL is `:0`** — run the media dispatcher checks above. Reopen the project from the Open Design app so the daemon can expose fresh `OD_*` variables to the Pi runtime.
- **artifact never renders** — the model produced text without wrapping in `<artifact>`. Confirm the system prompt is going through (check daemon log) and consider switching to a more capable model or a stricter skill.

## Mapping back to the vision

This Quickstart is the runnable seed of the spec in [`docs/`](docs/). The spec describes where this grows (see [`docs/roadmap.md`](docs/roadmap.md)). Highlights:

- `docs/architecture.md` describes the shipped stack: Next.js 16 App Router in front, local daemon behind it, and `apps/web/next.config.ts` rewrites in dev to keep the browser talking to the same `/api` surface.
- `docs/skills-protocol.md` describes the full `od:` frontmatter (typed inputs, sliders, capability gating). This MVP reads `name` / `description` / `triggers` / `od.mode` / `od.design_system.requires` only — extend `apps/daemon/src/skills.ts` to add the rest.
- `docs/agent-runtime.md` describes the Pi SDK runtime and the worker/runtime boundary used by local and clustered deployments.
- `docs/modes.md` lists four modes: prototype / deck / template / design-system. We ship skills for the first two; the picker already filters by `mode`.
