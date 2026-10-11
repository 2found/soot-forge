# Run the shared service as a container

On a single machine, `operator/local-docker.py` does all of this for you:

```sh
python3 packs/data-pool/operator/local-docker.py install --soots general --manager general
python3 packs/data-pool/operator/local-docker.py status
python3 packs/data-pool/operator/local-docker.py upgrade            # rebuild service, keep data
python3 packs/data-pool/operator/local-docker.py uninstall [--purge]
```

It builds the service image from this checkout, runs Meilisearch on an
internal Docker network (no host port, no outbound route), creates a backend
key restricted to `soot_*` indexes, renders bindings into `~/.soot/data-pool`
(mode 0700, or `--home`), and publishes the service only on `127.0.0.1:8091`.
Both containers drop all capabilities; the service runs read-only as 65532.
Every resource is labeled `io.soot.data-pool=local`, so `uninstall --purge`
can prove nothing is left. The bound Soot list is fixed when bindings are
rendered; adding a Soot means `uninstall --purge` and a fresh install (new
tokens for every host). Point a Soot host at the result:

```json
{
  "data_pool": {"binding": {"file": "/Users/you/.soot/data-pool/service/bindings/host-local.json"}, "capabilities": "read-write"},
  "credentials": {"general": {"DATA_POOL_UI": {"file": "/Users/you/.soot/data-pool/service/bindings/general.ui.json", "operations": ["data-pool_view", "data-pool_action"]}}}
}
```

The rest of this page is the manual, multi-host version.

This runs the [shared data-pool service](shared-service.md) as one container on
a VM, next to a Meilisearch container on the same private Docker network, behind
an HTTPS reverse proxy such as Caddy. Soot hosts (a local Mac, a VM Soot host)
reach it only through the proxy's HTTPS URL. Nothing here is run by a Soot tool;
the operator builds, configures and starts it.

## Image

`packs/data-pool/service/Dockerfile` builds a static binary (`CGO_ENABLED=0`,
`-trimpath`, stripped) in `golang:1.25` and copies it into
`gcr.io/distroless/static-debian12:nonroot`. Both base images are pinned by
digest; bump them deliberately. The build context is the runner directory only:

```sh
docker build --platform linux/amd64 -t soot-data-pool:<version> \
  -f packs/data-pool/service/Dockerfile packs/data-pool/runner
```

| Property | Value |
| --- | --- |
| User | `65532:65532` (distroless `nonroot`), no shell, no package manager |
| Entrypoint | `/soot-data-pool` |
| Default command | `serve --config-env DATA_POOL_SERVICE_CONFIG` |
| Port | `8091` (cleartext; TLS ends at the proxy) |
| State | `/data/state` (policy database); `/data` is owned by 65532, mode 0700 |
| Health | image `HEALTHCHECK` runs `/soot-data-pool healthcheck` (liveness) |

Endpoints: `POST /v1/tool` (authenticated tool calls), `GET /healthz`
(liveness only, never touches the backend) and `GET /readyz` (policy database
open and Meilisearch answering, 2-second bound, generic body, result reused for
one second). Each tool request logs one JSON line to stderr with time, claimed
Soot, client kind (`soot`, `host:NAME`, `ui`), operation, status and duration —
never tokens, bodies, queries, document IDs or content.

## Configuration

Render the config on a trusted machine with
[`configure-service.py`](shared-service.md#operator-setup), adding
`--private-network --listen 0.0.0.0:8091`, one `--host NAME=SOOT,...` per Soot
host, and a backend config whose `endpoint` is the Meilisearch service name and
whose `state_dir` is `/data/state`:

```json
{
  "endpoint": "http://meilisearch:7700",
  "api_key": "<private Meilisearch key restricted to Soot indexes>",
  "namespace": "company",
  "state_dir": "/data/state",
  "soots": ["data-manager", "marketing-local", "marketing-vm"],
  "managers": ["data-manager"]
}
```

`"private_network": true` is what allows both the cleartext `0.0.0.0` listener
and the `http://meilisearch:7700` backend. The backend name must resolve only to
private addresses (RFC 1918, IPv6 ULA, loopback); this is checked at every dial,
and a public, link-local or CGNAT answer is refused. Without the flag the
service keeps its normal rules (loopback or TLS listener, HTTPS or loopback
backend). See [shared-service.md](shared-service.md#private-network-containers).

Pass the config in `DATA_POOL_SERVICE_CONFIG` (at most 2 MiB, strict JSON, same
validation as `--config`). Keep it out of shell history and Git: put it in an
env file readable only by root, as one line in single quotes:

```sh
umask 077
printf "DATA_POOL_SERVICE_CONFIG='%s'\n" \
  "$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), separators=(",", ":")))' service.json)" \
  > /opt/soot-data-pool/service.env
```

The value is visible to anyone who can run `docker inspect` on the VM, which is
already equivalent to root there. Alternatively mount the file and run
`serve --config /run/config/service.json`; that path keeps the mode-0600 check,
so the host file must be owned by 65532 with mode 0600.

Copy each `bindings/host-NAME.json` only to its own Soot host, and the
`--configurator` UI binding only to the operator's host. Never copy
`service.json` or the backend key off the VM.

## Volume ownership

The service runs as 65532 and must own its state. For a bind mount:

```sh
sudo install -d -o 65532 -g 65532 -m 0700 /opt/soot-data-pool/data
```

A fresh named volume inherits the image's `/data` ownership automatically. One
container per state directory: the policy database takes an exclusive lock, so
a second replica fails closed rather than sharing it. Never scale this service
above one replica.

## Compose example

```yaml
services:
  meilisearch:
    image: getmeili/meilisearch:v1.54.3
    env_file: /opt/soot-data-pool/meili.env   # MEILI_MASTER_KEY=..., MEILI_ENV=production, mode 0600
    environment:
      MEILI_NO_ANALYTICS: "true"
    volumes: ["/opt/soot-data-pool/meili:/meili_data"]
    networks: [data-pool]
    restart: unless-stopped

  data-pool:
    image: soot-data-pool:<version>
    env_file: /opt/soot-data-pool/service.env
    volumes: ["/opt/soot-data-pool/data:/data"]
    networks: [data-pool, proxy]   # no published ports; only the proxy reaches 8091
    depends_on: [meilisearch]
    stop_grace_period: 30s
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 512m
    restart: unless-stopped

networks:
  data-pool: {internal: true}   # Meilisearch has no route out and no route in
  proxy: {external: true}       # the network Caddy is attached to
```

`stop_grace_period: 30s` matters: on SIGTERM the service drains in-flight
requests for up to 20 seconds, then closes the policy database within 5 more.
A shorter grace period means SIGKILL during a write, leaving an `uncertain`
receipt to reconcile. URL imports need outbound HTTPS from the `data-pool`
container; the `proxy` network normally provides it.

## Caddy

Expose only the three service paths, bound the body, never retry a POST, and
allow an upstream response time above the service's 20-second write timeout:

```caddyfile
company-data.example.com {
	@pool path /v1/tool /healthz /readyz
	handle @pool {
		request_body {
			max_size 300KB
		}
		reverse_proxy data-pool:8091 {
			# No lb_try_duration/lb_retries: a retried POST is a second mutation.
			transport http {
				dial_timeout 3s
				response_header_timeout 30s
			}
		}
	}
	handle {
		respond 404
	}
}
```

The service itself limits tool envelopes to 256 KiB. Caddy redacts
`Authorization` in its access logs by default; do not enable
`log_credentials`, and do not log request bodies. Do not cache responses (the
service sends `Cache-Control: no-store`).

## Backup and restore

The policy database and Meilisearch must be backed up as one consistent pair.

1. Quiesce Soot writes, then `docker compose stop data-pool`.
2. Create a Meilisearch snapshot or dump (see [meilisearch.md](meilisearch.md)),
   or stop Meilisearch too and copy its data directory.
3. Copy `/opt/soot-data-pool/data` (owner and mode preserved) and the private
   env files to private backup storage.
4. `docker compose start data-pool` and check `/readyz`.

Restore both halves from the same backup. Never restore only grants or only an
index; unresolved receipts must stay with the data they describe.

## Upgrade

Back up first. Build and load the new image tag, change `image:` and run
`docker compose up -d data-pool`; Compose stops the old container (honouring the
grace period) before starting the new one, so the database lock never
contends. Confirm `/readyz` and one authenticated `data-pool_pools` call. To
roll back, restore the previous tag; restore the backup only if the new version
documented a state migration. Meilisearch upgrades follow Meilisearch's own
migration guidance.

## Complete removal

1. On every Soot host remove the `data_pool` block or `DATA_POOL` credentials
   and delete the copied binding files.
2. Remove the Caddy site block and reload Caddy.
3. `docker compose down` for these services (add `--rmi all` to delete images),
   then `docker network rm` any network you created only for them.
4. Delete `/opt/soot-data-pool/*.env`.
5. Only if the data itself must go: delete `/opt/soot-data-pool/data` and the
   Meilisearch data directory, and revoke the Meilisearch key. This is
   irreversible; keep a backup unless deletion is the point.
