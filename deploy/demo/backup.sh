#!/bin/bash
#
# Nightly backup for the PRIVATE/PUBLIC SANDBOX DEMO (deploy/demo). Installed on the host as
# /usr/local/bin/needy-demo-backup and run by needy-demo-backup.timer.
#
# What: a pg_dump of the database and a tarball of the uploads volume.
# Where: /var/backups/needy-demo, root-only (700, files 600), on the instance's encrypted EBS
#        root volume. Keeps the newest 7 of each.
#
# Stated plainly: this is on the SAME disk as the data. It protects against a bad deploy, a
# dropped table or a deleted volume — not against losing the instance. Production uses the
# encrypted off-host S3 backups in deploy/backup instead.

set -euo pipefail

DIR=/var/backups/needy-demo
KEEP=7
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PROJECT=needy-demo

install -d -m 700 -o root -g root "$DIR"
umask 077

# Custom format: compressed, and restorable table by table with pg_restore.
docker exec "${PROJECT}-postgres-1" pg_dump -U needy -d needy -Fc > "$DIR/db-$STAMP.dump.tmp"
mv "$DIR/db-$STAMP.dump.tmp" "$DIR/db-$STAMP.dump"

UPLOADS=$(docker volume inspect "${PROJECT}_uploads" --format '{{ .Mountpoint }}' 2>/dev/null || true)
if [ -n "$UPLOADS" ] && [ -d "$UPLOADS" ]; then
  tar -C "$UPLOADS" -czf "$DIR/uploads-$STAMP.tar.gz.tmp" .
  mv "$DIR/uploads-$STAMP.tar.gz.tmp" "$DIR/uploads-$STAMP.tar.gz"
fi

# Rotate: keep the newest $KEEP of each kind.
for kind in db uploads; do
  ls -1t "$DIR"/"$kind"-* 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
done

echo "needy-demo backup ok: $STAMP"
