# Run the shared service as a container

On a single machine, `operator/local-docker.py` does all of this for you:

```sh
python3 packs/data-pool/operator/local-docker.py install --soots general --manager general
python3 packs/data-pool/operator/local-docker.py status
python3 packs/data-pool/operator/local-docker.py upgrade            # rebuild service, keep data
python3 packs/data-pool/operator/local-docker.py uninstall [--purge]
```

It builds the service image from this checkout, runs PostgreSQL 16 on an
internal Docker network (no host port, no outbound route), generates a random
database password into a private env file, renders bindings into
`~/.soot/data-pool` (mode 0700, or `--home`), and publishes the service only on
`127.0.0.1:8091`. The PostgreSQL data volume is the only volume; the service
container is read-only and drops all capabilities, and PostgreSQL runs with
`no-new-privileges`. Every resource is labeled `io.soot.data-pool=local`, so
`uninstall --purge` can prove nothing is left. The bound Soot list is fixed when
bindings are rendered; adding a Soot means `uninstall --purge` and a fresh
install (new tokens for every host). Point a Soot host at the result:

```json
{
  "data_pool": {"binding": {"file": "/Users/you/.soot/data-pool/service/bindings/host-local.json"}, "access": "write"},
  "credentials": {"general": {"DATA_POOL_UI": {"file": "/Users/you/.soot/data-pool/service/bindings/general.ui.json", "operations": ["data-pool-console_view", "data-pool-console_action"]}}}
}
```

The rest of this page is the manual, multi-host version.

This runs the [shared data-pool service](shared-service.md) as one container on
a VM, next to PostgreSQL 16 on the same private Docker network, behind an
HTTPS reverse proxy such as Caddy. Soot hosts (a local Mac, a VM Soot host)
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
| State | none in the image; all data is in PostgreSQL schema `data_pool` |
| Health | image `HEALTHCHECK` runs `/soot-data-pool healthcheck` (liveness) |

Endpoints: `POST /v1/tool` (authenticated tool calls), `GET /healthz`
(liveness only, never touches PostgreSQL) and `GET /readyz` (PostgreSQL ping,
2-second bound, generic body, result reused for one second). Each tool request
logs one JSON line to stderr with time, claimed Soot, client kind
(`soot`, `host:NAME`, `ui`), operation, status and duration — never tokens,
bodies, queries, document IDs or content.

## Configuration

Render the config on a trusted machine with
[`configure-service.py`](shared-service.md#operator-setup), adding
`--private-network --listen 0.0.0.0:8091`, one `--host NAME=SOOT,...` per Soot
host, and a backend config whose `database_url` names the PostgreSQL container:

```json
{
  "database_url": "postgres://soot:password@data-pool-postgres:5432/soot?sslmode=disable",
  "namespace": "company",
  "soots": ["data-manager", "marketing-local", "marketing-vm"],
  "managers": ["data-manager"]
}
```

`"private_network": true` is what allows both the cleartext `0.0.0.0` listener
and a cleartext DSN naming a container host. The service never logs or returns
the DSN: the operator keeps it in `service.json`, which must remain on the VM.
Prefer `sslmode=require` when the database is reachable beyond the private
Docker network. Without the flag the service keeps its normal rules
(loopback or TLS listener; TLS or loopback/private literal DSN). See
[shared-service.md](shared-service.md#private-network-containers).

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
`service.json` or the DSN off the VM.

## Database ownership

The service keeps no local state; PostgreSQL owns schema `data_pool`. Let the
PostgreSQL image own its data directory: a named volume or a bind mount created
and writable by the image's `postgres` user (UID 999). Do not chown it to
65532. One database holds one namespace: the service records the namespace in
`data_pool.meta` and refuses a different one. Run one service replica per
namespace; the schema migration takes an advisory lock, but runtime policy
assumes a single writer.

## Compose example

```yaml
services:
  postgres:
    image: postgres:16-alpine          # pin a digest for reproducible pulls
    env_file: /opt/soot-data-pool/postgres.env   # POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB; mode 0600
    volumes: ["pgdata:/var/lib/postgresql/data"]
    networks: [data-pool]
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U soot -d soot"]
      interval: 5s
      timeout: 3s
      retries: 12
    restart: unless-stopped

  data-pool:
    image: soot-data-pool:<version>
    env_file: /opt/soot-data-pool/service.env
    networks: [data-pool, proxy]   # no published ports; only the proxy reaches 8091
    depends_on:
      postgres: {condition: service_healthy}
    stop_grace_period: 30s
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 512m
    restart: unless-stopped

networks:
  data-pool: {internal: true}   # PostgreSQL has no route out and no route in
  proxy: {external: true}       # the network Caddy is attached to

volumes:
  pgdata: {}                    # the only persistent state
```

`stop_grace_period: 30s` matters: on SIGTERM the service drains in-flight
requests for up to 20 seconds, then closes its database pool within 5 more. A
shorter grace period can SIGKILL a request; an uncommitted transaction rolls
back, and a committed receipt remains replayable. URL imports need outbound
HTTPS from the `data-pool` container; the `proxy` network normally provides it.

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

PostgreSQL is the single source of truth: one database dump contains pools,
grants, documents, receipts, activity, references and admissions.

1. Quiesce Soot writes, then `docker compose stop data-pool`.
2. Run `pg_dump` against the database, for example
   `docker compose exec -T postgres pg_dump -U soot -d soot --format=custom > /opt/soot-data-pool/backup.dump`.
3. Copy the dump and the private `*.env` files to private backup storage; keep
   the dump mode 0600 and encrypt it at rest.
4. `docker compose start data-pool` and check `/readyz`.

Restore into an empty database with `pg_restore`; never restore only grants or
only documents. A dump restored into a database still bound to another
namespace is refused. Keep receipts with the data they describe so request-ID
replay stays idempotent.

## Upgrade

Back up first. Build and load the new image tag, change `image:` and run
`docker compose up -d data-pool`; Compose stops the old container (honouring the
grace period) before starting the new one. The service applies its own
`schema_version` migration on start under an advisory lock. Confirm `/readyz`
and one authenticated `data-pool_pools` call. To roll back, restore the previous
tag; restore the backup only if the new version documented a schema migration.
PostgreSQL major-version upgrades use `pg_upgrade` or dump/restore on the
database container, not this service image.

## Complete removal

1. On every Soot host remove the `data_pool` block or `DATA_POOL` credentials
   and delete the copied binding files.
2. Remove the Caddy site block and reload Caddy.
3. `docker compose down` for these services (add `--rmi all` to delete images),
   then `docker network rm` any network you created only for them.
4. Delete `/opt/soot-data-pool/*.env` and the generated DSN/config.
5. Only if the data itself must go: drop the database and role and delete the
   `pgdata` volume. This is irreversible; keep a dump unless deletion is the
   point.
