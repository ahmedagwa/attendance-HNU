#!/usr/bin/env bash
# Runs the SQL migrations + tests against a throw-away local PostgreSQL cluster.
# Requires PostgreSQL 15+ binaries (apt install postgresql, or brew install postgresql@16).
set -euo pipefail
cd "$(dirname "$0")/../.."
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$PGBIN" ] && export PATH="$PGBIN:$PATH"
command -v initdb >/dev/null || { echo "PostgreSQL binaries not found"; exit 1; }

DIR="$(mktemp -d)"; PORT="${PGTEST_PORT:-54329}"; RUNAS=""
if [ "$(id -u)" = "0" ]; then chown "$(id -un nobody 2>/dev/null || echo nobody)" "$DIR" 2>/dev/null || true; RUNAS="su nobody -s /bin/bash -c"; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "export PATH=$PATH; $*"; else bash -c "$*"; fi; }
cleanup() { run "pg_ctl -D $DIR/data stop -m immediate >/dev/null 2>&1" || true; rm -rf "$DIR"; }
trap cleanup EXIT

run "initdb -D $DIR/data -A trust -U postgres >/dev/null"
run "pg_ctl -D $DIR/data -o '-p $PORT -k $DIR -c listen_addresses=' -l $DIR/log -w start >/dev/null"
PSQL="psql -h $DIR -p $PORT -U postgres -X -q -v ON_ERROR_STOP=1"
run "$PSQL -c 'create database att' postgres"
APPLY="$PSQL -d att"
run "$APPLY -f supabase/tests/shim.sql"
for f in supabase/migrations/*.sql; do echo "migrate: $f"; run "$APPLY -f $f"; done

echo "== constraint / RLS / function tests =="
if run "$APPLY -f supabase/tests/db.test.sql" >"$DIR/db.out" 2>&1; then
  grep -E "ok -|PASSED" "$DIR/db.out"; echo "db.test.sql: PASS"
else
  cat "$DIR/db.out" | tail -15; echo "db.test.sql: FAIL"; exit 1
fi

echo "== concurrency: 100 students + 20 racing attempts for one student =="
run "$PSQL -c 'create database att2' postgres"
APPLY2="$PSQL -d att2"
run "$APPLY2 -f supabase/tests/shim.sql"
for f in supabase/migrations/*.sql; do run "$APPLY2 -f $f" >/dev/null; done
run "$APPLY2 -f supabase/tests/concurrency.sql" >/dev/null
run "$PSQL -d att2 -At -F' ' -c 'select attempt_id, student_id, installation_id from tmp_work'" > "$DIR/work.txt"

cat > "$DIR/worker.sh" <<WORKER
#!/usr/bin/env bash
export PATH="$PATH"
psql -h "$DIR" -p "$PORT" -U postgres -X -q -d att2 -At -c "select outcome from commit_qr_attendance('\$1','\$2',null,'\$3','auto',null,null,null,null,'ok')"
WORKER
cat > "$DIR/check.sql" <<'CHECK'
do $$ begin
  if (select count(*) from attendance_records) <> 101 then
    raise exception 'expected 101 records, got %', (select count(*) from attendance_records);
  end if;
  if (select count(*) from attendance_records where student_id = '00000000-0000-0000-0000-0000000000dd') <> 1 then
    raise exception 'racing attempts produced duplicate rows';
  end if;
end $$;
CHECK
chmod 755 "$DIR/worker.sh"; chmod 644 "$DIR/check.sql" "$DIR/work.txt"
run "xargs -P 60 -L 1 $DIR/worker.sh < $DIR/work.txt > $DIR/results.txt"
echo "outcomes (120 parallel commits):"; sort "$DIR/results.txt" | uniq -c
run "$PSQL -d att2 -f $DIR/check.sql" && echo "concurrency: PASS (101 records, zero duplicates)"
