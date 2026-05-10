# Roadmap

**Parent:** [`spec.md`](spec.md) · **Siblings:** [`architecture.md`](architecture.md) · [`skills-protocol.md`](skills-protocol.md) · [`agent-adapters.md`](agent-adapters.md) · [`modes.md`](modes.md)

Phased plan from "spec-only today" to "usable MVP" to "published v1." All estimates assume one focused developer; multiply by 0.6 for two and 0.4 for three.

---

## Phase 0 — Spec finalization (current, ~3–5 days)

**Goal:** get the interfaces right before writing implementation code. All decisions that are cheap to change on paper and expensive to change in code live here.

**Deliverables:**
- [x] `README.md` + `docs/spec.md` + architecture / protocol / adapter / modes / references docs (this repo, as of now)
- [ ] `docs/schemas/skill-manifest.json` — JSON Schema for the `od:` front-matter block
- [ ] `docs/schemas/design-system.md` — formal spec of the 9-section `DESIGN.md`
- [ ] `docs/schemas/protocol.md` — HTTP/SSE API schemas
- [ ] `docs/schemas/adapter.md` — adapter interface in TypeScript, printed out
- [ ] `docs/examples/DESIGN.sample.md` — a working example design system
- [ ] `docs/examples/saas-landing-skill/` — a working example skill (the one sketched in `skills-protocol.md` §8)
- [ ] Resolve the four "open questions" at the end of each spec doc

**Exit criteria:** every interface we'll implement has a signed-off schema in this repo. No code yet.

---

## Phase 1 — MVP (~6–8 weeks)

**Goal:** a single developer can clone, install, start the daemon-hosted Pi runtime, and produce a prototype and a deck from scratch. The tool is usable for real work even if not polished.

### Scope

**Included:**
- Web app (Next.js 16, App Router)
  - chat pane · artifact tree · sandboxed iframe preview · export menu
  - skill picker · mode picker · design-system picker
  - **no** comment mode yet · **no** sliders yet · **no** template gallery UI yet
- Local daemon (Node)
  - HTTP/SSE API on `:7456`
  - embedded Pi SDK runtime + cached model registry
  - skill registry (scan three dirs, hot-reload)
  - artifact store (plain files + `history.jsonl`)
  - design-system resolver
  - export pipeline (HTML + ZIP only; PDF/PPTX in Phase 2)
- Agent runtime
  - **`pi`** — daemon-hosted Pi SDK, streaming thinking/tool/result events, bounded `ProjectFs`
  - **`api-fallback` / BYOK proxy** — provider proxy path for OpenAI-compatible, Anthropic, Azure OpenAI, and Gemini endpoints
- Skills shipped in repo
  - `saas-landing` (Prototype)
  - `magazine-web-ppt` (Deck, fork of guizang-ppt-skill)
- Modes available
  - **Prototype** (fully working)
  - **Deck** (fully working)
  - **Design System** (basic: from text brief only; no screenshot input yet)
  - **Template** (deferred to Phase 2)
- Topologies
  - **A — fully local** (primary)
  - **C — Vercel + direct API** (partial; no daemon features)

**Explicitly out of MVP:**
- legacy local-agent adapter layer
- Comment mode + sliders
- Template gallery + template skill
- Design System from screenshot (vision) / PDF / URL
- PDF / PPTX export
- Topology B (Vercel + tunneled local daemon)
- Docker Compose cluster profile beyond the development smoke
- Skill tests (`od skill test`)
- Auth / multi-user

### Week-by-week breakdown

| Week | Theme | Concrete deliverables |
|---|---|---|
| 1 | Scaffolding | pnpm workspaces (`apps/web`, `apps/daemon`, `e2e`); Next.js 16 base; daemon CLI skeleton; CI green |
| 2 | Daemon core | HTTP/SSE API; project/conversation store; skill registry scanning; artifact store; design-system resolver loading `DESIGN.md` |
| 3 | Pi runtime | embed Pi SDK behind `AgentRuntime`; stream text, thinking, tool calls, and tool results; keep file access behind `ProjectFs`; cancel active runs |
| 4 | BYOK proxy | provider streaming through the daemon; model/test settings; SSRF-safe base URL validation; integration with skill prompt injection |
| 5 | Web UI — chat + file workspace | React state + daemon-backed project store; SSE client; chat pane; file workspace reflects project files; skill picker |
| 6 | Web UI — preview + export | sandboxed iframe with hot reload; JSX → vendored React/Babel runtime; export ZIP; export self-contained HTML (inline CSS) |
| 7 | Default skills | port `guizang-ppt-skill` (no modifications; add `od:` extension block); write `saas-landing` skill; write 1–2 DESIGN.md examples; docs for skill authors |
| 8 | Polish + dogfood | end-to-end dogfooding; performance pass (daemon <500ms cold start, first generation overhead <50ms); bug-fixing; first publishable alpha |

### MVP exit criteria

1. `corepack enable && pnpm install && pnpm tools-dev run web` works on clean macOS and Linux with Node 24.
2. With Pi credentials configured: prototype + deck generation works end-to-end.
3. Without Pi credentials configured: BYOK proxy mode can still produce prototypes through configured providers.
4. A user can drop a DESIGN.md into the project root and subsequent generations respect it.
5. A third party can publish a skill repo; `od skill add <url>` installs it and it works.
6. Artifacts are plain files; `git add ./.od/artifacts/` and `git log` tell a sensible story.
7. No Electron, no Tauri, no desktop packaging anywhere in the repo.

---

## Phase 2 — v1 (~8 weeks after MVP)

**Goal:** feature parity with the "UI-polish-heavy" parts of Open CoDesign + multi-agent support + the full four modes.

### Scope

**Agent runtime:**
- worker-backed `AgentRuntime` mode with Redis queue and Postgres run/event store
- deterministic Pi-compatible fake runtime for development and E2E smoke tests
- capability-driven UI gating for Pi/BYOK surfaces

**UI:**
- **Comment mode** (click element → surgical edit; only when `capabilities.surgicalEdit`)
- **Slider parameters** (live-tweak `od.parameters`)
- **Multi-frame preview** (desktop / tablet / phone)
- **Template gallery** UI with thumbnails
- **Design System editor** (split view: markdown ↔ sample-components preview)

**Skills:**
- Template skills: `stripe-ish-landing`, `linear-ish-docs`, `notion-ish-workspace`, `vercel-ish-pricing`
- More Prototype skills: `dashboard`, `login-flow`, `empty-state-pack`, `pricing-page`
- More Deck skills: `pitch-deck`, `product-demo-deck`
- Design System skills: `design-system-from-screenshot`, `design-system-refine`

**Modes:**
- **Template mode** fully shipped
- **Design System mode** extended: screenshot input, URL input

**Export:**
- PDF (Puppeteer)
- PPTX (pptxgenjs, driven by `slides.json`)

**Deployment:**
- Docker Compose cluster profile with API + worker + Redis + Postgres
- Topology B: Vercel web + tunneled local daemon
  - Ship a helper subcommand: `od daemon --expose` using `cloudflared` (opt-in, documented)

**Dev experience:**
- `od skill test` with cheap-model runs
- Skill author starter template: `od skill scaffold`

### v1 exit criteria

1. All four modes fully functional.
2. Pi runtime works inline and through workers; BYOK proxy remains available.
3. PDF + PPTX export working for at least the `magazine-web-ppt` + `pitch-deck` skills.
4. Deployed example at `demo.open-design.dev` (Topology C).
5. Skill author docs published; at least one third-party skill submitted.
6. Documentation site rebuilt from these spec docs.

---

## Phase 3 — v2 (~12 weeks after v1)

**Goal:** ecosystem + robustness.

**Scope sketch (non-binding):**
- Skill marketplace UI — searchable, categorized, install with one click
- Skill signing / checksums
- remote filesystem providers for cluster workers, starting with GitHub-backed or fs-like adapters
- Windows support
- Collaborative mode (multi-user session on a single daemon)
- "Freeze prototype as design system" action
- Figma export (behind the Open CoDesign post-1.0 line; borrow their approach when they ship it)
- Telemetry (opt-in, self-hosted, never phoning home to a central service)
- Hosted SaaS offering (optional; full-local stays primary)

v2 isn't promised. It's the direction if v1 lands.

---

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Pi SDK event format changes between versions | runtime stream breaks | pin version range; keep deterministic compatibility tests for text/thinking/tool/result events |
| Worker queue or run store drifts from inline behavior | local and cluster UX diverge | exercise both paths in E2E smoke tests with the same fake Pi runtime |
| `@mariozechner/pi-ai` or similar abstractions get popular and contributors ask us to support them | scope creep | defer; if demand is real, add as yet-another-adapter next to `api-fallback` |
| Vercel deploy (Topology B) flaky because of tunnel setup | users can't try the cloud path | ship Topology C (direct API) as the always-works path; document Topology B as advanced |
| `guizang-ppt-skill` or similar upstream skill changes format | default deck skill breaks | pin git SHA in our default install; monitor upstream |
| DESIGN.md format evolves in awesome-claude-design | incompatibility | track upstream; adopt changes; our resolver is tolerant of missing sections |
| Anthropic ships an open-source Claude Design | differentiation collapses | our moat is local-first, BYOK, deployable Pi worker clusters, and open skills/design-system files |
| Skill security (malicious skill via `od skill add`) | user machine compromise | install-time warning; rely on agent's own permission model; document best practices |

---

## Decision log (lightweight)

Record one line per material decision as we go. Example entries:

- 2026-04-24 — Use plain files + `history.jsonl` over SQLite for artifacts. *Why:* git-reviewable, no driver dependency, matches "skills are files" ethos.
- 2026-04-24 — Adopt `DESIGN.md` (awesome-claude-design) verbatim rather than inventing a new format. *Why:* 68 existing files are immediately compatible.
- 2026-04-24 — Do not ship an Electron / Tauri wrapper. *Why:* every minute on code-signing is a minute not on skills; `cc-switch` already solves the tray-icon use case.
- 2026-05-10 — Host Pi SDK inside the Node.js daemon and worker runtime instead of detecting local coding-agent CLIs. *Why:* cluster deployment needs an explicit server-side runtime, deterministic E2E tests, and consistent Pi thinking/tool/result events.

Decisions supersede each other; keep the log append-only and date every entry.

---

## What to do right after reading this

If you're the implementer:

1. Read [`spec.md`](spec.md) top to bottom.
2. Skim [`architecture.md`](architecture.md), [`skills-protocol.md`](skills-protocol.md), [`agent-adapters.md`](agent-adapters.md).
3. Argue with anything in the four "open questions" sections; file one-line decisions.
4. Fill in the missing Phase 0 deliverables (the `docs/schemas/` and `docs/examples/` files).
5. Scaffold the monorepo and start Week 1.

If you're evaluating the concept:

1. Read [`README.md`](../README.md) + [`spec.md`](spec.md) §1–3.
2. Check the comparison matrix in [`references.md`](references.md).
3. Look at the worked example in [`skills-protocol.md`](skills-protocol.md) §7 — that's the end-to-end feel.
