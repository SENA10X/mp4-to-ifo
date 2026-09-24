#!/usr/bin/env bash
# Build the Mac app for distribution: checks → build → audit → sign (inside out, hardened runtime) → verify →
# notarize and staple the app → DMG → sign, notarize and staple the DMG → verify the DMG → checksums.
# Apple Silicon, macOS 14+. See docs/release.md.
#
#   npm run release:mac                       (from the repository root)
#
# Needs, outside the repository (nothing secret is read or written by this script):
#   - a "Developer ID Application" certificate and its private key in the login keychain
#   - a notarytool keychain profile, created once with `xcrun notarytool store-credentials <profile> ...`
# Environment:
#   MP4_TO_IFO_SIGNING_IDENTITY  Developer ID Application identity (SHA-1 or name). Default: the only one in
#                                the keychain; none or several is an error.
#   MP4_TO_IFO_NOTARY_PROFILE    notarytool keychain profile (default: mp4-to-ifo-notary)
#   MP4_TO_IFO_TEST_BUILD=1      test build: ad-hoc signature, no notarization; everything else is the same.
#                                The result says "not for distribution" and fails release verification.
# Output: apps/desktop/build/release/
#   MP4-to-IFO-<version>-arm64.dmg, release.json, SHA256SUMS, notary-*.json,
#   MP4-to-IFO-<version>-third-party-sources.tar.gz (corresponding source of the bundled toolchain)
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$DESKTOP/../.." && pwd)"
OUT="$DESKTOP/build/release"
WORK="$DESKTOP/build/release-work"
BUILT_APP="$DESKTOP/src-tauri/target/release/bundle/macos/MP4 to IFO.app"
BUNDLE_ID=io.github.sena10x.mp4-to-ifo
VERSION="$(node -p "require('$DESKTOP/package.json').version")"
DMG_NAME="MP4-to-IFO-$VERSION-arm64.dmg"
TEST_BUILD="${MP4_TO_IFO_TEST_BUILD:-0}"
PROFILE="${MP4_TO_IFO_NOTARY_PROFILE:-mp4-to-ifo-notary}"
export PATH="$HOME/.cargo/bin:$PATH"

step() { printf '\n== %s\n' "$*"; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }

# --- preconditions ---------------------------------------------------------------------------------------
[ "$(uname -m)" = arm64 ] || die "build on Apple Silicon"
if [ "$TEST_BUILD" = 1 ]; then
  IDENTITY=-
  TIMESTAMP=--timestamp=none
  echo "TEST BUILD: ad-hoc signature, not notarized, not for distribution"
else
  if [ -n "${MP4_TO_IFO_SIGNING_IDENTITY:-}" ]; then
    IDENTITY="$MP4_TO_IFO_SIGNING_IDENTITY"
  else
    ids="$(security find-identity -v -p codesigning | sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) "Developer ID Application: .*"$/\1/p')"
    [ -n "$ids" ] || die "no Developer ID Application identity in the keychain (docs/release.md: Credentials)"
    [ "$(echo "$ids" | wc -l | tr -d ' ')" = 1 ] || die "several Developer ID Application identities; set MP4_TO_IFO_SIGNING_IDENTITY"
    IDENTITY="$ids"
  fi
  security find-identity -v -p codesigning | grep -F "$IDENTITY" | grep -q '"Developer ID Application: ' ||
    die "MP4_TO_IFO_SIGNING_IDENTITY is not a valid Developer ID Application identity"
  TIMESTAMP=--timestamp
  xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 ||
    die "notarytool keychain profile '$PROFILE' not usable (docs/release.md: Credentials)"
  [ -z "$(git -C "$REPO" status --porcelain)" ] || die "the working tree has uncommitted changes; release from a commit"
fi
# The app is signed here, never by `tauri build`.
unset APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID \
  APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# --- clean ------------------------------------------------------------------------------------------------
step clean
rm -rf "$OUT" "$WORK" "$DESKTOP/src-tauri/target/release/bundle" "$DESKTOP/src-tauri/engine" "$DESKTOP/dist"
mkdir -p "$OUT" "$WORK"

# --- checks (the engine first: the desktop engine tests run it with the bundled toolchain) -------------------
step "tests, typecheck, build"
[ -x "$DESKTOP/src-tauri/binaries/node-aarch64-apple-darwin" ] || die "bundled toolchain missing (npm run build:toolchain -w @mp4-to-ifo/desktop)"
(cd "$DESKTOP" && npm run build:engine)
(cd "$REPO" && npm test && npm run typecheck && npm run build)
(cd "$DESKTOP/src-tauri" && cargo test --locked --release)
node "$DESKTOP/scripts/license-inventory.mjs" --check

# --- build ------------------------------------------------------------------------------------------------
step "build the app"
(cd "$DESKTOP" && RUSTFLAGS="--remap-path-prefix=$HOME=~" npx tauri build --bundles app --ci)
node "$DESKTOP/scripts/check-bundle.mjs" --app "$BUILT_APP" --level build

# --- sign, inside out --------------------------------------------------------------------------------------
step "sign"
APP="$WORK/MP4 to IFO.app"
ditto "$BUILT_APP" "$APP"
sign() { # file identifier [entitlements]
  local extra=()
  [ -n "${3:-}" ] && extra=(--entitlements "$3")
  codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP" --identifier "$2" ${extra[@]+"${extra[@]}"} "$1"
}
for tool in ffmpeg ffprobe dvdauthor; do sign "$APP/Contents/MacOS/$tool" "$BUNDLE_ID.$tool"; done
# node comes signed by the Node.js Foundation with development entitlements (get-task-allow and others):
# drop that signature and sign it with only what it needs.
codesign --remove-signature "$APP/Contents/MacOS/node"
sign "$APP/Contents/MacOS/node" "$BUNDLE_ID.node" "$DESKTOP/src-tauri/node.entitlements.plist"
# The bundle last: this signs the main executable and seals Resources. No entitlements.
sign "$APP" "$BUNDLE_ID"
node "$DESKTOP/scripts/check-bundle.mjs" --app "$APP" --level signed

notarize() { # file label
  local result="$OUT/notary-$2.json"
  xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait --output-format json >"$result" || true
  local id status
  id="$(node -p "JSON.parse(require('fs').readFileSync('$result','utf8')).id ?? ''" 2>/dev/null || true)"
  status="$(node -p "JSON.parse(require('fs').readFileSync('$result','utf8')).status ?? ''" 2>/dev/null || true)"
  echo "notarization $2: submission $id, $status"
  [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" "$OUT/notary-$2-log.json" >/dev/null 2>&1 || true
  [ "$status" = Accepted ] || die "notarization of $2 was not accepted; see $OUT/notary-$2-log.json"
}

if [ "$TEST_BUILD" != 1 ]; then
  step "notarize the app"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$WORK/app.zip"
  notarize "$WORK/app.zip" app
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  node "$DESKTOP/scripts/check-bundle.mjs" --app "$APP" --level release
fi

# --- DMG ----------------------------------------------------------------------------------------------------
step "DMG"
DMG="$OUT/$DMG_NAME"
mkdir -p "$WORK/dmg"
ditto "$APP" "$WORK/dmg/MP4 to IFO.app"
ln -s /Applications "$WORK/dmg/Applications"
hdiutil create -volname "MP4 to IFO" -srcfolder "$WORK/dmg" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG" >/dev/null
codesign --force --sign "$IDENTITY" "$TIMESTAMP" --identifier "$BUNDLE_ID.dmg" "$DMG"
if [ "$TEST_BUILD" != 1 ]; then
  step "notarize the DMG"
  notarize "$DMG" dmg
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
fi

# --- corresponding source of the bundled toolchain ------------------------------------------------------------
step "third-party sources"
SRC="$WORK/MP4-to-IFO-$VERSION-third-party-sources"
mkdir -p "$SRC/tarballs"
node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path");
  const [repo, from, to] = process.argv.slice(1);
  for (const c of JSON.parse(fs.readFileSync(path.join(repo, "third-party/sources.json"), "utf8")).components) {
    if (!c.sourceSha256) continue; // Node.js: official binary; its source is at sourceUrl
    const file = path.join(from, path.basename(new URL(c.sourceUrl).pathname).replace(/^release-/, `${c.component}-`));
    const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (sha !== c.sourceSha256) throw new Error(`${file}: checksum does not match sources.json`);
    fs.copyFileSync(file, path.join(to, path.basename(file)));
  }' "$REPO" "$DESKTOP/build/toolchain/src" "$SRC/tarballs"
cp "$DESKTOP/scripts/build-toolchain.sh" "$SRC/"
cp -R "$REPO/third-party/licenses" "$SRC/licenses"
cp "$REPO/third-party/sources.json" "$REPO/third-party/build-info/toolchain.txt" "$SRC/"
cp "$REPO/third-party/README.md" "$SRC/THIRD-PARTY.md"
cat >"$SRC/README.txt" <<EOF
Corresponding source for the third-party programs in MP4 to IFO $VERSION for macOS (Apple Silicon).

tarballs/            the exact upstream sources, unmodified (SHA-256 in sources.json)
build-toolchain.sh   the script that built the shipped ffmpeg, ffprobe (with zimg) and dvdauthor
toolchain.txt        configure options, linked libraries and checksums of that build
sources.json         the same, machine-readable
licenses/            license texts

Node.js $(node -p "require('$REPO/third-party/sources.json').components.find(c=>c.component==='Node.js').version") is the official binary from nodejs.org (source: https://nodejs.org/dist/).
The release signs the executables; signing does not change their code or licenses.
To use your own build, run build-toolchain.sh (Xcode command line tools needed), replace the executable in
"MP4 to IFO.app/Contents/MacOS/", and re-sign the app for your Mac (codesign --force --deep --sign - ...).
EOF
SOURCES="MP4-to-IFO-$VERSION-third-party-sources.tar.gz"
tar -C "$WORK" -czf "$OUT/$SOURCES" "$(basename "$SRC")"

# --- metadata, checksums, final verification ------------------------------------------------------------------
step "metadata"
(cd "$OUT" && shasum -a 256 "$DMG_NAME" "$SOURCES" >SHA256SUMS)
node - "$OUT" "$DMG_NAME" "$SOURCES" "$TEST_BUILD" "$REPO" <<'NODE'
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync, spawnSync } = require('child_process');
const [out, dmg, sources, test, repo] = process.argv.slice(2);
const file = path.join(out, dmg);
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const notary = (label) => { const r = read(path.join(out, `notary-${label}.json`)); return r && { submissionId: r.id, status: r.status }; };
const app = notary('app'), image = notary('dmg');
const sign = spawnSync('codesign', ['-dvv', file], { encoding: 'utf8' }).stderr;
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const meta = {
  product: 'MP4 to IFO',
  version: JSON.parse(fs.readFileSync(path.join(repo, 'apps/desktop/package.json'), 'utf8')).version,
  bundleIdentifier: 'io.github.sena10x.mp4-to-ifo',
  architecture: 'arm64',
  minimumMacOS: '14.0',
  file: dmg,
  size: fs.statSync(file).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  testBuild: test === '1',
  distribution: test === '1' ? 'not for distribution (test build: ad-hoc signature, not notarized)' : 'Developer ID signed, notarized and stapled',
  signing: test === '1' ? { type: 'ad-hoc' } : { type: 'Developer ID Application', teamId: sign.match(/^TeamIdentifier=(.+)$/m)?.[1] },
  notarization: test === '1' ? { status: 'not submitted' } : { status: app?.status === 'Accepted' && image?.status === 'Accepted' ? 'Accepted' : 'Rejected', app, dmg: image, stapled: true },
  source: { commit: git('rev-parse', 'HEAD'), clean: git('status', '--porcelain') === '' },
  thirdPartySources: { file: sources, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(out, sources))).digest('hex') },
  components: JSON.parse(fs.readFileSync(path.join(repo, 'third-party/sources.json'), 'utf8')).components.map((c) => ({ component: c.component, version: c.version, license: c.license })),
  built: new Date().toISOString(),
};
fs.writeFileSync(path.join(out, 'release.json'), `${JSON.stringify(meta, null, 2)}\n`);
NODE
step "verify the DMG"
node "$DESKTOP/scripts/check-bundle.mjs" --dmg "$DMG" --metadata "$OUT/release.json" --level "$([ "$TEST_BUILD" = 1 ] && echo signed || echo release)"
rm -rf "$WORK"
echo
cat "$OUT/SHA256SUMS"
echo "release ready in ${OUT#"$REPO/"}$([ "$TEST_BUILD" = 1 ] && echo ' (TEST BUILD, not for distribution)')"
