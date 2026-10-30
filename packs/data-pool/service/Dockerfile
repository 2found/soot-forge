# syntax=docker/dockerfile:1
# Build context is packs/data-pool/runner only:
#   docker build -f packs/data-pool/service/Dockerfile packs/data-pool/runner
# Digests resolved 2026-10-11 with `docker buildx imagetools inspect`; bump
# both deliberately (golang:1.25, distroless static-debian12:nonroot).
FROM --platform=$BUILDPLATFORM golang:1.25@sha256:699337d620559a59b4a2bb298ad59611e535d2ee755a34cf2d2a98f37578dc80 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY *.go ./
# Cross-compile on the build host: a static binary needs no emulation.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/soot-data-pool .

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/soot-data-pool /soot-data-pool
# No writable state directory: pools, grants, documents, receipts, activity and
# admissions live in the operator's PostgreSQL database (schema data_pool).
USER 65532:65532
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/soot-data-pool", "healthcheck"]
ENTRYPOINT ["/soot-data-pool"]
CMD ["serve", "--config-env", "DATA_POOL_SERVICE_CONFIG"]
