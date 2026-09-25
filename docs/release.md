# MP4 to IFO — Phase 6 macOS Release Engineering

Mac アプリ（Apple Silicon、macOS 14 Sonoma 以降）を、第三者に配布できる署名・公証済みの DMG にする手順と、その確認。
変換ロジック（Core）は Phase 6 で変更していない。

**Not physically verified.** 検証はソフトウェアによるもので、DVD プレーヤーでの再生互換性は主張しない。

---

## 1. Pipeline

```text
npm run release:mac（apps/desktop/scripts/release-mac.sh）
  clean
  → engine build → npm test / typecheck / build → cargo test → license inventory --check
  → tauri build --bundles app（署名しない）→ check-bundle --level build
  → 内側から署名（ffmpeg, ffprobe, dvdauthor → node → app）、Hardened Runtime、secure timestamp
  → check-bundle --level signed
  → app を公証（notarytool）→ staple → check-bundle --level release
  → DMG（app + Applications へのリンク）→ DMG に署名 → DMG を公証 → staple
  → third-party sources archive → SHA256SUMS / release.json
  → check-bundle --dmg --metadata（最終成果物の検証）
```

出力は `apps/desktop/build/release/`（git に入れない）:

| File | |
| --- | --- |
| `MP4-to-IFO-<version>-arm64.dmg` | 配布物 |
| `release.json` | Release metadata（§8） |
| `SHA256SUMS` | DMG と sources archive の SHA-256 |
| `MP4-to-IFO-<version>-third-party-sources.tar.gz` | 同梱ツールの対応ソース（§9） |
| `notary-app.json` / `notary-dmg.json` / `*-log.json` | 公証の submission ID・結果・ログ |

- 失敗したら止まる（テスト、監査、署名、公証の不受理、staple、最終検証のどれでも）。公証が不受理なら Notary log を保存して止まる。
- `MP4_TO_IFO_TEST_BUILD=1`: ad-hoc 署名・公証なしで同じ手順を通す（パイプラインとアプリの確認用）。`release.json` は `testBuild: true`、「not for distribution」。`--level release` の検証は通らない。
- `MP4_TO_IFO_SIGN_ONLY=1`: 署名とその検査のあとで止め、署名済み（公証前）の app を `apps/desktop/build/release-work/` に残す。公証の前に §6-1 の確認をするため。
- 配布用（test build でない）は、作業ツリーに未コミットの変更があると始めない。`release.json` に commit を記録する。
- 再検証: `npm run verify:release`（`check-bundle.mjs --level release --dmg … --metadata …`）。

## 2. Credentials

リポジトリにも script にも置かない。script は keychain の identity と notarytool の keychain profile を名前で使うだけで、秘密を読んだり表示したりしない。

1. Developer ID Application 証明書（Apple Developer の Account Holder が作成）と秘密鍵を login keychain に入れる。
2. 公証の認証情報を keychain profile に保存する（どちらか一方）:

   ```bash
   # App Store Connect API key（推奨）。.p8 はリポジトリの外に置き、保存後は削除してよい
   xcrun notarytool store-credentials mp4-to-ifo-notary --key <AuthKey_XXXX.p8> --key-id <KEY_ID> --issuer <ISSUER_ID>
   # または Apple ID + app 用パスワード（パスワードは対話入力）
   xcrun notarytool store-credentials mp4-to-ifo-notary --apple-id <Apple ID> --team-id <TEAM_ID>
   ```

3. identity が 1 つなら自動で選ぶ。複数なら `MP4_TO_IFO_SIGNING_IDENTITY`（SHA-1 または名前）。profile 名は `MP4_TO_IFO_NOTARY_PROFILE`（既定 `mp4-to-ifo-notary`）。

- `.gitignore` は `*.p12`、`*.p8`、`*.pem`、`*.key`、`*.cer`、`.env*` などを除外済み。
- 公証は `notarytool`（`altool` は使わない）。ログ（`notary-*-log.json`）に認証情報は含まれない。
- `tauri build` の署名・公証用の環境変数（`APPLE_*`、`TAURI_SIGNING_*`）は script の中で消す（`tauri build` に署名させない）。

## 3. Mach-O inventory

実際の .app から列挙（`check-bundle.mjs` が Mach-O の magic で全ファイルを走査し、この 5 つ以外があれば失敗）。dylib、framework、helper は含まない。

| File | 由来 | Arch | minos | リンク先 | Size |
| --- | --- | --- | --- | --- | --- |
| `Contents/MacOS/mp4-to-ifo-desktop` | Tauri（Rust） | arm64 | 14.0 | system のみ | 6.2 MB |
| `Contents/MacOS/node` | Node.js 22.23.2 公式 | arm64 | 11.0（upstream） | system のみ | 112.3 MB |
| `Contents/MacOS/ffmpeg` | FFmpeg 7.1 LGPL + zimg | arm64 | 14.0 | system のみ | 21.1 MB |
| `Contents/MacOS/ffprobe` | 同上 | arm64 | 14.0 | system のみ | 21.0 MB |
| `Contents/MacOS/dvdauthor` | dvdauthor 0.7.2 | arm64 | 14.0 | system のみ | 0.2 MB |

- すべて arm64 のみ（Universal にしない。Intel は v1 の対象外）。
- 最小 macOS: `tauri.conf.json`（`minimumSystemVersion: 14.0`）→ `Info.plist`（`LSMinimumSystemVersion 14.0`）、ツールは `MACOSX_DEPLOYMENT_TARGET=14.0` でビルド、README / docs は macOS 14 以降。node の 11.0 は公式バイナリの値（14 以上で動く）。

## 4. Signing

内側から、1 つずつ署名する（`codesign --deep` で署名しない。`--deep` は検証にだけ使う）。

```text
codesign --force --sign <Developer ID> --options runtime --timestamp --identifier io.github.sena10x.mp4-to-ifo.<tool> Contents/MacOS/<tool>    ffmpeg, ffprobe, dvdauthor
codesign --remove-signature Contents/MacOS/node
codesign --force --sign <Developer ID> --options runtime --timestamp --identifier io.github.sena10x.mp4-to-ifo.node --entitlements src-tauri/node.entitlements.plist Contents/MacOS/node
codesign --force --sign <Developer ID> --options runtime --timestamp --identifier io.github.sena10x.mp4-to-ifo "MP4 to IFO.app"
```

- Hardened Runtime はすべての実行ファイルとアプリ。secure timestamp はすべて。
- node は Node.js Foundation の Developer ID で署名されて届き、`get-task-allow`、`disable-library-validation`、`allow-dyld-environment-variables`、`disable-executable-page-protection`、`allow-unsigned-executable-memory`、`allow-jit` を持つ。この署名を外し、`allow-jit` だけで署名し直す。
- App Sandbox は使わない（同梱の実行ファイルを子プロセスとして起動し、ユーザーが選んだ場所に書き込むため。Mac App Store は対象外）。
- 検証（`check-bundle.mjs --level signed / release`）: `codesign --verify --deep --strict`、各実行ファイルの Hardened Runtime・identifier・entitlements・`get-task-allow` がないこと、Developer ID Application（Developer ID CA → Apple Root CA）、secure timestamp、全体で同じ Team ID、Developer ID の designated requirement、staple、Gatekeeper。

## 5. Entitlements

| Target | Entitlement | Reason | How verified |
| --- | --- | --- | --- |
| `node` | `com.apple.security.cs.allow-jit` | V8 の JIT（MAP_JIT）。ないと Hardened Runtime の下で node が起動直後に止まる | §5.1 の実測。署名後の .app での変換（§6） |
| `mp4-to-ifo-desktop`（app） | なし | WebView の JavaScript は WebKit の別プロセスで動く | 署名後の .app の起動・全画面の操作（§6） |
| `ffmpeg` / `ffprobe` / `dvdauthor` | なし | JIT なし、system ライブラリのみ | 署名後の .app での変換（§6） |

どの実行ファイルにも `com.apple.security.get-task-allow` はない（`check-bundle.mjs` が全実行ファイルを確認し、あれば失敗）。`disable-library-validation`（system 以外のライブラリを読み込まない）、`allow-dyld-environment-variables`、`allow-unsigned-executable-memory` も付けない。

### 5.1 Node の実測（Hardened Runtime）

公式 node の署名を外し、Hardened Runtime（`--options runtime`）で entitlements だけを変えて署名し直し、同梱の engine と同じ条件（空の環境、同梱ツールのみ）で動かした。ffmpeg / ffprobe / dvdauthor は Hardened Runtime・entitlements なし。

| node の entitlements | JS（ループ 5×10⁷ 回） | 実変換（fps-59.94、59.94i） |
| --- | --- | --- |
| なし | 止まる（CPU 100% のまま 20 秒で打ち切り） | — |
| なし + `node --jitless` | 動く（JIT が原因であることの確認） | — |
| `allow-unsigned-executable-memory` のみ | 動く | 採用しない（`allow-jit` より広い: 署名のない実行可能メモリを全面的に許す） |
| **`allow-jit` のみ** | **動く** | **Complete、48 checks、10 フェーズすべて、Cancel も正常（exit 4、出力なし、子プロセスなし）** |
| `allow-jit` + `allow-unsigned-executable-memory` | 動く | 不要（`allow-jit` だけで足りる） |

実測は ad-hoc 署名 + Hardened Runtime で行った（Hardened Runtime の制約は署名者によらずカーネルが課す）。Developer ID での署名後にも同じ確認をする（§6）。

## 6. 確認（Signed app / Installed app）

Phase 6 の実施結果は §13。

1. **Signed .app（公証前）**: 署名済みの .app を LaunchServices（`open`、Finder のダブルクリックと同じ経路）で起動し、System Events（アクセシビリティ API）で操作: MP4 を選択 → Plan → 出力フォルダの変更 → 変換 → 検証 → Complete → 出力フォルダを開く（Finder の前面ウィンドウがその出力フォルダであること）。
2. **Final DMG → /Applications**: DMG に quarantine（ダウンロードと同じ `com.apple.quarantine`）を付けてマウント → アプリを /Applications へコピー（quarantine が引き継がれる）→ 取り出し → /Applications から起動 → Gatekeeper → 変換 → 検証 → Complete → 出力フォルダを開く。
3. 変換中に: 実行中のプロセスが `.app/Contents/MacOS/` の node / ffmpeg / dvdauthor だけ（Homebrew なし）、`caffeinate -i` のアサーションあり。終了後に何も残らない。
4. Process lifecycle: 正常終了、キャンセル、変換中の Cmd+Q →「キャンセルして終了」。
5. 通知: ウィンドウが前面にないとき完了・失敗を通知（音なし）。
6. ネットワークなし: ネットワークを拒否した sandbox（`sandbox-exec`、IP の送受信と DNS を拒否）の中でアプリ（とその子プロセス）を動かし、変換が完了すること。Updater はないので影響しない。

Gatekeeper を無効にする操作（`spctl --master-disable`、`xattr -dr com.apple.quarantine`）は確認にも案内にも使わない。

## 7. DMG

- `hdiutil create -fs HFS+ -format UDZO`。中身は `MP4 to IFO.app` と `/Applications` へのシンボリックリンクだけ（背景画像などなし）。
- app を公証・staple してから DMG に入れる（DMG から取り出した app がオフラインでも ticket を持つ）。DMG 自体も Developer ID で署名し、公証・staple する。
- `check-bundle.mjs --dmg` が読み取り専用でマウントし、中身、DMG の署名・staple・Gatekeeper（`spctl -t open --context context:primary-signature`）、中の app のすべての検査を行う。

## 8. Release metadata

`release.json`: product、version、bundleIdentifier、architecture（arm64）、minimumMacOS（14.0）、file、size、sha256、testBuild、distribution、signing（種類と Team ID）、notarization（app と DMG の submission ID と結果、stapled）、source（commit、clean）、thirdPartySources（archive と SHA-256）、components（同梱ツールの版とライセンス）、built。

Version は `check-bundle.mjs` が core / cli / desktop の package.json、Cargo.toml、Info.plist、同梱の core、DMG のファイル名、release.json で一致を確認する（現在 0.1.0）。

## 9. Third-party compliance

| | Version | License | 配布物での扱い |
| --- | --- | --- | --- |
| FFmpeg（ffmpeg, ffprobe） | 7.1 | LGPL-2.1-or-later | 別の実行ファイル。`--enable-gpl` / `--enable-nonfree` なし（`check-bundle` が `-version` と `-L` で確認） |
| zimg | 3.0.5 | WTFPL | ffmpeg / ffprobe に静的リンク |
| dvdauthor | 0.7.2 | GPL-2.0-or-later | 別の実行ファイル |
| Node.js | 22.23.2 | MIT ほか（LICENSE） | 公式バイナリ（再署名のみ） |
| npm 8 packages / Rust 220 crates | | MIT / Apache-2.0 ほか、MPL-2.0 が 4 | UI と app バイナリの中 |

- 改変: なし。ビルドに使った FFmpeg（8540 files）、zimg（267）、dvdauthor（76）のソースツリーを配布元の tarball と比較し、すべて一致（ビルドで生成されたファイルだけが増えている）。
- 対応ソース: `release-mac.sh` が `MP4-to-IFO-<version>-third-party-sources.tar.gz` を作る。FFmpeg / zimg / dvdauthor の tarball（`sources.json` の SHA-256 を確認してから入れる）、`build-toolchain.sh`、`toolchain.txt`、`sources.json`、ライセンス文。バイナリとソースの版は `sources.json` で一致（ツールのバイナリの SHA-256 も記録。署名前の値で、`check-bundle --level build` が .app の中身と照合する）。
- LGPL（FFmpeg）: ライセンス文と FFmpeg の LICENSE.md を同梱、ソース・configure・ビルドスクリプトを DMG と一緒に公開、MIT のコードは FFmpeg にリンクしない（別プロセス）。利用者は `build-toolchain.sh` で作り直した ffmpeg / ffprobe に置き換えられる（置き換えたアプリは各自の Mac で ad-hoc 署名し直す。公証済みの署名は出荷したファイルだけを覆う）。
- GPL（dvdauthor）: 対応ソースをバイナリと同時に公開する（書面による申し出ではなく同梱公開）。
- `third-party/sources.json`（machine-readable、ツールごとの version / license / source URL / source SHA-256 / binary SHA-256 / modifications / build）は `build-toolchain.sh` が作る。`third-party/inventory.json` と `licenses/Rust-crates-and-npm-packages.txt` は `license-inventory.mjs` が lockfile から作る（npm は desktop の production 依存、Rust は app バイナリの normal 依存で proc-macro・build 依存を除く）。
- Open Source Licenses 画面は同梱の `licenses/` の全ファイルを表示する。`check-bundle` が `licenses/` = sources.json の licenseFiles + npm/Rust notices + THIRD-PARTY.md + アプリの MIT であること、各ファイルがリポジトリと同じであることを確認する。
- アプリ自身のコードは MIT（`LICENSE`）。README、THIRD-PARTY.md、notices の冒頭で、同梱の第三者コンポーネントには MIT が及ばないことを明記。

### Release に載せるもの（将来の GitHub Release）

```text
MP4-to-IFO-<version>-arm64.dmg                         署名・公証・staple 済み
MP4-to-IFO-<version>-third-party-sources.tar.gz        FFmpeg / zimg / dvdauthor の対応ソース、ビルドスクリプト、ビルド情報
SHA256SUMS                                             上 2 つの SHA-256
Source code (zip / tar.gz)                             GitHub が tag から自動で付ける（アプリの MIT のソース）
```

リリースノートには最小要件（Apple Silicon、macOS 14 以降）、Not physically verified、SHA-256 を書く。「すべての DVD プレーヤーで再生できる」「互換性を保証」「実機で確認済み」とは書かない。

## 10. Privacy

`check-bundle.mjs` が .app（と DMG の中）の全ファイルを走査する: このマシンのホームのパス、ユーザー名、`/var/folders/` と `$TMPDIR`、git のメールアドレス、秘密鍵（PEM）、App Store Connect の鍵ファイル名。検索語は実行時にこのマシンから取り、表示しない。

- それ以外の `/Users/<name>/` も失敗にする。例外は node の中の `/Users/admin/build/ws/…`（Node.js 公式ビルドの CI のパスで、このマシンのものではない。バイナリは改変しない）。
- 署名には Developer ID の証明書（開発者名と Team ID を含む公開情報）が入る。
- Rust は `--remap-path-prefix=$HOME=~`、ffmpeg は `--prefix=/usr/local` でビルドし、ビルドした Mac のパスを入れない。
- 同梱しないもの（`check-bundle` は許可リスト外のファイルを失敗にする）: tests、fixtures、サンプル動画、source map、`.d.ts`、ログ、レビュー出力、鍵・証明書。

## 11. Updater（準備のみ）

Phase 6 では入れない。偽の endpoint・公開鍵は置かない。Settings の「アップデートを確認」は「このビルドでは利用できません」と表示する（`config.updatesEnabled: false`）。

Tauri 2 の方式（`tauri-plugin-updater` / `@tauri-apps/plugin-updater`）:

| 要るもの | 内容 | 置き場所 |
| --- | --- | --- |
| 署名鍵ペア | `npx tauri signer generate -w <path>`（minisign、パスワード付き） | 秘密鍵はリポジトリの外（パスワードマネージャ / keychain）。ビルド時に `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| 公開鍵 | 上で生成した `.pub` の中身 | `tauri.conf.json` の `plugins.updater.pubkey` |
| endpoint | 例: `https://github.com/SENA10X/mp4-to-ifo/releases/latest/download/latest.json` | `plugins.updater.endpoints` |
| artifact と署名 | `MP4 to IFO.app.tar.gz` と `.sig`。公証・staple 済みの app から作り、`npx tauri signer sign` で署名する（この release script は app を自前で署名するので、`bundle.createUpdaterArtifacts` ではなく公証後に作る） | GitHub Release の asset、`latest.json` に `darwin-aarch64` の url と signature |
| 権限 | capability に `updater:default`（と再起動に `process:allow-restart`） | `capabilities/default.json` |

流れ: 起動 → バックグラウンドで `check()` → 更新があれば UI で知らせる → ユーザーが「インストール」を選んだときだけ `downloadAndInstall()` → 再起動。黙っての強制更新はしない。変換中は更新しない。

## 12. CI

| | 何を | どこで |
| --- | --- | --- |
| **Standard CI**（`.github/workflows/ci.yml`） | unit / integration / CLI / desktop UI / engine のテスト（同梱の LGPL ツールだけ、スキップがあれば失敗）、Rust テスト、typecheck、build、license inventory | GitHub Actions（macos-15、Apple Silicon）。認証情報なし |
| **Heavy Media Regression** | 17 サンプル（`samples/`、約 11 GB、git にない）の regression: `npm run test:regression` | ローカル / 専用マシンで手動。Release Candidate ごとに 1 回。`samples/` がなければ失敗（スキップを成功と見せない） |
| **Release** | `npm run release:mac` | ローカル（Developer ID と公証の認証情報がある Mac）。CI に secret は置かない |

Standard CI が緑でも、17 サンプルの regression が通ったことにはならない（workflow 名と冒頭のコメントに明記）。

## 13. Phase 6 の結果

### 13.1 Developer ID release（2026-09-25、commit `c4eb286`）

**Status: PASS**（通知は未確認。§6-5 は自動で確認できなかった）。

| 項目 | 結果 |
| --- | --- |
| Artifact | `MP4-to-IFO-0.1.0-arm64.dmg`、60,102,647 bytes、SHA-256 `5fea8d915467118791796ee91d1ddf01f57c6232736d4cf777c3eced77a36034` |
| Sources | `MP4-to-IFO-0.1.0-third-party-sources.tar.gz`、SHA-256 `ade95e595271009a767311ebd90ab68a68dd6c0a0c667cb8efbfce895a8fdba6` |
| Signing | 5 つの Mach-O とアプリ: Developer ID Application（Team 56DKFD4G33）、Hardened Runtime、secure timestamp、Developer ID の designated requirement。entitlements は node の `allow-jit` だけ、`get-task-allow` なし |
| Signed .app（公証前、`MP4_TO_IFO_SIGN_ONLY=1`） | LaunchServices で起動 → MP4 を選択 → Plan → 出力フォルダを変更 → 変換 → 検証合格 → 出力フォルダを開く。Gatekeeper は `Unnotarized Developer ID`（公証前として想定どおり） |
| 公証 app | submission `4bff9965-477d-4dbf-98ad-dd731dc58fa2`: Accepted（約 75 分、この Team で初回）。log の issues なし、ticket は app と 5 つの Mach-O（arm64） |
| 公証 DMG | submission `fc604ccc-1269-4185-a2dc-f86754fd480b`: Accepted。log の issues なし |
| Staple | app と DMG、`stapler validate` 成功 |
| 最終検証 | `check-bundle --level release --dmg --metadata` と `npm run verify:release`: すべて ok |
| Gatekeeper | DMG（`-t open`）と app（`-t exec`）: accepted、`source=Notarized Developer ID` |
| Quarantine | DMG に Safari と同じ quarantine → マウント → /Applications にコピー（quarantine 引き継ぎ）→ 取り出し → 起動: 「インターネットからダウンロードされたアプリケーションです…Appleによるチェックで悪質なソフトウェアは検出されませんでした」→「開く」→ 起動（quarantine は承認済み `02c3` に） |
| Installed app | 変換 → 検証合格 → 出力フォルダを開く、開けないときの表示、キャンセル、変換中の Cmd+Q →「キャンセルして終了」（子プロセス・caffeinate・出力・作業フォルダなし）、Settings、Open Source Licenses（8 ファイル = 同梱） |
| Toolchain / Sleep | 変換中のアプリの子孫は同梱の node、ffmpeg（ffprobe、dvdauthor）と `caffeinate -i -w` だけ。終了後にアサーションなし |
| ネットワークなし | IP と DNS を拒否した sandbox で /Applications のアプリを起動し、変換・検証が完了 |
| 17 samples | `npm run test:regression`: 17/17 pass（開発用の LGPL ツールで。Core は Phase 6 で変更なし） |
| 通知 | **未確認。** Developer ID 署名・/Applications のアプリでも、バックグラウンドでの完了後に Notification Center への登録が見られない。画面収録の権限がなく表示も確認できない（署名なしでも同じ。§13.2） |

- /Applications へのコピーは `ditto`（Finder の操作は自動化できない）。そのため macOS の App Translocation（読み取り専用のランダムなパスから起動）がかかったが、変換・検証・出力フォルダ・後片付けはそのまま動いた。Finder でドラッグしてインストールすれば Translocation はかからない。
- Developer ID Application 証明書の有効期限は 2027-02-01（G1 の中間 CA）。公証・timestamp 済みの配布物はその後も有効。以降のリリースには新しい証明書が必要。

### 13.2 Developer ID の前（2026-09-24、TEST BUILD）

Developer ID の証明書がなかった時点の確認（PARTIAL）。ad-hoc 署名を合格の代わりにはしていない。確認できたこと（`MP4_TO_IFO_TEST_BUILD=1 npm run release:mac`、ad-hoc 署名 + Hardened Runtime）:

| 項目 | 結果 |
| --- | --- |
| Pipeline | clean → tests（core / CLI 38 + 133、desktop UI 33、desktop engine 13、Rust 1: 失敗・スキップ 0）→ typecheck → build → license inventory → .app → 監査 → 内側から署名 → 検証 → DMG → sources archive → metadata → DMG の検証、すべて通過 |
| 署名の検査（`--level signed`） | 5 つの Mach-O すべて Hardened Runtime、identifier、entitlements（node は `allow-jit` のみ、ほかはなし）、`get-task-allow` なし、`codesign --verify --deep --strict` |
| `--level release` | ad-hoc の DMG は 21 項目で失敗（Developer ID、timestamp、Team、DR、staple、Gatekeeper、公証）: 検査が正しく落ちることの確認 |
| `syspolicy_check distribution` | 指摘は「ad-hoc 署名」と「公証 ticket なし」の 2 つだけ（entitlements・構成の指摘なし） |
| Quarantine | DMG に Safari と同じ `com.apple.quarantine` を付けてマウント → コピーした app に quarantine が引き継がれる → Gatekeeper は拒否（ad-hoc なので想定どおり） |
| DMG から /Applications（quarantine なし） | LaunchServices で起動 → MP4 を選択 → Plan（59.94i）→ 出力フォルダを変更 → 変換 → 検証合格 → Complete → 出力フォルダを開く（Finder の前面がその出力フォルダ） |
| M-1 | 出力フォルダを移動してから押す →「出力フォルダを開けませんでした。」、戻して押す → 開き、表示は消える |
| Toolchain | 変換中のアプリの子孫は `.app/Contents/MacOS/` の node と ffmpeg、`/usr/bin/caffeinate -i -w <engine>` だけ |
| Sleep | 変換中は caffeinate の PreventUserIdleSystemSleep、終了後はなし |
| Lifecycle | 正常終了、キャンセル（子プロセス・出力・作業フォルダなし）、変換中の Cmd+Q →「キャンセルして終了」（アプリと子プロセスが約 4 秒で終了、出力なし） |
| ネットワークなし | IP と DNS を拒否した sandbox の中でアプリを起動し、変換・検証が完了 |
| Open Source Licenses | 画面の一覧 = 同梱の `licenses/`（8 ファイル） |
| Settings | 「このビルドでは、アップデートの確認は利用できません。」 |
| 通知 | **未確認。** 画面収録の権限がなく、Notification Center の表示を確認できなかった。署名なしの同じビルドでも Notification Center への登録が見られず、署名とは関係のない既存の問題の可能性がある（通知は非推奨の NSUserNotification を使う `mac-notification-sys` 経由）。音は指定していない |
| Size | .app 155 MiB（`du`。node 112.3 MB、ffmpeg 21.1 MB、ffprobe 21.0 MB、app 6.2 MB、dvdauthor 0.2 MB）、DMG 60,095,808 bytes（test build） |

### 13.3 Beta Hardening の確認（2026-09-25）

Phase 6 の DMG は公開に使わない（中の `third-party-sources.tar.gz` が `ab702bc` より前の `build-toolchain.sh` を含むため）。以下は Beta Hardening の変更後のコアと、同梱と同じ ffmpeg / ffprobe / dvdauthor（`src-tauri/binaries`）で CLI を実行した結果。

| 項目 | 結果 |
| --- | --- |
| 通知 | **配信・表示を確認（ログ）、目視は未確認。** /Applications の Phase 6 アプリで変換を始め、Finder を前面にした状態で完了。`usernoted` が `io.github.sena10x.mp4-to-ifo` の通知を受け取り、Delivering → Presenting、NotificationCenter が「Setting visible banner」、おやすみモードの抑制なし、「Not playing sound」（音なし）。コードの変更は不要だった。Phase 6 で見ていた `com.apple.ncprefs` の一覧には、送信後も現れない（登録の有無は表示の可否と関係しなかった）。画面の目視と「失敗」の通知は未確認 |
| 容量上限に近い ISO | 80 分・ノイズの合成素材（854×480、ソース 7.3 GB）: 計画 7,187 kbps、VIDEO_TS 4,545,230,848 B（VOB 5 本: 1,073,709,056 × 4 + 250,284,032）、ISO 4,545,857,536 B（DVD+R SL まで 154,515,456 B）。検証 49/49 合格（`iso.capacity`、macOS の UDF マウントを含む）、長さ 4800.029 s。独立に: `isoinfo`（ISO 9660）、`hdiutil` の読み取り専用マウント（UDF、全ファイルの sha256 一致）、マウントした VOB の長さ 4800.03 s。変換 15 分 27 秒（M1 Mac、検証 108.5 s） |
| 容量超過（故障注入） | 同じ素材で最終エンコードだけ 9,000 kbps にする ffmpeg のラッパー: ISO 5,646,632,960 B → `VERIFY_ERROR`（失敗は `iso.capacity` だけ）、CLI の終了コード 3、出力フォルダと作業フォルダは空 |
| 4 GB を超える ZIP | 上の実出力: 4,545,232,102 B、Zip64 の EOCD（中央ディレクトリの位置が 4 GiB を超える）。`unzip -t`、Python `zipfile`、`ditto -x -k`、Archive Utility で展開し全ファイルの sha256 一致。5 本目の VOB の位置は 4,294,947,263（4 GiB の直前）で、エントリ単位の Zip64 は使われなかったため、同じ VOB に 6 本目を加えた 5,618,941,288 B の ZIP（Core の `writeZip`、6 本目の位置 4,545,231,346）でも確認: Core の `readZip`、`unzip -t`、Python（Zip64 extra 0x0001）、`ditto`、Archive Utility がすべて一致。Windows での展開は未確認 |

### 13.4 Beta Hardening Release Candidate（2026-09-26、commit `a67619b`）

**Status: PASS**。Phase 6 の DMG は使っていない。Beta Hardening の変更（M-4、BH-H1、M-3、M-2、M-5、BH-H2）を含むクリーンな `a67619b` から `npm run release:mac` で作り直した。

| 項目 | 結果 |
| --- | --- |
| Pipeline | clean → tests（CLI 38、core 187、desktop UI 33、engine 13、Rust 1: 失敗・スキップ 0）→ typecheck → build → license inventory → .app → 署名 → 公証 → staple → DMG → 公証 → staple → sources archive → metadata → 最終検証、すべて通過 |
| Signed .app（公証前、`MP4_TO_IFO_SIGN_ONLY=1`） | MP4 を選択 → Plan → 変換 → 検証合格 → 出力フォルダを開く（BH-H2 の素材: 保持フレームのある VFR） |
| 公証 | app `d939518a-b5f9-4e5f-9095-2c3936cf5e92` Accepted、DMG `822d596e-4fd3-41b6-a97f-5cadf5a73079` Accepted、どちらも issues なし。staple と validate 成功 |
| DMG | `MP4-to-IFO-0.1.0-arm64.dmg`、60,109,536 B、SHA-256 `b36b72b236ec155b5d2f76609da620954a89d9e691a83b8bac4c08e5af1cc8fe`。`release.json`（source `a67619b`、clean）と `SHA256SUMS` は新しい成果物から生成 |
| Gatekeeper | DMG と app: accepted、`source=Notarized Developer ID` |
| Quarantine | Safari と同じ quarantine を付けた DMG → マウント → /Applications（`ditto`）→ 起動:「インターネットからダウンロードされたアプリケーションです…Appleによるチェックで悪質なソフトウェアは検出されませんでした」→「開く」 |
| Installed app | 変換と検証合格、出力フォルダを開く（成功・フォルダを移動したときの表示・戻したあと）、キャンセル（確認 → 出力・子プロセス・作業フォルダ・スリープ抑止なし）、変換中の Cmd+Q →「キャンセルして終了」（約 3 秒で終了、何も残らない）、Settings（「このビルドでは、アップデートの確認は利用できません。」）、Open Source Licenses（同梱の 8 ファイル） |
| 通知 | **VERIFIED（ユーザーが画面で確認）。** 別のアプリを前面にして、成功（通常の変換）と失敗（59.94 fps の 1 フレーム: DVD の構造を作れず失敗、出力なし）の両方の通知が表示され、音は鳴らなかった |
| Toolchain | 変換中のアプリの子孫は同梱の node・ffmpeg と `caffeinate -i -w` だけ。cdrtools は同梱されず、使われない |
| Third-party sources | 新しい archive の `build-toolchain.sh`・`sources.json`・`toolchain.txt`・ライセンスは `a67619b` と同一（Phase 6 の古い `build-toolchain.sh` の問題は解消）。tarball の SHA-256 は manifest と一致。現在の `build-toolchain.sh` で toolchain を作り直すと、dvdauthor と node はバイト単位で一致、ffmpeg / ffprobe はリンカが付ける Mach-O の UUID（と、それを含む ad-hoc 署名のページハッシュ）だけが違い、コードとデータは一致 |
| Privacy | 最終検証: 50 ファイルにホームパス・ユーザー名・一時パス・git の e-mail・秘密鍵なし（node の上流のビルドパス `/Users/admin/` だけ）。release.json・SHA256SUMS・公証ログにも個人情報や認証情報なし |
| 証明書 | Developer ID Application の有効期限は 2027-02-01。この成果物は timestamp・公証済みで期限後も有効。以降のリリースには新しい証明書が必要 |

**Not physically verified.** Windows での Zip64 展開と、macOS 14 の実機は未確認。
