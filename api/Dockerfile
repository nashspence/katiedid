FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tini xz-utils \
  && rm -rf /var/lib/apt/lists/*

ARG TEMPORAL_CLI_VERSION=1.5.0
RUN arch="$(dpkg --print-architecture)" && \
    case "$arch" in amd64) a="amd64" ;; arm64) a="arm64" ;; *) echo "unsupported arch" >&2; exit 1 ;; esac && \
    curl -fsSL -o /tmp/temporal.tgz \
      "https://temporal.download/cli/archive/v${TEMPORAL_CLI_VERSION}?platform=linux&arch=${a}" && \
    tar -C /usr/local/bin -xzf /tmp/temporal.tgz temporal && rm /tmp/temporal.tgz

ARG PGRST_VERSION=12.2.3
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) candidates="linux-static-x64 linux-static-x86-64" ;; \
      arm64) candidates="linux-static-aarch64" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/PostgREST/postgrest/releases/download/v${PGRST_VERSION}/postgrest-v${PGRST_VERSION}"; \
    ok=""; \
    for a in $candidates; do \
      if curl -fsSL -o /tmp/pgrst.tar.xz "${base}-${a}.tar.xz"; then ok="yes"; break; fi; \
    done; \
    [ -n "$ok" ] || (echo "No matching PostgREST asset for arch=$arch candidates=$candidates" >&2; exit 1); \
    tar -C /usr/local/bin -xJf /tmp/pgrst.tar.xz postgrest; \
    rm /tmp/pgrst.tar.xz

ARG FLYWAY_VERSION=11.20.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) platform="linux-x64" ;; \
      arm64) echo "No official linux-arm64 CLI archive is documented for ${FLYWAY_VERSION}; use the Docker image approach below for arm64." >&2; exit 1 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/flyway.tar.gz \
      "https://github.com/flyway/flyway/releases/download/flyway-${FLYWAY_VERSION}/flyway-commandline-${FLYWAY_VERSION}-${platform}.tar.gz"; \
    tar -C /usr/local -xzf /tmp/flyway.tar.gz; \
    ln -sf "/usr/local/flyway-${FLYWAY_VERSION}/flyway" /usr/local/bin/flyway; \
    rm /tmp/flyway.tar.gz

COPY db /flyway/sql

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY reminders.py entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["/app/entrypoint.sh"]
