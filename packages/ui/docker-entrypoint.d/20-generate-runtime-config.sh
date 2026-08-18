#!/bin/sh
# Regenerates runtime-config.js from the API_ORIGIN env var before nginx starts (this is the
# official nginx image's own /docker-entrypoint.d/ convention — every *.sh in here runs
# automatically). Vite bakes env vars at *build* time, but this image is built once and reused
# across arbitrary Helm installs, each potentially pointing at a different API domain (see
# charts/a5e's api.origin value) — so the API's origin has to be injected at container start
# instead, overwriting the empty-string dev/build-time default checked into public/runtime-config.js.
set -eu

api_origin="${API_ORIGIN:-}"
# Escape single quotes and backslashes so the value can't break out of the JS string literal
# below — api.origin is operator-supplied via Helm values, not attacker input, but there's no
# reason to trust it's well-formed either.
escaped=$(printf '%s' "$api_origin" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")

cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__A5E_CONFIG__ = { apiOrigin: '${escaped}' };
EOF
