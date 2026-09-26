# MP4 to IFO — CLI

`packages/cli`（npm パッケージ名 `mp4-to-ifo`、コマンド `mp4-to-ifo`）。Core の薄い利用者で、変換・計算・検証のロジックは持たない。
この文書はリポジトリの開発者向け。利用者向けの概要は README、npm パッケージの README（未公開）は `packages/cli/README.md`。

```text
arguments → Core API → terminal output → exit code
```

**Not physically verified.** 成功時の表示は「ソフトウェア検証に通った」ことだけを示し、DVD プレーヤーでの互換性は主張しない。

---

## 1. 構成

```text
packages/cli/
├── src/
│   ├── main.ts      bin。package.json から version を読み、run() に process を渡す
│   ├── cli.ts       run(argv, env): 引数 → Core → 表示 → 終了コード。シグナル、確認
│   ├── args.ts      node:util parseArgs による引数解析と usage
│   └── render.ts    表示（サマリー、警告、エラー文、進捗、結果）
├── scripts/bundle-core.mjs   npm pack 時に Core を同梱する
├── test/unit/cli.test.ts           Core を差し替えたテスト
├── test/integration/cli.test.ts    子プロセスとして起動し、実際の Core とツールで確認
└── test/integration/pack.test.ts   npm pack → tarball をインストール → npx で変換
```

- ランタイム依存は Core（同梱）のみ。引数解析・プロンプト・進捗はすべて Node.js 標準（`util.parseArgs`、`readline`）。
- `run()` は stdout / stderr / stdin / シグナル / Core を引数で受け取る（テストで差し替える）。
- Version の出典は `packages/cli/package.json` の 1 か所。Core と同じ SemVer であることをテストと `prepack` で確認する。

---

## 2. Interface

```text
mp4-to-ifo <input.mp4> [options]

-o, --output <directory>  出力先（既定: 入力と同じフォルダ）
-y, --yes                 確認しない
    --verbose             ツールのバージョン、変換の詳細、失敗時の伏せ字済みエラーレポート
-h, --help
    --version
```

- 入力は位置引数で 1 つだけ。なし → usage（exit 2）。2 つ以上 → exit 2。未知のオプション（`--bitrate` など）→ exit 2。
- 変換設定（ビットレート、フレームレート、インターレース、音声、HDR、ISO、PAL、チャプター、メニュー）は公開しない。
- `--output=~/x` の `~` は CLI で展開する（シェルが展開しない書き方のため）。
- 出力フォルダ名の採番（`-2`, `-3`）は Core（`nextOutputDirectory` で表示、`finalize` で確定）。

## 3. 流れ

1. `resolveToolchain()`（PATH から ffmpeg / ffprobe / dvdauthor。パスは固定しない）。`--verbose` なら `inspectToolchain()` を表示。
2. `cleanupStaleJobs()`（以前に強制終了した実行の作業フォルダを回収）。
3. `analyzeAndPlan()` → サマリー（入力、DVD、推定サイズ、出力先）→ 警告。
4. プランにエラーがあれば、変換せずに exit 2。
5. ロックを確認（`acquireLock` → すぐ解放。使用中なら確認の前に停止）。
6. 確認: TTY なら `Continue? [Y/n]`（Enter / y で続行、n で exit 4）。TTY でなく `--yes` もなければ、入力を待たずに exit 2（「Run with --yes」）。
7. `convert()`（Core がロックを取り直す。表示した plan の `planDigest` だけを渡し、Core が作り直した plan と違えば `PLAN_CHANGED` で止まる）→ 進捗 → 結果。出力フォルダは Core が実体のパスへ解決したものを表示し、そこに書き込む（シンボリックリンクの付け替えやフォルダの置き換えは `PLAN_CHANGED` / `OUTPUT_CHANGED`）。

## 4. 表示

- **TTY**: フェーズごとに 1 行を上書きで更新（最短 200 ms 間隔）。例 `Encoding pass 2/2... 53% · 00:48`。
- **非 TTY**（パイプ・リダイレクト・CI）: エスケープコードも `\r` も出さない。フェーズの開始時と、エンコード / 検証の 25・50・75% で 1 行ずつ。
- 警告は stdout、エラーは stderr。複数行はインデントする。
- 結果: 出力フォルダ、ファイル、`Verification: passed (N of M checks[; K could not be measured for this video])`（M は対象外の項目を除いた数、K はこの動画では測れなかった項目の数）、実機での再生確認の案内。`--verbose` では、測れなかった項目とその理由、映像・音声・その差のタイミング、フィールドの動きの coverage も出す。
- エラー: 人間向けの 1〜数行（例 `The MP4 file appears to be incomplete or damaged.`）。スタックトレースは出さない。通常は `Run again with --verbose for more details.`、`--verbose` では `createErrorReport()` の結果（パス・ファイル名・ホームディレクトリを伏せ字）を JSON で出す。GUI の Copy Error Details でも同じ形式を使う。

## 5. 終了コード

`exitCodeFor()`（Core）をそのまま使う。

| code | 意味 |
| --- | --- |
| 0 | 成功、`--help`、`--version` |
| 1 | 変換の失敗（ツールがない、ロック中、エンコード / オーサリング / ZIP / ISO / 出力の失敗） |
| 2 | 入力・使い方のエラー（引数、入力なし、壊れた MP4、未対応の音声 / HDR、長すぎる、非 TTY で `--yes` なし） |
| 3 | 検証の失敗 |
| 4 | キャンセル（シグナル、確認で n、確認中の Ctrl+C） |

## 6. シグナル

- 1 回目の SIGINT / SIGTERM → `AbortController.abort()`。後片付け（子プロセスの停止、作業フォルダ・staging の削除、ロックの解放、スリープ抑止の解除）は Core が行う → exit 4。
- 2 回目 → 後片付け中であることを表示。3 回目 → その場で終了（一時ファイルが残る場合があり、次回の実行で回収される）。
- ターミナルでの Ctrl+C（プロセスグループ全体への SIGINT。ffmpeg も直接受け取る）でも exit 4 になり、後片付けが完了することをテストした。
- `kill -9` のように CLI がシグナルを受け取れない終了では、子の ffmpeg が残る（`docs/core.md` §11）。

## 7. npm パッケージ

- `bin: { "mp4-to-ifo": "dist/main.js" }`、`files: dist, README.md, LICENSE`、`engines.node >= 22.18`、`license: MIT`。repository / bugs は公開リポジトリ（https://github.com/SENA10X/mp4-to-ifo）。homepage の GitHub Pages の URL は、現在ページがない（404）。
- Core は非公開のワークスペースパッケージのため、`bundleDependencies` で同梱する。npm はワークスペースのシンボリックリンクを同梱しないので、`prepack` で Core と CLI をビルドし、Core の `dist` と実行時用の `package.json` を `packages/cli/node_modules/@mp4-to-ifo/core` に実体としてコピーする。`postpack` で削除する。
- tarball: 63 ファイル、約 97 kB（展開後 約 228 kB）。src / test / scripts / ソースマップは含まない。
- `test/integration/pack.test.ts`: `npm pack` → 空のプロジェクトにオフラインでインストール → `npx --no-install mp4-to-ifo --version / --help / sample.mp4 --yes` で変換まで確認する。
- **npm publish はしていない。** v0.1.0 の GitHub Release（pre-release）は Mac アプリだけで、CLI はリポジトリから実行する。ffmpeg / ffprobe / dvdauthor は同梱しない（PATH から解決）。ツールを同梱するのは Mac アプリだけ（docs/desktop.md §2）。

## 8. Privacy

テレメトリ、アナリティクス、アップロード、アカウントはない。動画はローカルでのみ処理する。
