#!/bin/sh
# Switches only the web page of a running relay to a new build; the relay process keeps running.
# Old hashed assets stay so pages still open on the previous version keep working (sw.js moves them over).
#
# Pack on the development computer after `npm run build` (R = release name, e.g. web-<topic>-<date>-<commit>):
#   D=.local/release/$R && mkdir -p $D && cp -r dist $D/ &&
#   (cd $D && find dist -type f | sort | xargs sha256sum -b > files.sha256) &&
#   tar -czf .local/release/$R.tar.gz -C $D dist files.sha256 && sha256sum .local/release/$R.tar.gz
# Upload $R.tar.gz to <root>/releases/ and this script anywhere on the server, then run as root:
#   sh web-deploy.sh <release name> <archive sha256> [sha256 of the live index.html you expect to replace]
# Restores the previous page if any check fails. Needs the relay build in <root>/app/build/relay.mjs to be
# compatible with the new page; when the relay changed too, deploy the relay package instead (DEPLOY.md).
set -eu
release=${1:?release name}
archive_sha=${2:?archive sha256}
expected_index=${3:-}
root=${CODEX_RELAY_ROOT:-/opt/codex-mobile-relay}
service=${CODEX_RELAY_SERVICE:-codex-mobile-relay.service}
port=${CODEX_RELAY_PORT:-3340}
app="$root/app"
stage="$root/releases/$release-stage"
backup="$root/releases/$release-before"
archive="$root/releases/$release.tar.gz"
exec 9>"$root/releases/.web-deploy.lock"
flock -n 9
test "$(sha256sum "$archive" | cut -d ' ' -f 1)" = "$archive_sha" || { echo 'Archive checksum differs; nothing changed.' >&2; exit 1; }
test "$(readlink -f "$app/dist")" = "$app/dist"
if [ -n "$expected_index" ]; then
  test "$(sha256sum "$app/dist/index.html" | cut -d ' ' -f 1)" = "$expected_index" || { echo 'Live web build differs from the expected previous release; nothing changed.' >&2; exit 1; }
fi
relay_before=$(sha256sum "$app/build/relay.mjs" | cut -d ' ' -f 1)
pid_before=$(systemctl show "$service" -p MainPID --value)
systemctl is-active --quiet "$service"
test ! -e "$stage"
test ! -e "$backup"
mkdir "$stage" "$backup"
tar -xzf "$archive" -C "$stage"
(cd "$stage" && sha256sum --status -c files.sha256)
cp "$app/dist/index.html" "$app/dist/sw.js" "$app/dist/icon.svg" "$app/dist/manifest.webmanifest" "$backup/"
# Previous assets stay for pages still open on the old version; an asset with the same name must be identical.
for asset in "$stage"/dist/assets/*; do
  target="$app/dist/assets/${asset##*/}"
  if [ -e "$target" ]; then cmp -s "$asset" "$target"; else install -m 644 "$asset" "$target"; fi
done
switched=0
rollback() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ] && [ "$switched" -eq 1 ]; then
    echo 'Deployment failed; restoring the previous web page.' >&2
    for name in sw.js icon.svg manifest.webmanifest; do cp "$backup/$name" "$app/dist/$name"; done
    cp "$backup/index.html" "$app/dist/index.html.rollback" && mv "$app/dist/index.html.rollback" "$app/dist/index.html"
  fi
  exit "$code"
}
trap rollback EXIT
install -m 644 "$stage/dist/index.html" "$app/dist/index.html.next"
switched=1
if [ -d "$stage/dist/pdfjs" ]; then mkdir -p "$app/dist/pdfjs" && cp -a "$stage/dist/pdfjs/." "$app/dist/pdfjs/"; fi
for name in sw.js icon.svg manifest.webmanifest; do install -m 644 "$stage/dist/$name" "$app/dist/$name"; done
mv "$app/dist/index.html.next" "$app/dist/index.html"
(cd "$app" && sha256sum --status -c "$stage/files.sha256")
same() { test "$(curl --fail --silent --show-error --max-time 4 "http://127.0.0.1:$port/$1" | sha256sum | cut -d ' ' -f 1)" = "$(sha256sum "$2" | cut -d ' ' -f 1)"; }
test "$(curl --fail --silent --max-time 2 "http://127.0.0.1:$port/health")" = '{"ok":true}'
same '' "$stage/dist/index.html"
same sw.js "$stage/dist/sw.js"
for asset in "$stage"/dist/assets/*; do same "assets/${asset##*/}" "$asset"; done
test "$(sha256sum "$app/build/relay.mjs" | cut -d ' ' -f 1)" = "$relay_before"
systemctl is-active --quiet "$service"
test "$(systemctl show "$service" -p MainPID --value)" = "$pid_before"
printf 'Deployed %s; relay PID %s unchanged\n' "$release" "$pid_before"
