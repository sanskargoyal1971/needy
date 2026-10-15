# ── Needy Postgres backup sidecar ─────────────────────────────────────────────
# pg_dump must be the SAME major version as the server (postgres:16 in docker-compose.prod.yml)
# or newer; an older client refuses to dump a newer server. Building on the server's own image
# keeps the two in step: bump them together.
#
# Pinned by tag here; pin by digest (postgres:16-alpine@sha256:…) when promoting to a real
# deployment, so a rebuild cannot silently pick up a different image.
FROM postgres:16-alpine

# aws-cli for the upload (signs with the EC2 instance role via IMDSv2 — no keys in env),
# gnupg to encrypt to the backup public key, bash for the script.
RUN apk add --no-cache aws-cli gnupg bash

COPY deploy/backup/backup.sh /usr/local/bin/needy-backup
RUN chmod 755 /usr/local/bin/needy-backup && mkdir -p /status /work

# The server entrypoint is replaced: this container never runs postgres itself.
ENTRYPOINT ["/usr/local/bin/needy-backup"]
