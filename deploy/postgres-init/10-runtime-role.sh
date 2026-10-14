#!/bin/sh
# Creates the role the backend SERVES as, separate from the schema owner (POSTGRES_USER).
#
# The owner can drop audit_log's append-only rules, or TRUNCATE it (rules do not fire on
# TRUNCATE), so the process that writes the audit log must not connect as the owner. This
# makes a login role with no other powers; the backend's migrations then grant it what it
# needs and no more (packages/backend/src/dbRoles.ts), on every boot.
#
# The postgres image runs this ONCE, when the data directory is first initialised. On an
# existing volume it never runs: create the role by hand, as described in docker-compose.prod.yml.
#
# The password is read from the environment inside psql (\getenv) rather than passed on the
# command line, so it does not appear in the container's process list.
set -eu
: "${NEEDY_APP_DB_USER:?NEEDY_APP_DB_USER is required}"
: "${NEEDY_APP_DB_PASSWORD:?NEEDY_APP_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
\getenv app_role NEEDY_APP_DB_USER
\getenv app_password NEEDY_APP_DB_PASSWORD
SELECT format(
         'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
         :'app_role', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
\gexec
EOSQL
