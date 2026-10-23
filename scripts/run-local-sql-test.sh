#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <migration.sql> <test.sql>" >&2
  exit 64
fi

if [[ -x /opt/homebrew/opt/postgresql@17/bin/psql ]]; then
  pg_bin=/opt/homebrew/opt/postgresql@17/bin/
else
  pg_bin=""
fi
host=${PGHOST:-127.0.0.1}
port=${PGPORT:-55432}
user=${PGUSER:-postgres}
database="ob1_template_test_${$}"
migration=$1
test_sql=$2
root=$(cd "$(dirname "$0")/.." && pwd)

cleanup() {
  "${pg_bin}dropdb" --if-exists -h "$host" -p "$port" -U "$user" "$database" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${pg_bin}createdb" -h "$host" -p "$port" -U "$user" "$database"
"${pg_bin}psql" -h "$host" -p "$port" -U "$user" -d "$database" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END
$$;
SQL
"${pg_bin}psql" -h "$host" -p "$port" -U "$user" -d "$database" -v ON_ERROR_STOP=1 \
  -f "$root/supabase/migrations/0001_open_brain_memory_core.sql"
"${pg_bin}psql" -h "$host" -p "$port" -U "$user" -d "$database" -v ON_ERROR_STOP=1 -f "$migration"
"${pg_bin}psql" -h "$host" -p "$port" -U "$user" -d "$database" -v ON_ERROR_STOP=1 -f "$test_sql"
