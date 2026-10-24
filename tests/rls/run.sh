#!/usr/bin/env bash
# Runs the database isolation tests against a fresh, empty Postgres database.
#
#   TEST_DATABASE_URL=postgres://... bash tests/rls/run.sh   # use an existing server (CI)
#   bash tests/rls/run.sh                                     # start a throwaway local server
#
# The target database is dropped and recreated, so never point this at real data.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cleanup=""

if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  bindir="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
  : "${bindir:?Postgres server binaries not found; set TEST_DATABASE_URL instead}"
  tmp="$(mktemp -d)"
  run=()
  if [[ "$(id -u)" == "0" ]]; then
    chown postgres "$tmp"
    run=(runuser -u postgres --)
  fi
  "${run[@]}" "$bindir/initdb" -D "$tmp/data" -U postgres -A trust >/dev/null
  "${run[@]}" "$bindir/pg_ctl" -D "$tmp/data" -o "-k $tmp -p 54329 -c listen_addresses=''" -l "$tmp/log" -w start >/dev/null
  cleanup="${run[*]} $bindir/pg_ctl -D $tmp/data -m immediate stop"
  trap 'eval "$cleanup" >/dev/null; rm -rf "$tmp"' EXIT
  TEST_DATABASE_URL="postgresql://postgres@/postgres?host=$tmp&port=54329"
fi

admin_url="$TEST_DATABASE_URL"
psql "$admin_url" -qX -v ON_ERROR_STOP=1 -c "drop database if exists dcc_rls_test with (force)" -c "create database dcc_rls_test" >/dev/null
test_url="$(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(u.urlunparse(p._replace(path="/dcc_rls_test")))' "$admin_url")"

psql "$test_url" -qX -v ON_ERROR_STOP=1 -f "$here/supabase_stub.sql" >/dev/null
for migration in "$root"/supabase/migrations/*.sql; do
  psql "$test_url" -qX -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done
psql "$test_url" -qXAt -v ON_ERROR_STOP=1 -f "$here/isolation_test.sql" 2>&1 | grep -v '^$' | sed 's/^psql:[^ ]* NOTICE:  //'
