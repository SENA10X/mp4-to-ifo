# MP4 to IFO — Phase 5 macOS Desktop App

`apps/desktop`（`@mp4-to-ifo/desktop`、private）。Tauri 2 + React + TypeScript の macOS アプリ。
Apple Silicon、macOS 14 以降のみ。変換は Phase 3 Core がすべて行い、アプリは表示と操作だけを受け持つ。

**Not physically verified.** 完了画面の「検証に合格」はソフトウェア検証の結果で、DVD プレーヤーでの再生互換性は主張しない。

---

## 1. 構成

```text
Desktop UI (React, WebView)
  → Tauri 2 (Rust: src-tauri/src/lib.rs)
    → Desktop Bridge: engine（同梱 node + engine.js、1 操作 1 プロセス、JSON Lines）
      → Production Core（@mp4-to-ifo/core、そのまま同梱）
        → Toolchain（同梱 ffmpeg / ffprobe / dvdauthor）
```

```text
apps/desktop/
├── src/                     UI
│   ├── App.tsx              状態・Bridge・言語をつなぐ
│   ├── flow.ts              画面遷移（純粋な reducer）
│   ├── screens.tsx          各画面（表示のみ）
│   ├── bridge.ts            Bridge インターフェースと Tauri 実装
│   ├── messages.ts          Engine のエラー・警告 → 文言キー
│   ├── config.ts            Burn guide / Report issue の URL（未公開のため null）、Updater の有無
│   ├── i18n/                en.ts / ja.ts / index.ts
│   └── styles.css
├── engine/engine.ts         Core を呼ぶ小さなエントリ（analyze / convert）
├── src-tauri/               Rust、tauri.conf.json、capabilities、entitlements、icons
├── scripts/
│   ├── build-toolchain.sh   同梱ツールのビルド（§2）
│   ├── build-engine.mjs     Core をビルドし、engine.js と Core の dist を src-tauri/engine へ
│   └── check-bundle.mjs     .app の中身の確認（必要なファイル、ホームのパスが含まれないこと）
└── test/
    ├── ui/                  vitest（flow、画面、i18n、文言、CSS）
    └── engine/              同梱ツールだけで engine を実行（Homebrew なしの PATH）
```

- UI が FFmpeg を直接呼ぶことはない。Rust も呼ばない。呼ぶのは Core だけ。
- Core のロジックは複製しない。Engine は Core の公開 API（`analyzeAndPlan`、`convert`、`cleanupStaleJobs`、`createErrorReport`、`exitCodeFor`、`nextOutputDirectory`）を呼び、結果を JSON にするだけ。
- Core は Node 上で動くので、Node の公式バイナリを sidecar として同梱する（§2）。

### Engine protocol

```text
node engine.js analyze <input.mp4> [--output <dir>] --tools <Contents/MacOS> --app-version <v>
  → {"type":"plan", analysis, plan, planDigest, outputFolder} | {"type":"error", error}

node engine.js convert --tools <dir> --app-version <v>
  stdin: {"input", "outputDirectory", "planDigest"}（1 行）、その後 "cancel"
  → {"type":"progress", event}* → {"type":"done", result} | {"type":"error", error}
```

- `error` は `{code, reason, planErrors, report}`。`report` は Core の `createErrorReport`（入力パス・出力パス・ホームを伏せ字にしたもの）。
- 終了コードは Core の `exitCodeFor`（0 成功、1 失敗、2 入力、3 検証、4 キャンセル）。
- Rust は engine を `env_clear()` と `PATH=/usr/bin:/bin:/usr/sbin:/sbin` で起動する（ユーザーのシェル環境と Homebrew を引き継がない）。ツールは `--tools` の絶対パスだけを使う。
- `result.notMeasured` は、この動画では測れなかった検証項目（`status: 'unmeasurable'`、docs/core.md §7）の数。完了画面の「測定できなかった項目」に出す。

### Trust boundary（Phase 5.1）

UI（WebView）が選べるのは **入力の MP4** と **出力の親フォルダ** だけ。変換の方針（フィルタ、ビットレート、音声、出力名、ISO 名）は UI から渡らない。

```text
UI ──(input, outputDirectory, planDigest)──▶ Rust start_conversion ──▶ engine convert
                                                                         │ job の形を検査
                                                                         ▼
                                                     Core convert(): 解析 → plan を作り直す
                                                                     → digest が違えば PLAN_CHANGED
```

- `plan` は確認画面の表示用。変換を始めるとき UI が返すのは、そのときの `planDigest`（plan の SHA-256）だけ。
- engine は job を **ちょうど `{input, outputDirectory, planDigest}`** として受け取る。ほかのキー（旧プロトコルの `plan` を含む）、JSON でない行、相対パス・`..` を含むパス・存在しない出力フォルダ・ファイルは `INPUT_ERROR`（`INVALID_JOB`）で、何もしない。`analyze --output` の出力フォルダも同じ検査をする。
- Core は入力を解析し直して plan を作り、digest が一致しなければ `INPUT_ERROR`（`PLAN_CHANGED`）で止める。確認画面を出したあとに MP4 が変わった（内容、または更新時刻だけでも）、別の出力フォルダを指定した、偽の plan の digest を送った、のどれでもここで止まる。
- 出力フォルダ名・ISO 名・staging 名は Core の plan から作り、`safeChildPath()` で親フォルダの直下に限る（UI の値のサニタイズには頼らない）。
- 出力フォルダ（Phase 5.2）: Core が plan を作るときに実体のパスへ解決し（シンボリックリンクをたどる）、Plan 画面にはそのパスを出す。UI は変換のときにそのパスを返すので、確認後にリンクの向きが変わっても、変換は確認したフォルダに固定される。リンクのパスを送った場合や、同じパスのフォルダが別のものに置き換わった場合は、フォルダの device:inode が plan（digest）と合わず `PLAN_CHANGED` で止まる。変換中の置き換えは Core が `OUTPUT_CHANGED` で止める（docs/core.md §2）。
- 出力フォルダを変えると、UI は engine に analyze をやり直させ、新しい plan と digest を受け取る。
- 大がかりな認証や IPC の仕組みは入れていない。境界を狭くしただけ。
- 確認（`test/engine/engine.test.ts`、同梱の node とツールで実行）: 偽のビットレート・ffmpeg フィルタ・ISO 名（`../../x.iso`、絶対パス）を含む job、旧プロトコルの job、偽の plan の digest、相対・`..` 入り・存在しない・ファイルの出力フォルダ、plan と違う出力フォルダ、確認後に内容または更新時刻が変わった入力。どれも変換を始めず、出力フォルダにも作業フォルダの外にも何も残らない。出力フォルダを変えて plan を作り直した場合は、新しいフォルダに変換される。

---

## 2. Bundled toolchain

`npm run build:toolchain`（`scripts/build-toolchain.sh`）。ビルド時だけ Xcode CLT、curl、pkg-config、autoconf、automake、libtool が必要。ユーザーの環境には何も要らない。

| | Version | License | ビルド |
| --- | --- | --- | --- |
| ffmpeg / ffprobe | 7.1 | LGPL-2.1-or-later | `--disable-autodetect --disable-network --enable-zlib --enable-iconv --enable-libzimg`、静的、`--enable-gpl` / `--enable-nonfree` なし |
| zimg | 3.0.5 | WTFPL | 静的、ffmpeg に内蔵（HDR → SDR の `zscale`） |
| dvdauthor | 0.7.2 | GPL-2.0-or-later | `--disable-dvdunauthor`、dvdauthor のみ、libxml2 は macOS SDK |
| node | 22.23.2 | MIT ほか | 公式バイナリ（SHASUMS256 で確認、Node.js Foundation の署名つき） |

- 全バイナリが `/usr/lib` と `/System/Library` だけにリンク（スクリプトが `otool -L` で確認し、それ以外なら失敗）。
- `PKG_CONFIG_LIBDIR` を自前の prefix に限定し、Homebrew のライブラリを拾わない。
- 最小 OS: ffmpeg / ffprobe / dvdauthor は 14.0、node は 11.0。
- ffmpeg は `-version` で configure を表示するため `--prefix=/usr/local`（中立）でビルドする。ビルドした Mac のパス（ユーザー名）が入っていないことをスクリプトと `check-bundle.mjs` が確認する。
- サイズ: ffmpeg 21 MB、ffprobe 21 MB、dvdauthor 190 KB、node 113 MB。.app 全体で約 155 MB。
- 実際のバージョン、ソースの SHA-256、configure、バイナリの SHA-256、リンク先は `third-party/build-info/toolchain.txt`（アプリにも同梱）。
- ライセンス文は `third-party/licenses/`、一覧と再配布の注意は `third-party/README.md`。アプリの MIT とは別に扱う。

### Toolchain isolation の確認

- `test/engine/engine.test.ts`: 同梱 node で engine を起動、環境は `HOME`、`TMPDIR`、`LANG`、`PATH=/usr/bin:/bin` だけ。変換中の ffmpeg のパスが同梱ディレクトリで始まることを `ps` で確認。
- 実 .app: 変換中の `ps` で `…/MP4 to IFO.app/Contents/MacOS/ffmpeg` と `…/node` を確認（§5）。

---

## 3. Process lifecycle

engine は自分のプロセスグループで動く（`process_group(0)`）。ffmpeg、ffprobe、dvdauthor、caffeinate はその子。

| 経路 | 動作 | 確認 |
| --- | --- | --- |
| Cancel | 確認ダイアログ → stdin に `cancel` → Core が子を止め、作業フォルダと途中の出力を削除、ロック解放 → engine 終了 | 実 .app、engine test |
| ウィンドウを閉じる（変換中） | 閉じずに確認:「変換を続ける」/「キャンセルして終了」。後者は cancel → 後片付けを最大 20 秒待つ → 残りを `killpg(SIGKILL)` → 終了 | 実 .app |
| Cmd+Q（変換中） | 同じ確認。Quit はアプリ独自のメニュー項目（標準の Quit は `-[NSApp terminate:]` を呼び、Tauri 2 / tao では止められないため） | 実 .app |
| 確認なしの終了（ログアウト、`quit` Apple Event） | `RunEvent::Exit` で cancel → 最大 5 秒待つ → `killpg` | 実 .app（`osascript … to quit`） |
| アプリが kill -9 / クラッシュ | engine が stdin の終了（と stdout の EPIPE）で中止し、Core が後片付けして終了 | 実 .app（約 3 秒で子プロセス・ロック・作業フォルダなし）、engine test |
| engine の正常終了後 | Rust がそのグループに `killpg(SIGKILL)`（念のため） | — |

- Phase 5 の実 .app 試験で、kill -9 のあと stdout への書き込みの EPIPE で engine が先に落ち、ffmpeg が数秒残り、作業フォルダとロックが残る不具合を見つけた。engine は stdout のエラーを無視して中止するよう修正し、回帰テスト（stdin と stdout を同時に閉じる）を追加した。
- 同じく、標準の Cmd+Q が確認なしで終了し、作業フォルダとロックが残る不具合を見つけた（上の Quit メニューで修正）。残った作業フォルダとロックは次回の変換で Core の `cleanupStaleJobs` と古いロックの判定が回収することも確認した。

**限界:** engine 自体が kill -9 された場合、ffmpeg は親を失い、progress の出力先が閉じて SIGPIPE で終わるまで数秒動くことがある。作業フォルダは次回の変換で回収される。電源断では何も片付かないが、出力は検証後に確定するため不完全な出力は残らない（作業フォルダは次回回収）。常駐プロセス（daemon）は使わない。

---

## 4. UI

- 画面: Home → Analyzing → Plan → Converting → Complete、ほかに Failed（エラーとキャンセル）。Settings はシート。履歴、プレビュー、サイドバーはない。
- 入力: ドロップまたは「MP4 を選択」（ネイティブ、`.mp4` のフィルタ）。複数ファイル・フォルダ・`.mp4` 以外は Home に注意を出す。実際の検証は Core（壊れた MP4 は Failed）。
- Plan: 入力（解像度、長さ、fps / 可変、音声）、DVD 出力（NTSC 16:9、720×480、フレームレート戦略、音声）、推定サイズ、出力先。警告は「注意」、エラーは「変換できません」として別の見た目で表示し、エラーがあると「変換」は無効。
- 出力先: 既定は入力と同じフォルダ。「変更…」でフォルダを選ぶと Core がプランを作り直し、名前（`name`、`name-2`…）も Core が決める。
- Converting: フェーズ、バー、%、処理済みのメディア時間、キャンセル。残り時間は出さない。
- Complete: 「ソフトウェアによる検証に合格しました」、ファイル一覧、「出力フォルダを開く」（押したときだけ）、DVD プレーヤーで確認する旨、「別の MP4 を変換」。「DVD の焼き方」は `config.burnGuideUrl` が設定されたときだけ表示（現在 null）。
- Failed: 平易な一文。「エラーの詳細をコピー」は伏せ字済みレポート（JSON）をクリップボードへ。「問題を報告」は `config.reportIssueUrl` があるときだけ（現在 null）。送信はしない。
- 言語: English / 日本語。既定は macOS の言語の先頭が日本語なら日本語、それ以外は English。Settings で変更すると即時に反映し、`localStorage`（`mp4-to-ifo.language`）に保存。macOS のメニューは English のみ。
- 見た目: SENA の方針（中立色、細い線、名前・ボタン・値は等幅、カード・影・グラデーションなし、角丸 4px 以下）。背景 `#f4f1ea`、ダークモードは macOS に従う（`prefers-color-scheme`）。ウィンドウは 720×560 固定。
- アクセシビリティ: すべてボタン・ラベル付き、`:focus-visible`、進捗は `role="progressbar"` とテキスト、ドロップの代わりにファイル選択。
- 通知: 完了と失敗（キャンセルは除く）を、ウィンドウが前面にないときだけ。音なし。
- スリープ防止: Core の `caffeinate -i -w <pid>`（システムスリープのみ、ディスプレイは対象外）。終了で解除。
- Settings: 言語、バージョン、「アップデートを確認」（この開発版では利用できない旨を表示）、オープンソースライセンス（同梱の全ライセンス文）。

---

## 5. 実 .app での確認（Phase 5）

`npm run app` でビルドし、LaunchServices（`open`、Finder のダブルクリックと同じ経路）で起動。操作は macOS のアクセシビリティ API（System Events）でボタンを押し、ファイル選択パネルにパスを入れた。Terminal や Homebrew は変換に関与しない（engine は PATH から Homebrew を除いた環境で同梱ツールを使う）。

| 入力 | 結果 |
| --- | --- |
| standard-16x9（1920×1080、29.97、stereo、60 秒） | Complete、VIDEO_TS / zip / ISO。ISO は `hdiutil` で読み取り専用マウントして中身を確認 |
| fps-59.94 | Complete（59.94i） |
| fps-23.976 | Complete（3:2 プルダウン） |
| no-audio | 警告 → Complete（無音 AC-3） |
| audio-5.1 | 警告 → Complete（ダウンミックス） |
| m-vfr（可変フレームレート） | 警告 → Complete |
| `オープニング ムービー.mp4`、`my home movie (1).mp4` | Complete（日本語・空白・括弧） |
| hdr10-synthetic | 警告、変換は可能 |
| 4ch 音声 | 「変換できません」、変換は無効 |
| truncated / fake | Failed、コピーしたレポートに名前・パス・ユーザー名なし |

変換中の確認: ffmpeg と node は `.app/Contents/MacOS/` のもの、`caffeinate -i` のアサーションあり、終了後は子プロセスもアサーションも残らない。

**Phase 5.1 の再確認**（Trust boundary と検証の変更後に `npm run app` で作り直した .app）: LaunchServices で起動 → 「MP4 を選択」→ 59.94 fps のモーション素材（クリック音つき、名前に空白）→ 解析 → Plan（59.94i、出力先は入力と同じフォルダ）→「変更…」で別のフォルダを選ぶ → Plan が新しい出力先で作り直される →「変換」→「DVD-Video を作成しました / ソフトウェアによる検証に合格しました。」（測定できなかった項目なし）。出力は選んだフォルダに VIDEO_TS / VIDEO_TS.zip / ISO だけで、staging は残らない。変換中に動いたのは `.app/Contents/MacOS/` の ffmpeg と node、`caffeinate -i` だけで、終了後は子プロセス・作業フォルダ・ロックが残らない。操作はアクセシビリティ API で行い、ファイル選択パネルでは行の選択と「Open」のクリックを API で行った（パネルへのキー入力が届かない場合があったため）。

**Phase 5.2 の再確認**（出力フォルダの扱いを変えたあとに作り直した .app）: LaunchServices で起動 →「MP4 を選択」→ 15 fps の内容を 60 fps で保存した MP4（H3 の素材、クリック音つき、名前に空白）→ Plan（59.94i。入力は `/tmp`（シンボリックリンク）の下にあり、出力先は実体の `/private/tmp/…` で表示）→「変更…」で別のフォルダ → 新しい出力先で Plan が作り直される →「変換」→「DVD-Video を作成しました / ソフトウェアによる検証に合格しました。」（測定できなかった項目なし）。出力は選んだフォルダに VIDEO_TS / VIDEO_TS.zip / ISO だけ、staging なし、変換中は同梱の ffmpeg と node と `caffeinate -i` だけ、終了後に残るプロセスなし。ファイル選択パネルでの「フォルダへ移動」のキー入力は届かないことがあり、パネルが開いているフォルダに入力を置いて、行の選択と「Open」を API で行った。

**自動化できなかったもの:** Finder からのドラッグ＆ドロップ。この環境では合成したマウスイベントが無視され（画面収録の権限もない）、実機での操作確認が必要。ドロップの判定（1 つ、複数、フォルダ、`.mp4` 以外）は unit test で確認している。見た目はヘッドレス Chrome で各画面を実際の CSS で描画して確認した（WebKit のアプリ画面そのものではない）。

---

## 6. Signing / notarization（調査、Phase 6 で実施）

現在の .app は ad-hoc（リンカー署名）のみ。ローカルでビルドしたものは quarantine がないので起動できるが、ダウンロードしたものは Gatekeeper に止められる。

- 署名: `APPLE_SIGNING_IDENTITY`（または `bundle.macOS.signingIdentity`）に Developer ID Application を指定すると、`tauri build` がアプリと `externalBin`（node、ffmpeg、ffprobe、dvdauthor）に署名する。Hardened Runtime は `bundle.macOS.hardenedRuntime: true`（設定済み）。
- Entitlements（`src-tauri/entitlements.plist`）: V8（node）の JIT に `com.apple.security.cs.allow-jit` と `allow-unsigned-executable-memory`。node の公式署名は `allow-jit`、`allow-unsigned-executable-memory`、`disable-executable-page-protection`、`disable-library-validation`、`allow-dyld-environment-variables`、`get-task-allow` を持つ。再署名したときに node に適用される entitlements と、そのうえで node が動くことを確認する（`get-task-allow` は公証で不可）。
- 公証: `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH`（または `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`）を設定すると `tauri build` が公証と staple を行う。入れ子の実行ファイルはすべて Developer ID・Hardened Runtime・secure timestamp が必要。
- App Sandbox は使わない（同梱の実行ファイルを子プロセスとして起動し、ユーザーが選んだ場所に書き込むため。Mac App Store は対象外）。
- 確認手順: `codesign --verify --deep --strict`、`spctl -a -vv`、公証後に quarantine を付けた状態での初回起動。
- Updater（`tauri-plugin-updater`）は未導入。署名鍵とエンドポイントは Phase 6 で決める。UI は `config.updatesEnabled` で「利用できない」旨を出すだけで、偽のエンドポイントや鍵は置いていない。

---

## 7. ビルドとテスト

```bash
npm install
npm run build:toolchain -w @mp4-to-ifo/desktop   # 初回のみ（数分）
npm run app -w @mp4-to-ifo/desktop               # engine → tauri build → check-bundle
npm test -w @mp4-to-ifo/desktop                  # vitest（UI）+ engine（同梱ツールのみ）
```

- Rust（rustup の stable）が必要。`npm run app` は `RUSTFLAGS=--remap-path-prefix=$HOME=~` で、Rust のバイナリにビルドした Mac のホームのパスが入らないようにする。
- 出力: `apps/desktop/src-tauri/target/release/bundle/macos/MP4 to IFO.app`。`binaries/`、`engine/`、`target/`、`build/` は git に入れない。
