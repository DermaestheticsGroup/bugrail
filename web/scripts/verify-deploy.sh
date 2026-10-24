#!/usr/bin/env bash
# HTTP smoke test of a deployment. Reads BASIC_AUTH_*, BUGRAIL_ADMIN_*, VERCEL_AUTOMATION_BYPASS_SECRET from the env.
# usage: scripts/verify-deploy.sh <base url> <turso db name>
set -u
U=$1 DB=$2
# Credentials must not go out in cleartext; plain http only to loopback.
case "$U" in https://*|http://localhost|http://localhost[:/]*|http://127.0.0.1|http://127.0.0.1[:/]*) ;; *) echo "refusing non-https URL: $U" >&2; exit 2 ;; esac
B="$BASIC_AUTH_USER:$BASIC_AUTH_PASSWORD"
J=$(mktemp)
trap 'rm -f "$J"' EXIT
fail=0
check() { # <label> <expected code> <actual code>
  if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; else echo "FAIL $1 (want $2, got $3)"; fail=1; fi
}
login() { jq -cn --arg e "$BUGRAIL_ADMIN_EMAIL" --arg p "$1" '{email: $e, password: $p}'; }
code() { curl -s --max-time 30 -o /dev/null -w "%{http_code}" -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET:-}" "$@"; }

check "no basic auth -> 401" 401 "$(code "$U/")"
check "wrong basic auth -> 401" 401 "$(code -u "$BASIC_AUTH_USER:wrong" "$U/api/auth/me")"
check "page without session -> redirect /login" 307 "$(code -u "$B" "$U/")"
check "login page" 200 "$(code -u "$B" "$U/login")"
check "login wrong password -> 401" 401 "$(code -u "$B" -H 'content-type: application/json' -d "$(login nope12345)" "$U/api/auth/login")"
check "login admin" 200 "$(code -u "$B" -c "$J" -H 'content-type: application/json' -d "$(login "$BUGRAIL_ADMIN_PASSWORD")" "$U/api/auth/login")"
check "me with session" 200 "$(code -u "$B" -b "$J" "$U/api/auth/me")"
check "app shell with session" 200 "$(code -u "$B" -b "$J" "$U/")"
NAME="verify-$(date +%s)"
check "create workspace" 200 "$(code -u "$B" -b "$J" -H 'content-type: application/json' -d "{\"name\":\"$NAME\"}" "$U/api/admin/workspaces")"
if perl -e 'alarm 60; exec @ARGV' turso db shell "$DB" "select name from workspaces where name = '$NAME'" | grep -q "$NAME"; then echo "PASS workspace row in Turso $DB"; else echo "FAIL workspace row missing in Turso $DB"; fail=1; fi
exit $fail
