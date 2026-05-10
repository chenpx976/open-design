# Docker deployment

This deployment ships Open Design as a single Alpine-based runtime image. The
daemon serves both the API and the built Next.js static export, so there is no
separate nginx container.

## Local compose

```bash
cd deploy
OPEN_DESIGN_IMAGE=docker.io/vanjayak/open-design:latest docker compose pull
OPEN_DESIGN_IMAGE=docker.io/vanjayak/open-design:latest docker compose up -d --no-build
```

Defaults:

- Host port: `127.0.0.1:7456` (`OPEN_DESIGN_PORT=8080` to publish on `127.0.0.1:8080`)
- Runtime data volume: `open_design_data` mounted at `/app/.od`
- Agent runtime: `inline` (`OPEN_DESIGN_AGENT_RUNTIME=sqlite-worker` to enqueue
  runs for a separate worker service)
- Agent run store: `sqlite` (`OPEN_DESIGN_AGENT_RUN_STORE=postgres` to store
  run state and event history in Postgres)
- Agent job queue: `sqlite` (`OPEN_DESIGN_AGENT_JOB_QUEUE=redis` to dispatch
  work through the Redis service in the `worker` profile)
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

## Worker mode

The default container runs the embedded Pi SDK inline inside the API process.
For a worker-shaped deployment on one host, run the API in `sqlite-worker` mode
and enable the `worker` Compose profile:

```bash
OPEN_DESIGN_AGENT_RUNTIME=sqlite-worker docker compose --profile worker up -d --no-build
```

This starts:

- `open-design`: HTTP API, static web UI, run creation, and SSE streaming.
- `agent-worker`: consumes `agent_run_jobs` from the shared `/app/.od` SQLite
  store and writes Pi events back into `agent_run_events`.

This mode is a local/single-host stepping stone, not the final cluster queue.
For multi-node clusters, replace the SQLite job table with a durable queue and
replace the SQLite event mirror with Postgres plus Redis/NATS fan-out. Keep the
same API/worker role split.

To exercise a more cluster-like queue, keep run/event history on the shared
`open_design_data` volume but dispatch jobs through Redis:

```bash
OPEN_DESIGN_AGENT_RUNTIME=sqlite-worker \
OPEN_DESIGN_AGENT_JOB_QUEUE=redis \
docker compose --profile worker up -d --no-build --scale agent-worker=2
```

In Redis mode workers use a lease and heartbeat. Tune
`OPEN_DESIGN_AGENT_WORKER_LEASE_MS`, `OPEN_DESIGN_AGENT_WORKER_HEARTBEAT_MS`,
`OPEN_DESIGN_AGENT_WORKER_MAX_JOB_MS`, and
`OPEN_DESIGN_AGENT_WORKER_MAX_ATTEMPTS` for slower models or larger design
generations.

For the full externalized control plane, use Postgres for run/event history and
Redis for job dispatch:

```bash
OPEN_DESIGN_AGENT_RUNTIME=sqlite-worker \
OPEN_DESIGN_AGENT_RUN_STORE=postgres \
OPEN_DESIGN_AGENT_JOB_QUEUE=redis \
docker compose --profile worker up -d --no-build --scale agent-worker=2
```

The default Postgres URL is
`postgres://open_design:open_design@postgres:5432/open_design`. Override
`OPEN_DESIGN_AGENT_POSTGRES_URL`, `OPEN_DESIGN_POSTGRES_USER`,
`OPEN_DESIGN_POSTGRES_PASSWORD`, and `OPEN_DESIGN_POSTGRES_DB` for managed
databases or non-default credentials.

The image intentionally does not bundle Claude/Codex/Gemini CLI binaries because
agent execution is hosted through the embedded Pi SDK.

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
