# Docker deployment

This deployment ships Open Design as a single Alpine-based runtime image. The
daemon serves both the API and the built Next.js static export, so there is no
separate nginx container.

## Local compose

```bash
cd deploy
OPEN_DESIGN_IMAGE=docker.io/vanjayak/open-design:latest docker compose pull
OPEN_DESIGN_IMAGE=docker.io/vanjayak/open-design:latest docker compose --profile worker up -d --no-build
```

Defaults:

- Host port: `127.0.0.1:7456` (`OPEN_DESIGN_PORT=8080` to publish on `127.0.0.1:8080`)
- Runtime data volume: `open_design_data` mounted at `/app/.od`
- Agent runtime: `sqlite-worker`; the API enqueues runs and `agent-worker`
  consumes them through the embedded Pi SDK
- Agent run store: `postgres`; run state and event history live in Postgres
- Agent job queue: `redis`; worker dispatch uses Redis leases and heartbeats
- Node heap cap: `--max-old-space-size=192`
- Compose memory cap: `384m` (`OPEN_DESIGN_MEM_LIMIT=256m` to override)

Do not publish the daemon directly on a public or shared LAN interface. The API is
unauthenticated for non-browser clients, so remote deployments should keep Compose
bound to localhost and put an authenticated reverse proxy, SSH tunnel, or VPN in
front of it.

When exposing the service through an authenticated public IP, domain, or reverse
proxy, set `OPEN_DESIGN_ALLOWED_ORIGINS` to the browser origins that should be
allowed to call `/api`:

```bash
OPEN_DESIGN_ALLOWED_ORIGINS=https://od.example.com,http://203.0.113.10:7456 docker compose up -d --no-build
```

Pin a specific published image with a digest instead of the mutable `latest` tag:

```bash
OPEN_DESIGN_IMAGE=docker.io/vanjayak/open-design@sha256:<digest> docker compose up -d --no-build
```

## Cluster worker mode

The recommended Compose path starts the full local cluster shape:

```bash
OPEN_DESIGN_AGENT_RUNTIME=sqlite-worker \
OPEN_DESIGN_AGENT_RUN_STORE=postgres \
OPEN_DESIGN_AGENT_JOB_QUEUE=redis \
docker compose --profile worker up -d --build
```

For repeated local smoke runs, build once and reuse the image:

```bash
OPEN_DESIGN_IMAGE=open-design-e2e:cluster-smoke docker compose --profile worker up -d
```

This starts:

- `open-design`: HTTP API, static web UI, run creation, and SSE streaming.
- `agent-worker`: consumes Redis jobs and writes Pi events back through the run
  persistence contract.
- `redis`: durable-enough local job queue for the worker profile.
- `postgres`: run state and event history for reconnects, retries, and API
  replacement.

In Redis mode workers use a lease and heartbeat. Tune
`OPEN_DESIGN_AGENT_WORKER_LEASE_MS`, `OPEN_DESIGN_AGENT_WORKER_HEARTBEAT_MS`,
`OPEN_DESIGN_AGENT_WORKER_MAX_JOB_MS`, and
`OPEN_DESIGN_AGENT_WORKER_MAX_ATTEMPTS` for slower models or larger design
generations.

Scale workers on one host:

```bash
docker compose --profile worker up -d --scale agent-worker=2
```

The default Postgres URL is
`postgres://open_design:open_design@postgres:5432/open_design`. Override
`OPEN_DESIGN_AGENT_POSTGRES_URL`, `OPEN_DESIGN_POSTGRES_USER`,
`OPEN_DESIGN_POSTGRES_PASSWORD`, and `OPEN_DESIGN_POSTGRES_DB` for managed
databases or non-default credentials.

The image intentionally does not bundle Claude/Codex/Gemini CLI binaries because
agent execution is hosted through the embedded Pi SDK.

Useful operations:

```bash
docker compose --profile worker ps
docker compose --profile worker logs -f open-design agent-worker
docker compose --profile worker exec redis redis-cli llen open-design:agent-jobs:queued
docker compose --profile worker exec redis redis-cli zcard open-design:agent-jobs:running
docker compose --profile worker exec postgres psql -U open_design -d open_design -c "select run_id,event,payload_json from agent_run_events order by id desc limit 20;"
docker compose --profile worker down
docker compose --profile worker down -v # also removes local run/project data
```

Failure triage:

- Worker logs include `[agent-worker] run=<id>` lines for claims, retries, and terminal status.
- Redis `open-design:agent-jobs:queued` is pending depth; `open-design:agent-jobs:running` is leased work.
- Failed runs write an `end` event with `status: "failed"` to Postgres and the job hash ends with `status=failed` after `OPEN_DESIGN_AGENT_WORKER_MAX_ATTEMPTS`.
- A succeeded run should have Postgres `start`, `agent`, and `end` events and a Redis job hash with `status=succeeded`.

## Publish to Docker Hub

```bash
deploy/scripts/publish-images.sh --image_tag latest
```

Useful overrides:

```bash
IMAGE_NAMESPACE=your-dockerhub-user deploy/scripts/publish-images.sh --arch arm64
deploy/scripts/publish-images.sh --image docker.io/your-user/open-design:0.1.0
```

The script defaults to:

- `docker.io/vanjayak/open-design:<tag>`
- `linux/amd64,linux/arm64`
- `skopeo` push strategy with Docker credentials read from `~/.docker/config.json`
- preloading base images through `skopeo` to reduce Docker Hub pull flakiness

If `127.0.0.1:7890` is available and no proxy is already set, the script uses it
for registry access and passes `host.docker.internal:7890` into Docker builds. The
host-gateway alias is only added for builds that need this local proxy mapping.

### Colima swap helper for Apple Silicon

`deploy/scripts/prepare-colima-build-swap.sh` is for manual Docker image
publishing from an Apple Silicon macOS host that uses Colima as the Docker VM.
The helper is intentionally Apple Silicon-only because the failure mode it covers
is local arm64 Colima builds exhausting a small Linux VM while preparing
multi-arch images. It exits before touching Colima on non-macOS or
non-Apple-Silicon hosts.

Low-memory Colima VMs can run out of RAM during multi-arch image builds. The
helper checks the VM memory and swap status, then creates and enables a temporary
swap file only when the VM has no swap and less than 4 GiB of RAM. The 4 GiB
threshold is a conservative default for short-lived manual publishes on small
Colima profiles; raise `COLIMA_BUILD_SWAP_MEMORY_THRESHOLD_KIB` if larger builds
still OOM, or lower it if you only want swap for very small VMs.

Prefer increasing the Colima VM memory (`colima start --memory <GiB>` or the
profile config) when you want a persistent build machine. Use this helper when
you need a temporary, reversible boost for one manual publish without resizing
or recreating the VM.

Run it before a manual publish if Docker builds fail with out-of-memory errors,
or if `status` shows a small Colima VM with no swap. The swap remains active
until cleanup or VM restart, so use a shell trap for one-off sessions:

```bash
deploy/scripts/prepare-colima-build-swap.sh status
deploy/scripts/prepare-colima-build-swap.sh
trap 'deploy/scripts/prepare-colima-build-swap.sh cleanup' EXIT
deploy/scripts/publish-images.sh --image_tag latest
```

Useful overrides:

```bash
COLIMA_BUILD_SWAP_SIZE=6G deploy/scripts/prepare-colima-build-swap.sh
COLIMA_BUILD_SWAP_MEMORY_THRESHOLD_KIB=6291456 deploy/scripts/prepare-colima-build-swap.sh
COLIMA_BIN=/opt/homebrew/bin/colima deploy/scripts/prepare-colima-build-swap.sh status
COLIMA_BUILD_SWAP_CLEANUP_FORCE=1 COLIMA_BUILD_SWAPFILE=/custom-swapfile deploy/scripts/prepare-colima-build-swap.sh cleanup
```

`cleanup` removes the default helper path and the old helper path. If you set a
custom `COLIMA_BUILD_SWAPFILE`, cleanup refuses to remove it unless
`COLIMA_BUILD_SWAP_CLEANUP_FORCE=1` is also set.
