#!/bin/bash
#
# Postgres backup sidecar (docker-compose.prod.yml, service `backup`).
#
# On a schedule: pg_dump (custom format) → encrypt to the backup PUBLIC key with gpg → upload
# to S3 with SSE-KMS, using the EC2 instance role's credentials. Then record the time in
# $BACKUP_STATUS_DIR/last-success, which the backend serves as
# needy_backup_last_success_timestamp_seconds so a stalled backup pages somebody.
#
# Why the encryption is to a public key: the host can make backups but cannot read them. The
# private key lives offline / in Secrets Manager and is fetched only to restore
# (scripts/restore-backup.sh). A compromised host therefore gets no history it did not already
# have in the live database, and the script refuses to start if handed a private key.
#
# Why dump to a file first rather than stream straight into `aws s3 cp -`: if pg_dump dies
# mid-stream, gpg sees an ordinary end of input and finishes a perfectly valid encrypted file
# of a TRUNCATED dump, and the upload succeeds. Writing the file, checking pg_dump's own exit
# status, and only then uploading means a failed dump never becomes an object in the bucket
# that looks like a backup. The work file is ciphertext; plaintext never touches disk.
#
# Retention is NOT handled here: the instance role may only PutObject, so it cannot delete
# old backups (nor can whoever compromises the host). Expiry is the bucket's lifecycle rule —
# see ops/README.md.
#
# Environment (all set by docker-compose.prod.yml):
#   BACKUP_S3_BUCKET          required
#   BACKUP_S3_PREFIX          key prefix, default "postgres/"
#   BACKUP_KMS_KEY_ID         optional KMS key for SSE-KMS (bucket default key when unset)
#   BACKUP_INTERVAL_SECONDS   default 86400 (daily)
#   BACKUP_RETRY_SECONDS      wait after a failed attempt, default 900
#   BACKUP_GPG_PUBLIC_KEY     path of the armoured public key, default /run/backup-key/public.asc
#   BACKUP_STATUS_DIR         default /status (shared read-only with the backend)
#   BACKUP_WORK_DIR           default /work
#   BACKUP_ONCE=1             one attempt, exit with its status (for tests and manual runs)
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE — the schema OWNER, which can read every table.

set -euo pipefail

BUCKET="${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET}"
PREFIX="${BACKUP_S3_PREFIX:-postgres/}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETRY="${BACKUP_RETRY_SECONDS:-900}"
KEY_FILE="${BACKUP_GPG_PUBLIC_KEY:-/run/backup-key/public.asc}"
STATUS_DIR="${BACKUP_STATUS_DIR:-/status}"
WORK_DIR="${BACKUP_WORK_DIR:-/work}"
ONCE="${BACKUP_ONCE:-0}"

# One JSON object per line, like the backend's logger, so the same log pipeline reads both.
# Messages are fixed strings from this file; nothing user-supplied is interpolated.
log() {
  printf '{"level":"%s","msg":"%s","service":"backup","at":"%s"}\n' \
    "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
}

is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

if ! is_uint "$INTERVAL" || [ "$INTERVAL" -lt 3600 ]; then
  # More often than hourly is almost certainly a typo (seconds for minutes), and each run is a
  # full dump: refuse rather than hammer the database.
  log error "BACKUP_INTERVAL_SECONDS must be an integer of at least 3600"
  exit 64
fi
if ! is_uint "$RETRY" || [ "$RETRY" -lt 60 ]; then
  log error "BACKUP_RETRY_SECONDS must be an integer of at least 60"
  exit 64
fi
case "$PREFIX" in
  */) ;;
  *) PREFIX="${PREFIX}/" ;;
esac

# ── the key ─────────────────────────────────────────────────────────────────
if [ ! -r "$KEY_FILE" ]; then
  log error "backup public key not readable at BACKUP_GPG_PUBLIC_KEY"
  exit 66
fi
if grep -q "PRIVATE KEY BLOCK" "$KEY_FILE"; then
  # The host must never hold the key that reads its own backups.
  log error "BACKUP_GPG_PUBLIC_KEY holds a PRIVATE key; refusing. Mount the public key only"
  exit 65
fi

GNUPGHOME="$(mktemp -d "${TMPDIR:-/tmp}/backup-gnupg.XXXXXX")"
export GNUPGHOME
chmod 700 "$GNUPGHOME"
cleanup() {
  gpgconf --kill all >/dev/null 2>&1 || true
  rm -rf "$GNUPGHOME"
}
trap cleanup EXIT
# Prove the file parses as a key before the first scheduled run, not at 03:00.
if ! gpg --batch --quiet --show-keys "$KEY_FILE" >/dev/null 2>&1; then
  log error "BACKUP_GPG_PUBLIC_KEY is not a valid OpenPGP public key"
  exit 65
fi

sse_args=(--sse aws:kms)
if [ -n "${BACKUP_KMS_KEY_ID:-}" ]; then
  sse_args+=(--sse-kms-key-id "$BACKUP_KMS_KEY_ID")
fi

# ── one backup ──────────────────────────────────────────────────────────────
backup_once() {
  local ts object work
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  object="${PREFIX}needy-${ts}.dump.gpg"
  work="${WORK_DIR}/needy-${ts}.dump.gpg"
  mkdir -p "$WORK_DIR"
  rm -f "$WORK_DIR"/needy-*.dump.gpg

  log info "backup started"
  # pipefail: the pipeline fails if pg_dump fails, even though gpg exited 0.
  if ! pg_dump --format=custom --no-password | gpg --batch --yes --trust-model always \
    --recipient-file "$KEY_FILE" --encrypt --output "$work"; then
    rm -f "$work"
    log error "pg_dump or encryption failed; nothing uploaded"
    return 1
  fi
  if [ ! -s "$work" ]; then
    rm -f "$work"
    log error "encrypted dump is empty; nothing uploaded"
    return 1
  fi

  if ! aws s3 cp "$work" "s3://${BUCKET}/${object}" "${sse_args[@]}" --only-show-errors; then
    rm -f "$work"
    log error "upload to S3 failed"
    return 1
  fi
  rm -f "$work"

  # Written then renamed, so the backend never reads a half-written number. Checked explicitly:
  # this function runs as an `if` condition, where `set -e` does not apply, and an unrecorded
  # success would let the BackupTooOld alert fire about a backup that exists — or, worse, a
  # stale file would let it stay quiet about one that does not.
  if ! { date -u +%s >"${STATUS_DIR}/last-success.tmp" &&
    chmod 644 "${STATUS_DIR}/last-success.tmp" &&
    mv -f "${STATUS_DIR}/last-success.tmp" "${STATUS_DIR}/last-success"; }; then
    log error "backup uploaded but its status could not be recorded"
    return 1
  fi
  log info "backup uploaded"
}

if [ "$ONCE" = "1" ]; then
  backup_once
  exit $?
fi

# ── schedule ────────────────────────────────────────────────────────────────
# Interval since the last SUCCESS, read back from the status file, so restarting the container
# (every deploy) neither skips a day nor dumps again an hour after the last one. A host with
# no status file yet backs up at once.
#
# `sleep & wait` so SIGTERM from `docker compose stop` ends the wait immediately instead of
# after up to a day; an upload in progress is allowed to finish only if it fits in the stop
# timeout, and an interrupted one leaves no status update, so the next start retries it.
trap 'log info "stopping"; exit 0' TERM INT
nap() {
  sleep "$1" &
  wait $! || true
}

while :; do
  last=0
  if [ -r "${STATUS_DIR}/last-success" ]; then
    read -r last <"${STATUS_DIR}/last-success" || true
    is_uint "$last" || last=0
  fi
  now="$(date -u +%s)"
  due=$((last + INTERVAL))
  if [ "$now" -lt "$due" ]; then
    nap $((due - now))
    continue
  fi
  if backup_once; then
    nap "$INTERVAL"
  else
    nap "$RETRY"
  fi
done
