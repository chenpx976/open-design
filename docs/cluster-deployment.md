# Cluster Deployment

Open Design's local daemon can run the Pi coding agent inline, but the runtime is
now shaped so that production deployments can move generation into workers
without changing the web contract.

## Runtime Boundary

The daemon talks to agents through `AgentRuntime`:

```text
HTTP/SSE API -> AgentRuntime -> Pi SDK -> sandbox tools -> ProjectFs
```

The current implementation is `createInlinePiAgentRuntime()`, which keeps local
development simple by invoking the Pi SDK in the daemon process. For deployment
smoke tests, `OD_AGENT_RUNTIME=queued-inline` wraps the same Pi runtime in a
bounded in-process queue and reports `runtimeExecutionMode: "worker"` in the run
start event. `OD_AGENT_RUNTIME=sqlite-worker` goes one step further: the API
process writes a job through `AgentJobQueue`, while `od agent-worker` consumes
that job from a separate process and writes events back through
`AgentRunPersistence`. The local implementation stores both contracts in
SQLite. The production-shaped Compose mode can replace the job contract with
Redis and the run/event contract with Postgres. Larger clusters should keep
those two externalized contracts and add a dedicated event fan-out layer:

```text
HTTP/SSE API -> run store -> queue -> Pi worker -> event bus -> HTTP/SSE API
```

The API process should own request validation, auth, run creation, and client
streaming. Workers should own model calls, tool execution, sandbox filesystem
access, and artifact discovery.

## Project Filesystem Boundary

Project file access is described through `ProjectFs`. The local implementation
is `createLocalProjectFs(root)`, which preserves today's `.od/projects/<id>` and
git-linked `metadata.baseDir` behavior.

Cluster deployments should add alternate implementations behind the same
boundary:

- `ObjectProjectFs` for S3/R2/GCS-backed snapshots.
- `PersistentVolumeProjectFs` for Kubernetes workers with mounted volumes.
- `AgentFsProjectFs` or `MirageProjectFs` for copy-on-write or virtual-resource
  sandboxes.
- `GitHubSyncProjectFs` only as a sync or PR target, not as the hot write path.

The hot path should stay low-latency and write-friendly. GitHub is best used for
import/export, snapshot commits, reviews, and pull requests.

## Event Flow

Inline mode sends Pi SDK events directly into the daemon run stream and mirrors
the run/event lifecycle through `AgentRunPersistence`. SQLite is the local
implementation. Redis-backed worker mode moves work dispatch out of SQLite.
`OD_AGENT_RUN_STORE=postgres` moves run state and event history to Postgres.
Larger cluster mode should keep the same event contract while using Redis,
NATS, or another pubsub layer for fan-out:

```text
Pi worker -> AgentEventBus -> AgentRunStore -> SSE/WebSocket clients
```

Persisted events make browser reconnect, API replica failover, worker retries,
and audit trails possible.

## Recommended Rollout

1. Keep inline Pi SDK as the default local mode.
2. Use SQLite `AgentRunPersistence` as the local implementation of persisted run
   state and event history.
3. Use `OD_AGENT_RUNTIME=queued-inline` to exercise the worker-shaped path in
   local end-to-end tests.
4. Use `OD_AGENT_RUNTIME=sqlite-worker` plus `od agent-worker` to exercise a
   real separate worker process against the local SQLite job table.
5. Use `OD_AGENT_JOB_QUEUE=redis` to move job dispatch out of SQLite while
   keeping local run/event persistence.
6. Use `OD_AGENT_RUN_STORE=postgres` to move run/event history out of SQLite.
7. Replace `LocalProjectFs` in workers with the deployment's chosen storage
   backend.

## Local Worker Smoke

Run the API/web process:

```bash
OD_AGENT_RUNTIME=sqlite-worker pnpm tools-dev run web --daemon-port 17456 --web-port 17573
```

Run a separate worker process from the repository root:

```bash
pnpm --filter @open-design/daemon exec tsx src/cli.ts agent-worker
```

## Redis Queue Mode

The API and workers choose the queue backend through `OD_AGENT_JOB_QUEUE`.

```bash
OD_AGENT_RUNTIME=sqlite-worker \
OD_AGENT_JOB_QUEUE=redis \
OD_AGENT_REDIS_URL=redis://127.0.0.1:6379/0 \
pnpm tools-dev run web --daemon-port 17456 --web-port 17573
```

Worker leases are renewed with `OD_AGENT_WORKER_HEARTBEAT_MS`, stale leases are
recovered after `OD_AGENT_WORKER_LEASE_MS`, and long-running jobs are aborted
after `OD_AGENT_WORKER_MAX_JOB_MS`. Failed jobs requeue until
`OD_AGENT_WORKER_MAX_ATTEMPTS` is reached, then the run is marked failed.

Operational checks:

```bash
docker compose --profile worker logs -f agent-worker
docker compose --profile worker exec redis redis-cli llen open-design:agent-jobs:queued
docker compose --profile worker exec redis redis-cli zcard open-design:agent-jobs:running
docker compose --profile worker exec postgres psql -U open_design -d open_design -c "select run_id,event,payload_json from agent_run_events order by id desc limit 20;"
```

Expected semantics:

- `queued` depth falls back to `0` after the worker claims a job.
- `running` falls back to `0` after the worker acknowledges success/failure.
- Successful runs have `start`, one or more `agent`, and `end` events in
  Postgres, with the Redis job hash ending at `status=succeeded`.
- Failed runs keep the error in the job hash until cleanup and write a terminal
  Postgres `end` event with `status: "failed"`.

## Postgres Run Store

Use Postgres when more than one API replica needs to recover runs, stream
persisted events, or survive API pod replacement without relying on a shared
SQLite volume.

```bash
OD_AGENT_RUNTIME=sqlite-worker \
OD_AGENT_RUN_STORE=postgres \
OD_AGENT_POSTGRES_URL=postgres://open_design:open_design@127.0.0.1:5432/open_design \
OD_AGENT_JOB_QUEUE=redis \
OD_AGENT_REDIS_URL=redis://127.0.0.1:6379/0 \
pnpm tools-dev run web --daemon-port 17456 --web-port 17573
```

The Postgres adapter creates `agent_runs` and `agent_run_events` if they do not
exist. It deliberately does not store project files; `ProjectFs` still owns
artifact storage.
