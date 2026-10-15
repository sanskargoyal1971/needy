# Needy operations runbook

Backups, metrics and alerting for the single-host deployment (`docker-compose.prod.yml`).

> **Status.** Everything here is code and configuration. No monitoring stack is deployed by
> this repository, no alert has been sent to a real receiver, and the backup sidecar has not
> been run against real S3. The steps below are what an operator does to make them real.

| File                           | What it is                                             |
| ------------------------------ | ------------------------------------------------------ |
| `alerts.yml`                   | Prometheus alerting rules, ready to load.              |
| `prometheus.example.yml`       | Scrape config for the backend, with bearer-token auth. |
| `backup-bucket-lifecycle.json` | S3 lifecycle rule that enforces backup retention.      |
| `../deploy/backup/`            | The backup sidecar (Dockerfile + `backup.sh`).         |
| `../scripts/restore-backup.sh` | The restore, with `--dry-run`.                         |

---

## 1. Metrics

`GET /metrics` on the backend returns Prometheus text format. Nothing in it names a person:
labels are an HTTP method, a route **template** (`/tasks/:id`), a status code, a socket
namespace, a sweep name, an SOS status or a dependency name.

| Metric                                                                                               | Meaning                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `process_uptime_seconds`, `process_resident_memory_bytes`, `nodejs_heap_*_bytes`                     | Process health                                          |
| `nodejs_eventloop_lag_{mean,p99,max}_seconds`                                                        | Event-loop delay since the previous scrape              |
| `needy_http_requests_total`, `needy_http_request_duration_seconds`                                   | Requests by method, route, status                       |
| `needy_socket_connections{namespace}`                                                                | Open Socket.io connections on this process              |
| `needy_sweep_runs_total`, `needy_sweep_failures_total`, `needy_sweep_last_success_timestamp_seconds` | `matching_offer_expiry` and `sos_escalation` loops      |
| `needy_sos_open_alerts{status}`, `needy_sos_oldest_unacknowledged_age_seconds`                       | Alarms still owed an answer                             |
| `needy_upload_slots_in_use`, `needy_upload_slots_max`                                                | Document upload concurrency                             |
| `needy_dependency_up{dependency}`                                                                    | Redis / Postgres answered the same probe `/health` uses |
| `needy_backup_last_success_timestamp_seconds`                                                        | From the backup sidecar's status file                   |

**Access.** Two locks:

1. `METRICS_TOKEN` (at least 32 random characters, from Secrets Manager into `needy.env`). The
   scraper sends `Authorization: Bearer <token>`; the comparison is constant-time. With the
   variable unset the route is not mounted and answers 404.
2. Caddy answers `/metrics` on `api.<DOMAIN>` with 404, so it is never reachable from the
   internet even if the token leaks.

**Health.** `GET /health` stays as it is: it already has readiness semantics (it probes Redis
and Postgres and answers 503 when either is down) and is what the container healthcheck reads.
Every request now also gets an `X-Request-Id` (echoed if the client sent a well-formed one) and
one structured `http request` log line with method, route template, status and duration — no
path, query string, IP or user id. `/health` and `/metrics` are logged only when they fail.

### Wiring the metrics

The backend port is not published, so the scraper must join the compose network. The smallest
working shape is a second compose file next to the production one, e.g. `/etc/needy/monitoring.yml`:

```yaml
services:
  prometheus:
    image: prom/prometheus:v2.54.1 # pin by digest when you adopt it
    restart: unless-stopped
    volumes:
      - ./ops/prometheus.example.yml:/etc/prometheus/prometheus.yml:ro
      - ./ops/alerts.yml:/etc/prometheus/alerts.yml:ro
      - /etc/needy/metrics-token:/etc/prometheus/metrics-token:ro
      - prometheus-data:/prometheus
  alertmanager:
    image: prom/alertmanager:v0.27.0
    restart: unless-stopped
    volumes:
      - /etc/needy/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
volumes:
  prometheus-data:
```

```sh
docker compose --env-file /etc/needy/needy.env -f docker-compose.prod.yml -f /etc/needy/monitoring.yml up -d
```

Do **not** publish Prometheus's or Alertmanager's ports; reach their UIs over an SSH tunnel.
Neither should get a fixed address in `172.30.0.10/31` — those two may reach instance metadata.

Before trusting it, check the rules load: `promtool check rules ops/alerts.yml`.

### Wiring alerts to a receiver

`alerts.yml` labels every alert `severity: page` or `severity: ticket`. A minimal
`/etc/needy/alertmanager.yml` that pages on one and emails the other:

```yaml
route:
  receiver: ticket
  group_by: [alertname]
  routes:
    - matchers: [severity="page"]
      receiver: page
      repeat_interval: 15m
receivers:
  - name: page
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/pagerduty-key # or opsgenie_configs / webhook_configs
  - name: ticket
    email_configs:
      - to: YOUR_OPS_MAILBOX
        from: YOUR_SENDER
        smarthost: YOUR_SMTP_HOST:587
        auth_username: YOUR_SMTP_USER
        auth_password_file: /etc/alertmanager/smtp-password
```

Keys and passwords go in files written from Secrets Manager, never in this repository. Then
prove the path end to end: `amtool alert add NeedyTest severity=page` and confirm the page
arrives. `NeedySosUnacknowledged` is the one that matters most — test it in staging by raising
an SOS and not acknowledging it for three minutes.

Also worth adding outside the host: an uptime check against `https://api.<DOMAIN>/health` from
a different network (Route 53 health check, or any external pinger). Prometheus on the same
host cannot tell you the host is gone.

---

## 2. Backups

The `backup` service in `docker-compose.prod.yml` runs `deploy/backup/backup.sh`:

1. `pg_dump --format=custom` as the schema owner;
2. encrypted with gpg to the **public** backup key — the host can write backups it cannot read;
3. written to a work file (ciphertext only) and uploaded only if `pg_dump` succeeded, so a dump
   that died half-way never becomes an object that looks like a backup;
4. uploaded with `aws s3 cp --sse aws:kms` using the EC2 instance role (no keys in env);
5. the time recorded in the `backup-status` volume, which the backend serves as
   `needy_backup_last_success_timestamp_seconds`.

The schedule is `BACKUP_INTERVAL_SECONDS` (default 86400) measured from the last success, so a
restart neither skips a day nor dumps twice. A failure retries after `BACKUP_RETRY_SECONDS`
(default 900). Run one by hand with
`docker compose ... run --rm -e BACKUP_ONCE=1 backup`.

### One-time setup

1. **Key pair, offline.** On a trusted machine, not the host:
   `gpg --quick-gen-key "needy-backups" ed25519 cert never` then add an encryption subkey
   (`gpg --quick-add-key <FPR> cv25519 encr never`). Export the public key to
   `/etc/needy/backup-public-key.asc` on the host. Store the **private** key (and its
   passphrase) in Secrets Manager under a path only restore operators can read. Without it no
   backup can ever be read.
2. **Bucket.** A dedicated private bucket (not the KYC bucket): Block Public Access on,
   versioning on, default encryption SSE-KMS, and the lifecycle rule:
   `aws s3api put-bucket-lifecycle-configuration --bucket <BACKUP_S3_BUCKET> --lifecycle-configuration file://ops/backup-bucket-lifecycle.json`.
   That keeps 35 days of dumps and deletes older ones. Consider S3 Object Lock (compliance
   mode, ≥ 7 days) so nobody — including a compromised operator account — can delete recent
   backups early.
3. **Instance role.** Add to the instance profile's role, and nothing more:

   ```json
   {
     "Effect": "Allow",
     "Action": "s3:PutObject",
     "Resource": "arn:aws:s3:::<BACKUP_S3_BUCKET>/postgres/*"
   }
   ```

   plus `kms:GenerateDataKey` on the bucket's KMS key. No `GetObject`, `ListBucket` or
   `DeleteObject`: retention is the lifecycle rule's job, not the host's.

4. **IMDS firewall.** The sidecar has the fixed address `172.30.0.11` and needs instance
   metadata for its credentials. New hosts get the widened rule from `deploy-ec2.sh`. On an
   **existing** host, edit `/etc/systemd/system/needy-imds-guard.service` so both `172.30.0.10/32`
   become `172.30.0.10/31`, then
   `sudo iptables -D DOCKER-USER -d 169.254.169.254/32 ! -s 172.30.0.10/32 -j DROP && sudo systemctl daemon-reload && sudo systemctl restart needy-imds-guard`.
   Until then the sidecar's uploads fail with a credentials error (and `NeedyBackupTooOld` fires).
5. **Env.** In `needy.env`: `BACKUP_S3_BUCKET`, `BACKUP_GPG_PUBLIC_KEY_FILE=/etc/needy/backup-public-key.asc`,
   optionally `BACKUP_S3_PREFIX`, `BACKUP_S3_REGION`, `BACKUP_KMS_KEY_ID`, `BACKUP_INTERVAL_SECONDS`.
   Compose refuses to start without the first two.

### Keys that must survive with the backups

A dump restores rows; several columns are sealed with keys that are **not** in the database.
Keep these wherever the backup private key is kept, or the restore is of limited use:

- `PII_ENCRYPTION_KEY` (+ any `PII_ENCRYPTION_KEYS_PREVIOUS`) — phone numbers, dates of birth;
- `PII_INDEX_KEY` — every phone lookup; a different value makes every account unfindable;
- `TOTP_ENCRYPTION_KEY` — staff second factors;
- `JWT_SECRET` — keys pre-migration-12 phone blocks (see `config.ts`).

### Personal data in backups (DPDP)

Backups contain personal data (encrypted columns, plus task addresses and chat). They are
encrypted twice (gpg + SSE-KMS) and kept 35 days. That number is also the bound on how long an
erased user's data survives in backups — keep the lifecycle rule in line with the published
retention policy, and record restores (below) so erased records are re-erased afterwards.

---

## 3. Restore

`scripts/restore-backup.sh` restores into a **new** database, verifies it, and only replaces the
live one with `--promote` (which renames the old one aside — nothing is dropped).

```sh
# 0. See exactly what it will do. No network, no decryption, no database access.
scripts/restore-backup.sh --dry-run --latest --promote

# 1. Operator credentials (NOT the instance role — it cannot read backups), and the private key
#    in a throwaway keyring:
export BACKUP_S3_BUCKET=<bucket>
export GNUPGHOME="$(mktemp -d)"; chmod 700 "$GNUPGHOME"
aws secretsmanager get-secret-value --secret-id <backup-key-secret> --query SecretString --output text | gpg --batch --import

# 2. Restore the newest backup beside the live database, and look at the report it prints.
sudo -E scripts/restore-backup.sh --latest

# 3. If it is right, swap it in (asks you to type the database name).
sudo -E scripts/restore-backup.sh --latest --promote

# 4. Afterwards
rm -rf "$GNUPGHOME"
```

Then: confirm `/health` is green, record the restore (time, backup key, operator) in the
incident log, and drop `needy_pre_restore_*` once satisfied. Everything written after the backup
was taken is in that renamed database, not the live one — including audit-log rows; the
restored audit chain is internally consistent but ends at the backup.

**Rehearse it.** Restore into a scratch database monthly (`--target-db needy_restore_drill`, no
`--promote`) and drop it after. An untested backup is a hope, not a backup.

---

## 4. What is and is not recoverable

| Data                                                                                                                         | Where it lives                        | After container restart | After host loss                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts, tasks, chat, SOS alerts, KYC review state, audit log                                                               | Postgres (`pg-data` volume)           | Kept                    | Restored from the last backup — up to `BACKUP_INTERVAL_SECONDS` (a day) lost                                                                  |
| KYC documents, selfies, video                                                                                                | S3 KYC bucket                         | Kept                    | Kept (S3); enable versioning to survive deletion mistakes                                                                                     |
| Presence, live locations, open offers and search waves, rate-limit buckets, OTP codes, pending staff logins, chat dedup keys | Redis, AOF on the `redis-data` volume | Kept (AOF)              | **Lost.** Not backed up, by design: all of it is minutes-lived. Users sign in again, helpers go online again, live searches must be restarted |
| SOS escalation schedule                                                                                                      | Redis                                 | Kept                    | Rebuilt from Postgres by the sweep's reconcile pass within a minute of boot                                                                   |
| Secrets                                                                                                                      | Secrets Manager / SSM                 | —                       | Kept, if they were never only on the host                                                                                                     |
| Metrics history                                                                                                              | Prometheus volume, if deployed        | Kept                    | Lost; not worth backing up                                                                                                                    |

---

## 5. Moving to managed Postgres and Redis

On RDS for PostgreSQL / ElastiCache for Redis, the following would be replaced:

- **Backup sidecar and lifecycle rule** → RDS automated backups with point-in-time recovery
  (5-minute RPO instead of a day), plus AWS Backup for cross-region copies. Keep a monthly
  logical dump if you want backups independent of the RDS account.
- **`restore-backup.sh --promote`** → restore-to-point-in-time into a new instance and repoint
  `DATABASE_URL`. The script still works for logical dumps with `RESTORE_MODE=direct`.
- **`needy_dependency_up` as the only DB health signal** → CloudWatch RDS/ElastiCache metrics
  (CPU, connections, replication lag, free storage) alongside it.
- **Redis AOF on a local volume** → ElastiCache with Multi-AZ failover; Redis data is still
  ephemeral by design, so no Redis backups are needed.
- **The IMDS address pinning for the sidecar** → gone with the sidecar.

The backend's own metrics, `/health`, and every alert in `alerts.yml` except the two backup ones
stay as they are.
