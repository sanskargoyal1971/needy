#!/bin/bash
#
# Restore a Postgres backup made by the backup sidecar (deploy/backup/backup.sh).
#
#   scripts/restore-backup.sh --dry-run --latest
#   scripts/restore-backup.sh --latest                      # restore into a NEW database
#   scripts/restore-backup.sh --key postgres/needy-20261015T030000Z.dump.gpg --promote
#   scripts/restore-backup.sh --file ./needy-….dump.gpg --target-db needy_restore_check
#
# What it does, in order. Nothing is overwritten unless --promote is given, and even then the
# current database is renamed aside, not dropped:
#   1. fetch the encrypted dump (from S3, or a local file);
#   2. decrypt it with the backup PRIVATE key from $GNUPGHOME and check it is a complete
#      archive (`pg_restore --list`), before touching any database;
#   3. create a new database (default needy_restore_<UTC time>) and restore into it in a single
#      transaction, so a failure leaves an empty database rather than half of one;
#   4. print the migration level and a few row counts to sanity-check against expectations;
#   5. with --promote: stop backend and web, rename the live database to
#      needy_pre_restore_<time>, rename the restored one into its place, start them again.
#      The backend migrates a restored older schema forward on boot.
#
# Plaintext never touches disk: the dump is decrypted straight into pg_restore's stdin. The
# encrypted download lives in a 0700 temp directory and is removed on exit.
#
# Where it runs: on the host, from the repo checkout, as a user who can run docker compose.
# `RESTORE_MODE=direct` instead runs psql/pg_restore locally against $PGHOST etc. — used by the
# tests, and for restoring into a managed Postgres.
#
# Needs, besides the tools: AWS credentials that may s3:GetObject (and s3:ListBucket for
# --latest) on the backup bucket — an operator's, NOT the instance role, which is write-only —
# and the backup private key imported into $GNUPGHOME (ops/README.md, "Restore").
#
# Environment:
#   BACKUP_S3_BUCKET, BACKUP_S3_PREFIX (default postgres/)  for --latest / --key
#   RESTORE_MODE   compose (default) | direct
#   COMPOSE_FILE   default docker-compose.prod.yml;  ENV_FILE  default /etc/needy/needy.env
#   POSTGRES_USER  default needy;  POSTGRES_DB  default needy (the live database's name)

set -euo pipefail

usage() {
  sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Options: --dry-run  --latest | --key KEY | --file PATH  --target-db NAME  --promote  --yes"
}

DRY_RUN=0
SOURCE_KIND=""
SOURCE=""
TARGET=""
PROMOTE=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --latest) SOURCE_KIND=latest ;;
    --key)
      SOURCE_KIND=key
      SOURCE="${2:?--key needs an S3 key}"
      shift
      ;;
    --file)
      SOURCE_KIND=file
      SOURCE="${2:?--file needs a path}"
      shift
      ;;
    --target-db)
      TARGET="${2:?--target-db needs a name}"
      shift
      ;;
    --promote) PROMOTE=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

die() {
  echo "restore: $*" >&2
  exit 1
}
step() { echo "==> $*"; }

[ -n "$SOURCE_KIND" ] || die "say what to restore: --latest, --key KEY or --file PATH"

MODE="${RESTORE_MODE:-compose}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/etc/needy/needy.env}"
PG_USER="${POSTGRES_USER:-needy}"
LIVE_DB="${POSTGRES_DB:-needy}"
BUCKET="${BACKUP_S3_BUCKET:-}"
PREFIX="${BACKUP_S3_PREFIX:-postgres/}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
TARGET="${TARGET:-needy_restore_${STAMP}}"
ASIDE="needy_pre_restore_${STAMP}"

# Database names reach SQL as identifiers. They are also passed as psql variables and quoted
# with :"name", but a strict shape check first means a typo cannot even get that far.
DB_NAME='^[a-z_][a-z0-9_]{0,62}$'
[[ "$TARGET" =~ $DB_NAME ]] || die "--target-db must match $DB_NAME"
[[ "$LIVE_DB" =~ $DB_NAME ]] || die "POSTGRES_DB must match $DB_NAME"
[ "$TARGET" != "$LIVE_DB" ] || die "--target-db must not be the live database; use --promote"
case "$MODE" in compose | direct) ;; *) die "RESTORE_MODE must be compose or direct" ;; esac

case "$SOURCE_KIND" in
  latest | key) [ -n "$BUCKET" ] || die "BACKUP_S3_BUCKET is required for --latest / --key" ;;
  file) [ -r "$SOURCE" ] || [ "$DRY_RUN" = 1 ] || die "cannot read $SOURCE" ;;
esac

# ── how psql and pg_restore are reached ─────────────────────────────────────
# compose: inside the postgres container, over its local socket, as the schema owner.
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
pg_psql() {
  if [ "$MODE" = compose ]; then
    compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$PG_USER" "$@"
  else
    psql -X -q -v ON_ERROR_STOP=1 "$@"
  fi
}
pg_restore_cmd() {
  if [ "$MODE" = compose ]; then
    compose exec -T postgres pg_restore -U "$PG_USER" "$@"
  else
    pg_restore "$@"
  fi
}

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }

# ── dry run: say everything, do nothing ─────────────────────────────────────
# No network, no decryption, no database connection, no temp files: a dry run must be safe to
# run anywhere, including on a laptop with no access, to check what a real run would do.
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY RUN — nothing will be downloaded, decrypted, created or changed."
  case "$SOURCE_KIND" in
    latest) step "find the newest object under s3://$BUCKET/$PREFIX (aws s3api list-objects-v2)" ;;
    key) step "use s3://$BUCKET/$SOURCE" ;;
    file) step "use local file $SOURCE" ;;
  esac
  [ "$SOURCE_KIND" = file ] || step "download it into a private temp directory (aws s3 cp)"
  step "decrypt with the private key in \$GNUPGHOME and verify the archive (gpg --decrypt | pg_restore --list)"
  step "refuse if database $TARGET already exists"
  step "CREATE DATABASE $TARGET, then gpg --decrypt | pg_restore --single-transaction --exit-on-error -d $TARGET"
  step "report schema_migrations level and row counts from $TARGET"
  if [ "$PROMOTE" = 1 ]; then
    [ "$MODE" = compose ] && step "docker compose stop backend web"
    step "rename $LIVE_DB -> $ASIDE, then $TARGET -> $LIVE_DB (old database kept, not dropped)"
    [ "$MODE" = compose ] && step "docker compose start backend web"
  else
    step "leave $LIVE_DB untouched (no --promote)"
  fi
  echo "mode=$MODE  target=$TARGET"
  exit 0
fi

# ── preflight ──────────────────────────────────────────────────────────────
need gpg
[ "$SOURCE_KIND" = file ] || need aws
if [ "$MODE" = compose ]; then need docker; else
  need psql
  need pg_restore
fi
if ! gpg --batch --list-secret-keys 2>/dev/null | grep -q .; then
  die "no secret key in \$GNUPGHOME — import the backup private key first (ops/README.md)"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/needy-restore.XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# ── 1. fetch ───────────────────────────────────────────────────────────────
case "$SOURCE_KIND" in
  latest)
    step "finding the newest backup under s3://$BUCKET/$PREFIX"
    SOURCE="$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX" \
      --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)"
    [ -n "$SOURCE" ] && [ "$SOURCE" != "None" ] || die "no backups under s3://$BUCKET/$PREFIX"
    ;;
esac
if [ "$SOURCE_KIND" = file ]; then
  ENCRYPTED="$SOURCE"
else
  step "downloading s3://$BUCKET/$SOURCE"
  ENCRYPTED="$WORK/backup.dump.gpg"
  aws s3 cp "s3://$BUCKET/$SOURCE" "$ENCRYPTED" --only-show-errors
fi

decrypt() { gpg --batch --quiet --decrypt "$ENCRYPTED"; }

# ── 2. verify before touching any database ─────────────────────────────────
step "verifying the archive"
decrypt | pg_restore_cmd --list >/dev/null || die "backup does not decrypt to a complete archive"

# ── 3. restore into a new database ─────────────────────────────────────────
exists="$(pg_psql -d postgres -tA -v target="$TARGET" <<<"SELECT 1 FROM pg_database WHERE datname = :'target'")"
[ -z "$exists" ] || die "database $TARGET already exists; choose another --target-db"

step "creating $TARGET and restoring into it"
pg_psql -d postgres -v target="$TARGET" <<<'CREATE DATABASE :"target"'
if ! decrypt | pg_restore_cmd --single-transaction --exit-on-error -d "$TARGET"; then
  die "restore failed; $TARGET is left EMPTY (single transaction) — drop it when done looking"
fi

# ── 4. sanity report ───────────────────────────────────────────────────────
step "restored $TARGET:"
if ! pg_psql -d "$TARGET" -tA <<'SQL'
SELECT 'schema_migrations max id: ' || coalesce(max(id)::text, 'none') FROM schema_migrations;
SELECT 'users: '      || count(*) FROM users;
SELECT 'tasks: '      || count(*) FROM tasks;
SELECT 'sos_alerts: ' || count(*) FROM sos_alerts;
SELECT 'audit_log: '  || count(*) FROM audit_log;
SQL
then
  # Not fatal: an old backup may predate one of these tables. The restore itself succeeded.
  echo "(sanity report incomplete — a table above is missing from this backup's schema)"
fi

if [ "$PROMOTE" = 0 ]; then
  echo "Live database $LIVE_DB is untouched. Re-run with --promote to swap $TARGET into place,"
  echo "or inspect it and DROP DATABASE $TARGET when done."
  exit 0
fi

# ── 5. promote ─────────────────────────────────────────────────────────────
if [ "$ASSUME_YES" != 1 ]; then
  echo "About to take the app down and replace $LIVE_DB with $TARGET."
  echo "Everything written to $LIVE_DB since this backup was taken will no longer be live"
  echo "(it is kept in $ASIDE). Type the live database name ($LIVE_DB) to continue:"
  read -r answer
  [ "$answer" = "$LIVE_DB" ] || die "not confirmed; nothing changed"
fi

if [ "$MODE" = compose ]; then
  step "stopping backend and web"
  compose stop backend web
fi
step "renaming $LIVE_DB -> $ASIDE and $TARGET -> $LIVE_DB"
pg_psql -d postgres -v live="$LIVE_DB" -v aside="$ASIDE" -v target="$TARGET" <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname IN (:'live', :'target') AND pid <> pg_backend_pid();
ALTER DATABASE :"live" RENAME TO :"aside";
ALTER DATABASE :"target" RENAME TO :"live";
SQL
if [ "$MODE" = compose ]; then
  step "starting backend and web (the backend migrates the restored schema forward on boot)"
  compose start backend web
fi
echo "Promoted. The previous database is kept as $ASIDE; drop it once the restore is confirmed."
