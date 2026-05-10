# Agent Runtime

**Parent:** [`spec.md`](spec.md) · **Siblings:** [`architecture.md`](architecture.md) · [`skills-protocol.md`](skills-protocol.md) · [`modes.md`)

Open Design no longer discovers or spawns local coding-agent CLIs. The daemon owns one Node.js-hosted coding agent runtime: Pi embedded through `@earendil-works/pi-coding-agent`.

## Rationale

The old adapter layer scanned PATH for tools such as Claude Code, Codex, Cursor Agent, Gemini CLI, OpenCode, Qoder, and Pi, then delegated each chat run to a child process. That made the product depend on GUI-inherited PATH state, per-CLI auth quirks, Windows command-line limits, and parser drift across many streaming formats.

The new shape follows the same direction as Flue's headless agent harness: the agent runtime is programmable TypeScript inside the server process, and the server owns the sandbox boundary instead of outsourcing execution to a user's terminal. Pi is the right substrate because its CLI, print mode, RPC mode, and SDK all share the same core agent session, tools, settings, skills, context-file discovery, model registry, and event stream.

## Runtime Boundary

- Catalog: `apps/daemon/src/agents.ts` exposes a single `pi` agent with `bin: "node:pi-sdk"` for compatibility with the existing web contract.
- Execution: `apps/daemon/src/agent-runtime.ts` exposes the `AgentRuntime` boundary. Local development uses the inline Pi SDK runtime; clustered deployments can replace it with a queue-backed worker runtime.
- Worker contracts: `apps/daemon/src/agent-run-contracts.ts` separates `AgentRunPersistence` from `AgentJobQueue`, so production can put run state/events in Postgres and work dispatch in Redis, NATS, SQS, or another queue without changing the web contract.
- Pi session: `apps/daemon/src/pi-sdk-agent.ts` creates a Pi `AgentSession` with the project cwd, optional model, optional thinking level, in-memory session storage, and Pi's default resource loader.
- Project filesystem: `apps/daemon/src/project-fs.ts` exposes `ProjectFs`. The current local implementation points at `.od/projects/<id>` or a git-linked base directory, while future workers can provide object-storage, PVC, AgentFS, or Mirage-backed implementations.
- Shell sandbox: the Pi `bash` tool is replaced by an SDK custom tool backed by `just-bash` with a `ReadWriteFs` rooted at the OD project filesystem. This mirrors Flue's lightweight virtual-sandbox posture while still allowing generated artifact files to persist in the project.
- Events: Pi SDK session events are mapped onto OD's existing SSE `agent` events: `text_delta`, `thinking_delta`, `tool_use`, `tool_result`, `usage`, and `error`.
- Models: `/api/agents` asks Pi's `ModelRegistry.getAvailable()` for currently usable models and falls back to common model patterns when credentials are not yet configured.
- Cancellation: OD run cancellation aborts the Pi session via `session.abort()` through the run's `acpSession` compatibility hook.
- Images: daemon-validated upload paths are read and sent to Pi as base64 `ImageContent` prompt attachments.

See [`cluster-deployment.md`](cluster-deployment.md) for the worker, queue,
event-store, and storage rollout plan.

## Authentication And Configuration

Pi owns provider authentication. Users can authenticate through Pi's normal mechanisms:

- `~/.pi/agent/auth.json` and `~/.pi/agent/settings.json`
- Pi OAuth flows
- provider environment variables such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- custom model/provider entries in `~/.pi/agent/models.json`

Open Design does not persist per-agent binary overrides such as `CLAUDE_BIN`, `CODEX_BIN`, or `PI_BIN`; those knobs are intentionally removed from the runtime path.

## Skills And Context

OD still composes its product prompt, selected skill body, design-system excerpt, media/tool contract, linked-directory hint, and working-directory hint before handing the request to Pi. Pi then runs as the coding agent inside the selected project directory and can use its own context-file and skill discovery on top of that.

Skill side files are still staged into the project cwd by the daemon so the embedded agent can read them through normal filesystem tools without any CLI sandbox flags.

## References

- [Pi repository](https://github.com/earendil-works/pi)
- [Pi SDK docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Flue](https://github.com/withastro/flue)
