# MP4 to IFO — Phase 3 Production Core

`packages/core`（`@mp4-to-ifo/core`、private）。GUI（Tauri）と CLI が共有する変換 Core。
変換仕様の出典は `docs/poc.md`。PoC（`scripts/poc-convert.mjs`）は Reference として残している。

**Physical DVD playback compatibility has not been verified.**
特に 59.94i、Hard Telecine、自前 ISO/UDF、DVD-R / DVD+R の違いは、Beta での実機確認の対象。

---

## 1. Architecture

```text
packages/core/src/
├── index.ts            公開 API（GUI / CLI はここだけを使う）
├── job.ts              変換ジョブ: lock → analyze → plan → preflight → encode → author → ZIP → ISO → verify → finalize → cleanup
├── analyze.ts          ffprobe → InputAnalysis（正規化モデル）+ 入力検証
├── plan.ts             InputAnalysis → ConversionPlan（シリアライズ可能）
├── capacity.ts         容量・ビットレート・ディスク容量
├── naming.ts           出力名（元の名前を維持）/ Volume Label（A-Z0-9_）
├── profile/
│   ├── frame-rate.ts   フレームレート戦略（差し替え可能な Policy）
│   ├── audio.ts        音声プラン（stereo / mono / 5.1 / silence）
│   └── video.ts        有効領域・色・HDR（Experimental）・フィルタ
├── encode.ts           ダウンミックスのピーク計測 + FFmpeg 2-pass
├── author.ts           dvdauthor（最小 XML）
├── dvd/
│   ├── ifo.ts          IFO パーサ
│   ├── layout.ts       VIDEO_TS のファイル構成と IFO が決めるディスク上の配置
│   └── vob.ts          VOB 走査（PS パック、NAV、PTS、MPEG-2 ヘッダ、GOP）
├── iso/
│   ├── encoding.ts     ECMA-119 / ECMA-167 の低レベル符号化（CRC-16、タグ、dstring 等）
│   ├── writer.ts       DVD-Video 専用 ISO 9660 + UDF 1.02 Writer
│   └── reader.ts       ISO の独立した読み戻し・構造検査
├── zip.ts              ZIP（無圧縮格納、Zip64 対応）Writer / Reader
├── verify/
│   ├── index.ts        検証（§7）
│   ├── sync.ts         内容ベースの映像・音声・A/V のタイミング計測
│   └── fields.ts       フィールドの時間情報の検査（生成側と独立）と、映像の変化点
├── toolchain.ts        ffmpeg / ffprobe / dvdauthor の解決・機能とライセンスの点検
├── process.ts          外部プロセス（引数配列のみ、AbortSignal、出力の上限）
├── lock.ts             変換ロック（macOS ユーザーごとに 1 変換、§9）
├── platform.ts         OS 依存部分（スリープ抑止・PID の起動時刻・マウント）
├── fsutil.ts           ハッシュ・Source fingerprint・空き容量・移動
├── errors.ts           型付きエラーと CLI 終了コードの対応
└── log.ts              構造化ログ・リダクション・エラーレポート
```

- ランタイム依存は **なし**（Node.js 22.18+ の組み込みモジュールのみ）。開発依存は `typescript` と `@types/node` だけ。
- `.ts` をそのまま `node --test` で実行する（Node 22.18 以降の type stripping）。配布用には `npm run build` で `dist/`（`.js` + `.d.ts`）を出力する。
- ZIP と ISO/UDF は自前実装。mkisofs はランタイムでは使わず、テストの Reference としてのみ使う。

---

## 2. Public API

```ts
import {
  resolveToolchain, inspectToolchain,
  analyzeAndPlan, analyzeInput, planConversion,
  convert, verifyOutput, cleanupStaleJobs,
  exitCodeFor, createErrorReport,
  INTERLACED_POLICY, PROGRESSIVE_POLICY, defaultPlatform,
} from '@mp4-to-ifo/core';

const toolchain = resolveToolchain({ ffmpeg, ffprobe, dvdauthor }); // Tauri sidecar のパス、または PATH

// 変換前の確認画面用
const { analysis, plan } = await analyzeAndPlan(input, { toolchain, outputDirectory });
plan.warnings; // [{ code: 'LOW_BITRATE', data: {...} }, ...] → GUI は Cancel / Convert Anyway
plan.errors;   // 空でなければ変換不可

// 変換
const controller = new AbortController();
const result = await convert({
  input, toolchain,
  planDigest: planDigest(plan),      // 省略可。確認画面で見せた plan の digest
  outputDirectory,                   // 省略時は入力と同じフォルダ
  signal: controller.signal,
  onProgress: (e) => {},             // { phase, phaseProgress, overallProgress, mediaTime?, mediaDuration? }
  log: (event) => {},                // 構造化ログ（パスを含まない）
  requireLgpl: true,                 // 配布ビルドでは true
});
// result.outputDir / videoTsDir / zipPath / isoPath / verification / audio / timingsMs
```

- GUI / CLI は ffmpeg / dvdauthor / ISO / ZIP の詳細を知らない。すべて Core の責務。
- Core はダイアログを出さず、`process.exit()` もしない。
- `plan` は JSON にそのまま変換でき、変換前の確認画面に使える。
- **出力フォルダ**（Phase 5.2、M6）: plan を作るときに実体のパスへ解決し（シンボリックリンクをたどる。まだないフォルダは、存在する親から解決）、`plan.output.directory` にする。確認画面に出すパスと、実際に書き込む場所は同じ。フォルダの device:inode を `plan.output.directoryId` に記録する（まだないフォルダは null）。これは `planDigest` に含まれるので、確認後にリンクの向きが変わった、同じパスのフォルダが別のものに置き換わった、のどちらでも `PLAN_CHANGED` で止まる。変換中も、staging を作る前・作った直後（staging の親が同じフォルダか）・確定の rename の前に、実体のパスと device:inode を確認し、違えば `OUTPUT_ERROR`（`OUTPUT_CHANGED`）で止める。CLI も同じ（Core で行う）。
- **`convert()` は plan を受け取らない**（Phase 5.1）。常に自分で入力を解析し直して plan を作り、それで変換する。呼び出し側は、ユーザーが確認した plan の `planDigest(plan)`（SHA-256）だけを渡せる。作り直した plan の digest が違えば（入力や出力先が変わった、別の plan が渡された）、何もせずに `INPUT_ERROR`（`PLAN_CHANGED`）になる。フィルタ・ビットレート・出力名などの変換方針は、呼び出し側から変えられない。
- 出力フォルダ名・ISO 名・staging 名は `safeChildPath()` で親フォルダの直下の 1 要素に限る（区切り文字、`.` / `..`、絶対パス、NUL を拒否し、解決後のパスが親の直下であることを確認）。

### ConversionPlan

| 項目 | 内容 |
| --- | --- |
| `input` | パス、サイズ、更新時刻、映像の長さ、原点、映像/音声の終了時刻 |
| `output` | 出力先フォルダ、名前（重複時は `-2` 以降）、ISO ファイル名、Volume Label |
| `video` | 元ストリーム、720×480 / 16:9 / SAR 32:27、有効領域（Aspect）、入力の色行列、HDR プラン、フレームレート戦略、ビットレート、フィルタ全体 |
| `audio` | 戦略（stereo / mono-to-stereo / downmix-5.1 / silence）、元トラック、行列、クリップ保護の上限、AC-3 256 kbps 48 kHz 2ch |
| `expected` | 予想 VOB サイズ、ディスク必要量（temp / output / 同一ボリューム） |
| `warnings` | `LOW_BITRATE` `NO_AUDIO` `SUBTITLES_NOT_INCLUDED` `MULTIPLE_AUDIO_TRACKS` `DOWNMIX_TO_STEREO` `VARIABLE_FRAME_RATE` `HDR_TONEMAP_EXPERIMENTAL` `DOLBY_VISION_BASE_LAYER` |
| `errors` | `TOO_LONG` `UNSUPPORTED_AUDIO_LAYOUT` `UNSUPPORTED_HDR` `HDR_DISABLED` |

---

## 3. Conversion lifecycle

| Phase | 内容 |
| --- | --- |
| （開始前） | 変換ロックを取得 |
| `ANALYZING` | ffprobe 解析、途中切れ検出（moov 上のサンプル数と読めたパケット数）、先頭 2 s のデコード、プラン作成、`planDigest` の照合 |
| `PREFLIGHT` | ツールの機能・ライセンス（`requireLgpl`）、出力先の書き込み権限、temp / 出力ボリュームの空き容量、Source fingerprint、スリープ抑止の開始 |
| `ENCODING_PASS_1` | （5.1 のみ）ダウンミックス後のピーク計測 → pass 1 |
| `ENCODING_PASS_2` | pass 2 → `title.mpg` |
| `AUTHORING` | dvdauthor → `VIDEO_TS`。`WARN`/`ERR` 行は失敗として扱う |
| `CREATING_ZIP` | 出力ボリューム上の staging（`.mp4-to-ifo-<uuid>.partial`）へ VIDEO_TS を移し、ZIP を作成 |
| `CREATING_ISO` | 自前 Writer で ISO を作成 |
| `VERIFYING` | 検証（§7） |
| `FINALIZING` | `<name>` を mkdir で確保 → staging をその空フォルダへ rename（アトミック）。使われていれば `<name>-2`, `-3` … |
| `COMPLETED` | — |

成功・失敗・キャンセルのどれでも、job フォルダ・staging の削除、スリープ抑止の解除、ロックの解放を必ず行う（`finally`）。

- **Temporary files**: `<os.tmpdir()>/mp4-to-ifo/jobs/job-*`（pass log、title.mpg、dvdauthor の作業領域、`owner.json`）。`tempRoot` で変更できる。
- **Crash recovery**: `cleanupStaleJobs()` が、所有プロセスがいない（PID が存在しない、または起動時刻が違う）job フォルダと、それに記録された staging フォルダ（名前が `.mp4-to-ifo-*.partial` の場合のみ）を削除する。ユーザーのフォルダには触れない。
- **Output**: `<output>/<name>/{VIDEO_TS/, VIDEO_TS.zip, <name>.iso}`。検証を通るまで正式な名前は現れない。
- **External drives**: 出力先は任意のボリュームでよい。途中で切断されると I/O エラーになり、`OUTPUT_ERROR` で後片付けする（再開はしない）。

### Progress

`onProgress({ phase, phaseProgress, overallProgress, mediaTime, mediaDuration })`。
エンコード中は ffmpeg の `-progress` から処理済みのメディア時間を送る。`overallProgress` はフェーズの重み（pass 1: 30、pass 2: 35、検証: 20 …）で 0→1 に単調増加する。ETA と UI 文言は Core の責務外。

### Cancellation

`AbortSignal`。abort すると、実行中の子プロセスに SIGTERM（3 s 後に SIGKILL）を送り、ファイル書き込みのループも止める。`CANCELLED`（終了コード 4）になり、失敗とは区別される。テストで、ffmpeg の子プロセス・job フォルダ・staging・ロックが残らないことを確認している。

---

## 4. Error model

| code | 例 | 終了コード（`exitCodeFor`） |
| --- | --- | --- |
| `INPUT_ERROR` | `NOT_MP4`, `TRUNCATED`, `NO_VIDEO`, `UNDECODABLE`, `PLAN_CHANGED`, プランのエラー | 2 |
| `PREFLIGHT_ERROR` | `LOCKED`, `DISK_SPACE`, `TOOL_MISSING`, `TOOL_FEATURES`, `FFMPEG_LICENSE`, `OUTPUT_NOT_WRITABLE` | 1 |
| `ENCODE_ERROR` / `AUTHOR_ERROR` / `ZIP_ERROR` / `ISO_ERROR` | ツールの失敗、`AUTHOR_WARNINGS` | 1 |
| `OUTPUT_ERROR` | 出力先の I/O 失敗（切断を含む）、`OUTPUT_NAME`（出力名が親フォルダの外を指す）、`OUTPUT_CHANGED`（変換中に出力フォルダが移動・置き換えられた） | 1 |
| `VERIFY_ERROR` | `reason` に失敗した検証 ID の一覧 | 3 |
| `CANCELLED` | — | 4 |
| `INTERNAL_ERROR` | 想定外 | 1 |

`ConversionError { code, reason, detail, exitCode }`。`detail`（ツールの stderr 等）にはパスが含まれることがあるため、表示やコピーの前に `createErrorReport(error, { sensitive: [input, outputDir] })` を通す。入力パス・出力パス・ファイル名（拡張子なしを含む）・ホームディレクトリが伏せ字になる。Core はテレメトリを送らない。

---

## 5. Toolchain

- `resolveToolchain(overrides?)`: 明示されたパス（Tauri sidecar）を優先し、なければ PATH から探す。パスは固定しない。
- `inspectToolchain()`: バージョン、`configuration`、ライセンス（`lgpl` / `gpl` / `nonfree`）、必要な filter / encoder / muxer の欠落。
- 必要な機能: filter `scale pad tpad fps setsar setfield separatefields select weave telecine format pan volume astats aresample anullsrc showinfo`、encoder `mpeg2video ac3`、muxer `dvd`。HDR（Experimental）はさらに `zscale tonemap`。
- `GPL_ONLY_FILTERS` は FFmpeg 7.1 の `configure` から抽出した一覧。全戦略のフィルタがこれに含まれないことをテストしている。
- テストと回帰は **LGPL 版 FFmpeg 7.1** で実行した（`scripts/experiments/build-ffmpeg-lgpl.sh`）。

```text
--prefix=…/build/ffmpeg-lgpl --disable-autodetect --disable-network --disable-doc --disable-ffplay
--disable-shared --enable-static --enable-zlib --enable-iconv --enable-libzimg --extra-libs=-liconv
→ License: LGPL version 2.1 or later
```

---

## 6. 変換仕様（Phase 2 からの変更点を含む）

基本は `docs/poc.md` §7（MPEG-2 MP@ML 720×480 16:9 yuv420p、`-g 18 -bf 2 -maxrate 9000k -bufsize 1835008 -flags +ildct+ilme -top 1`、`-f dvd -muxrate 10080000 -packetsize 2048`、AC-3 256 kbps）。

### フレームレート（`profile/frame-rate.ts`）

| 入力 | 戦略 | フィルタ |
| --- | --- | --- |
| 29.97 | `passthrough-29.97` | `fps=30000/1001:start_time=0` |
| 30 | `decimate-30` | 同上 |
| 23.976 / 24 | `telecine-3-2` | `fps=24000/1001:start_time=0,telecine=first_field=top:pattern=23` |
| 59.94 / 60 / 50 / 25 / その他 / VFR | `interlace-60i` | `fps=60000/1001:start_time=0,setfield=tff,separatefields,select=…,weave=first_field=top,fps=30000/1001:round=down,setfield=tff` |

- Policy は差し替え可能（`frameRatePolicy`）。`PROGRESSIVE_POLICY` は 60i の入力を 29.97p（`fps=30000/1001:start_time=0`）に置き換える。Beta で 59.94i に問題が出た場合の切り替え先で、ユーザー向けの設定としては公開しない。
- **Phase 2 からの変更**:
  1. **`start_time=0`**: VFR の 17 ms のずれの原因は、fps の時間軸（グリッド）が最初の映像タイムスタンプから始まることだった。映像が音声より 1 スロット（16.7 ms）遅れて始まる素材では、60i のフィールドの組がずれ、映像が 1 フィールド遅れる。時間軸の原点に固定して解消した（補正すべき差であり、正常な差ではない）。
  2. **`tpad=stop_mode=clone`**: fps フィルタは、ストリームの終わりを最後のフレームの開始時刻として扱い、最後のフレームを落とす。PoC の 30 / 59.94 / 23.976 の経路はこれで 1 フレーム短かった。元のフレーム長 1 つ分だけ最後のフレームを保持し、全戦略で元と同じ長さになることを確認した。
  3. 両パスとも `-fps_mode cfr -r 30000/1001`（pass 1 と pass 2 のフレーム数を一致させる）。
  4. 音声は `aresample=48000:async=1:first_pts=0` で時間軸の原点から始める。

### 音声（`profile/audio.ts`）

| 入力 | 処理 |
| --- | --- |
| 2ch | そのまま（ゲイン変更なし） |
| 1ch | `pan=stereo|c0=c0|c1=c0`（L = R = 元のレベル。`-ac 2` の -3 dB を避ける） |
| 5.1 / 5.1(side) | ITU-R BS.775 Lo/Ro（C と後方を -3 dB、LFE は使わない）。ダウンミックス後のピークを事前計測し、-1 dBFS を超える場合だけ固定ゲインで減衰（増幅はしない） |
| 音声なし | 無音の AC-3 Stereo 48 kHz 256 kbps（映像の終了時刻まで） |
| 4ch、7.1、その他の未検証のマルチチャンネル | **`UNSUPPORTED_AUDIO_LAYOUT`（変換不可）。推測でダウンミックスしない（v1 仕様）** |

ラウドネス正規化はしない。

### 映像

- 有効領域は TypeScript で計算し、`scale=W:H` + `pad=720:480:X:Y` の数値として渡す（16:9 → 720×480、4:3 → 540×480 @ x=90、9:16 → 226×480 @ x=246）。回転は ffmpeg の autorotate で反映し、解析側でも回転後の表示アスペクトを使う。
- 色: BT.709 入力は BT.601 に変換。タグなしは高さ 720 以上で BT.709 とみなす。
- **インターレースの入力**（Beta Hardening、M-5）: 解析は、最初の 30 フレームを復号したときの各フレーム自身のフラグ（`interlaced_frame`、`top_field_first`。スケーラーとエンコーダが見るもの）で `scan` を `progressive` / `tff` / `bff` / `unknown` に分ける。フレームが読めないときだけストリームの `field_order` を使い、`tt` / `bb` / `progressive` だけを信用する（`tb` / `bt` は demuxer によって逆の意味で使われる。MPEG-2 と MOV は上のフィールドが先のものを `tb` と書く）。以前は `field_order` を読むだけで使っておらず、1080i をフレームとして縮小して 2 つのフィールドを混ぜ（59.94 → 29.97 の瞬間）、BFF の 480i ではフィールドの順を逆にしていた（どちらも検証は合格）。出力の規則（29.97/30 → そのまま、23.976/24 → テレシネ、それ以外 → 59.94i、DVD は top field first）は変えていない。
  - フレームをそのまま通す戦略（29.97 / 30）: 各フィールドを別々に縮小（`scale=…:interl=1`）し、BFF は `fieldorder=tff` で先のフィールドを上に移す（元の解像度で 1 ライン動かす）。DVD のフィールドは元のフィールドそのもの（59.94/s）。
  - フィールドを瞬間から作る戦略（25 / 50i → 59.94i、テレシネ、`PROGRESSIVE_POLICY`）: 先に各フィールドを 1 フレームにする（`estdif`、空間だけの補間。時間方向に補間する `bwdif` はフィールドごとに変わる絵を混ぜた）。1080i のフィールドは 540 ラインで DVD の 480 ラインより多い。
  - プログレッシブと `unknown` はフィルタの文字列も含めて従来どおり。
- **HDR（v1 仕様）**:

  | 入力 | 扱い |
  | --- | --- |
  | SDR | 通常 |
  | HDR10 / HLG（互換ベースレイヤーを持つ Dolby Vision 8.x を含む） | Experimental：`HDR_TONEMAP_EXPERIMENTAL` 警告付きで SDR へトーンマッピング（`zscale` + `tonemap=hable`） |
  | Dolby Vision Profile 5（互換ベースレイヤーなし） | `UNSUPPORTED_HDR` |
  | 不明な HDR（既知の SDR 以外の伝達特性）・BT.2020 SDR | `UNSUPPORTED_HDR` |

  Core の `hdr: 'reject'` は残している（CLI では公開しない）。実素材で画質を評価していないため、「HDR 対応済み」とは扱わない。

### 容量（`capacity.ts`）

```text
TARGET_USABLE_BYTES = 4,550,000,000   (DVD+R SL 4,700,372,992 B より約 150 MB 少ない)
muxed_kbps = (TARGET × 8 / duration / 1000 − 50) / 1.012
video_kbps = min(8000, floor(muxed_kbps − 256))
warning: video_kbps < 3500   error: video_kbps < 1000
```

ディスク必要量: temp = 2 コピー分（title.mpg + VIDEO_TS）、出力 = 3 コピー分（VIDEO_TS + ZIP + ISO）、同一ボリュームなら最大 3 コピー分。いずれも +5% + 64 MB。

---

## 7. Verification

Phase 2 の 39 項目を移植し（一部は統合・分割）、A/V 同期、VOB 先頭の PTS、UDF 記述子の整合、ISO 内容のセクタ単位の照合などを加えた（Phase 3）。Phase 5.1 で、映像・音声・A/V のタイミングの分離、フィールドの時間情報、MPEG-2 のフレームレート、パケットに基づくストリームの判定を加えた。ID は安定した文字列で、`VERIFY_ERROR` の `reason` に並ぶ。項目の数は固定値として扱わない（`result.verification.checks`）。

| グループ | ID |
| --- | --- |
| VIDEO_TS | `videots.files` `videots.no_extra` `videots.sectors` `videots.bup_equals_ifo` |
| IFO | `ifo.vmg_id` `ifo.vts_id` `ifo.single_title` `ifo.region_free` `ifo.autoplay` `ifo.end_stop` `ifo.video_attributes` `ifo.audio_attributes` `ifo.vts_last_sector` `ifo.title_vobs_start` |
| VOB / MPEG-2 | `vob.packs` `vob.nav_packs` `mpeg2.sequence_header` `mpeg2.progressive_sequence` `mpeg2.gop` `vob.audio_pts_monotonic` `vob.av_start` `mpeg2.frame_rate` |
| Decode / Streams | `decode.full` `streams.video` `streams.audio` |
| Duration | `duration.video` `duration.audio` `duration.ifo`（±0.15 s。音声は +1 AC-3 フレーム） |
| Timing / fields | `sync.video_timeline` `sync.audio_timing` `sync.av_offset` `video.field_temporal` |
| ZIP | `zip.structure` `zip.entries` `zip.crc` `zip.content` |
| ISO | `iso.capacity` `iso.volume_id` `iso.bridge` `iso.udf_102` `iso.structure` `iso.file_order` `iso.ifo_addresses` `iso.content` `iso.mount` `iso.mount_udf` `iso.mount_files` `iso.mount_vob_readable` |
| Source | `source.unchanged` |

### 判定の状態

各項目は `status` を持つ。**`failed` だけが検証を失敗させる。**

| status | 意味 |
| --- | --- |
| `passed` | 検査して、合格 |
| `failed` | 検査して、不合格 |
| `unmeasurable` | 検査を試みたが、この動画では測れない（静止画、無音、周期的な音、元と対応付けられない映像） |
| `not_applicable` | 検査の対象がない（元に音声がない、Source fingerprint がない） |

`unmeasurable` は合格ではないが、失敗でもない。測れたずれは必ず判定する。Desktop の「測定できなかった項目」と CLI の「could not be measured」は `unmeasurable` の数。レポートは `videoTiming` / `audioTiming` / `relativeAvTiming` / `fieldTemporal` に、値と状態を持つ（ファイル名やパスは含めない）。

### 各項目の補足

- **Duration** は、デコードしたフレーム数と、plan の映像/音声の終了時刻（原点基準）で比較する。許容差を自動で広げることはしない。
- **Full decode** は `ffprobe -count_frames -count_packets -err_detect crccheck`（`ffmpeg -f null` は正常な DVD でも誤検出するため使わない）。
- **`mpeg2.frame_rate`**（M1、M5）: フレームレートは MPEG-2 の sequence header（すべての header の `frame_rate_code` が 4 = 30000/1001、**すべての** sequence extension の `frame_rate_extension` が 0/0、extension の数が header の数と一致）で判定し（Phase 5.1 までは最初の extension だけを見ていた）、VOB の picture start code の数がデコードしたフレーム数と一致することを確認する。ffprobe の `r_frame_rate` は先頭のタイムスタンプからの推定で、1〜2 枚の VOB では `60000/1001` になるため、判定に使わない（detail に参考として出す）。`streams.video` はコーデック・720×480・SAR・DAR だけを見る。
- **`streams.audio`**（M2）: ffprobe が列挙しただけでパケットを持たないストリーム（ペイロードのない PES ヘッダ。ffprobe は `mp2, 0 ch, 0 packets` と表示する）は数えない（detail に「ignored」として出す）。そのうえで、VOB の PES を走査し、ペイロードを持つ音声ストリームが private stream 1 の `0x80`（AC-3）ただ 1 つであることを確認する。ffprobe（パケット）と PES の走査の両方が一致しなければ失敗。2 本の実ストリーム、音声パケットの欠落はどちらも失敗する。
- **`iso.capacity`**（Beta Hardening、M-4）: 書き出した ISO ファイルのバイト数が DVD+R SL（`DVD_PLUS_R_SL_BYTES` = 4,700,372,992 B、2 種類の片面 1 層のうち小さいほう）以下であること。plan の見積もり（ビットレートを決めた根拠）ではなく、実際のファイルで判定する。超えれば `VERIFY_ERROR`（終了コード 3）で、ほかの検証の失敗と同じく出力は残らない。
- **ISO** は `iso/reader.ts` で読み戻す。全記述子のタグのチェックサム・CRC・位置、AVDP 2 つ、メインと予備の VDS の一致、UDF 1.02 のドメインとリビジョン、ISO 9660 のパステーブル（L/M）、ISO 9660 と UDF が同じ extent を指すこと、ファイル配置が IFO のアドレスどおりであること、ISO 内のファイル内容の sha256。
- **Mount** は macOS の platform adapter（`hdiutil attach -readonly`）。マウントできない環境では `unmeasurable`。
- **Source**: 本番では `size + mtime + inode + 先頭/末尾 4 MiB の sha256` で照合する（全体のハッシュは大きなファイルで重いため）。統合テストでは全体の sha256 でも確認している。

### タイミング（`verify/sync.ts`）

Phase 2 の 33 ms バグは、タイムスタンプは正しいまま、各画像が 1 フレーム遅れて表示されるものだった。そのため、タイムスタンプではなく**内容で**比べる。Phase 5.1 で、映像・音声・その差を別々に判定するようにした（以前は映像が測れないと A/V の判定ごと skip になり、静止画 + 100 ms の音声遅延が合格していた）。Phase 5.2 で、映像のタイミングを「絵が変わった時刻」の比較にした（下の 2）。

1. 5 か所（長さの 15/35/55/75/90%、短い動画は中央 1 か所。決定的）の区間で比べる。映像はフィールドの時間情報の検査（下の節）と同じデコード（出力のフィールドと、同じパリティの元の絵、64×48 の輝度）を使う。時刻は `-copyts` と各ファイルの原点から求める（`-ss` 後の時刻は VOB では信用できなかった）。
2. **映像**（`sync.video_timeline`）: **変化点**で比べる。元の側で、明確な変化（対応付けの残差の 3 倍以上）で区切られた一続きを 1 つの「瞬間」とする。同じ絵の繰り返し（60 fps のファイルに入った 15 fps の内容、スライドショー）や、見分けられない差は 1 つの瞬間にまとまる。瞬間ごとに、出力がその瞬間に**入った**最初のフィールドの時刻と、元でその瞬間が**始まる**時刻の組をとる。**戦略ごとの期待表示時刻**（`expectedDisplayTime`）を引く。29.97p 系は `round(t/G)·G`、60i は `round(t/(G/2))·G/2`、テレシネは 3:2（4 フレーム → 10 フィールド、開始フィールド 0/2/5/7）。値 = 中央値（出力時刻 − 出力の映像開始タイムスタンプ − 期待表示時刻）。変化点が 8 未満なら `unmeasurable`。
   - **精度を作らない**: 同じ絵の複数のフレームのうち、どれが「最も似ている」かは雑音で決まり、時刻の情報を持たない（Phase 5.1 までの方式はこれを時刻として使い、15 fps の内容で +16.7 ms の誤った失敗を出した。H3）。変化点だけを時刻として使う。
   - 出力の直前のフィールドが対応付けられない、または後の瞬間を示す場合、入った時刻は分からないので使わない。
   - 複数フレームの瞬間は、戦略が元のフレームをすべて見せる場合（元のフレームレート ≤ temporal capacity × 1.01）だけ使う。元のフレームを間引く戦略（120 fps → 60i、`PROGRESSIVE_POLICY` の 60 → 29.97p）では、瞬間の最初のフレームが正しく間引かれることがあり、始まりの時刻が決まらないため。1 フレームの瞬間は従来どおり使う。
   - fps の値による特別扱いや、閾値の変更はしていない。
3. **音声**（`sync.audio_timing`）: 8 kHz モノラルで ±250 ms の相互相関をとる。ピークが一意でない区間（持続音、周期が探索範囲より短い音、無音）は採用しない。一意な区間が 2 つ以上あれば、値 = 中央値（音声の出力時刻 − 元の時刻）− 出力の映像開始タイムスタンプ。DVD プレーヤーが同期の基準にする映像ストリームの開始時刻に対する、音声の位置である。**映像が測れなくても判定する。**元に音声がなければ `not_applicable`。
4. **A/V の差**（`sync.av_offset`）= 映像の値 − 音声の値。両方が測れたときだけ判定し、片方でも測れなければ `unmeasurable`。
5. **探索範囲の外のずれ**（Beta Hardening、M-3）: 以前は、映像・音声が 250 ms を超えてずれると探索範囲に一致がなく、`unmeasurable` として合格していた（長さを保ったまま ±400 ms ずらした故障が、モーション素材・testsrc2・ノイズ音声のすべてで合格）。±1 s（`WIDE_SEARCH_SEC`）も探すが、**許容範囲を広げるためではなく**、範囲の外に一致があることを見つけるためだけに使う。許容差（10 ms）は変えていない。
   - 映像: 元のフレームを ±1.1 s 分デコードする。構造のあるフィールドのうち、±250 ms の外にだけ一致（`MIN_NCC` 以上）があり、±250 ms の中の最良の一致がそれより明確に遠い（瞬間の境界と同じ基準：3 倍、最低 0.01）ものを「ずれて表示されたフィールド」とする。ある区間でそれが 12 以上かつ構造のあるフィールドの半分以上なら `sync.video_timeline` は失敗（「picture about +400 ms: … fields show source pictures found only more than 250 ms away」。値はフィールドと元のフレームの対応からの概算）。正しい出力では、正しい元のフレームが必ず ±250 ms の中にあるので、この条件は成り立たない。周期的な絵でも、同じ絵が ±250 ms の中にあるので成り立たない。
   - **時間は表示区間で測る**（BH-H2）: 元のフレームの時刻は「表示が始まる点」ではなく、次のフレームまでの表示区間 [開始, 終了] として扱う。フィールドと元のフレームの距離は、区間の中なら 0、前なら開始まで、後なら終了まで。±250 ms の探索と ±1 s の探索の両方に使う。以前は開始時刻だけで測ったため、VFR で長く表示されるフレーム（画面収録やスライドショーのような、絵が変わったときだけフレームのある動画）の正しい出力が、保持の途中で「250 ms より離れた所にだけ一致」とされて `VERIFY_ERROR` になっていた（M-3 の修正で入った。30 fps の動きを 15 / 30 / 45 フレームに 1 枚だけ残した VFR で、+372〜+589 ms、360 フィールド中 146〜246）。区間の終わりは、次に復号したフレームの時刻。区間の最後のフレームだけは、そのフレーム自身の長さ（コンテナのサンプルの長さ）。時刻が増えない、長さがない・0 以下のときは区間を作らず点とする（壊れた時刻を長い保持と解釈しない）。許容差（10 ms）と探索範囲（±250 ms、±1 s）は変えていない。構造のない絵は、保持されていても証拠にしない（BH-H1）。
   - 音声: ±250 ms で一意なピークがない区間だけ、同じ基準（0.5 以上、次点より 0.1 以上高い）で ±1 s を探す。周期的な音は ±1 s でも一意にならず、`unmeasurable` のまま（1 秒ごとのクリックを 400 ms ずらしたものは、+400 ms と −600 ms のどちらとも取れる）。
   - ±1 s を超えるずれや、元と無関係な内容は、内容の検査では判定しない（§11）。何にも一致しない場合に「欠落」と判定するには、一致の近さの固定の基準が要る。HDR のトーンマッピングでは正しい出力でも残差が大きい（合成サンプルで明確な変化が 0）ため、そうした基準は置かなかった。
6. **繰り返す絵**（Beta Hardening、M-2）: 元で同じ絵が ±250 ms の中に別の瞬間として何度も現れる（周期的な点滅や動き）と、フィールドはそのどれとも同じように一致し、以前は最も早いものを時刻にしていた（正しい 5 Hz の点滅が +200 ms で `VERIFY_ERROR`、coverage も 0.45〜0.76）。元の側だけで、同じ絵（瞬間を分けるのと同じ基準で区別できない絵）が ±250 ms の中に別の瞬間として現れる瞬間を「繰り返す瞬間」とし、時刻・coverage・順序の証拠にしない。出力がそうした絵に切り替わる所では、その絵の近くの**すべての**開始時刻を候補にする。最も近い候補でも許容差（10 ms）を超えるなら、どの解釈でも時刻がずれているので失敗（「picture off by at least … ms」）。どれかが合えば、それは「合っている」証拠ではなく `unmeasurable`（最も早い候補が合ったことを合格の理由にしない）。明確な変化点が 8 以上あれば、それだけで判定する。
   - 実測: 30 fps で 2 / 6 / 12 フレーム、59.94 fps で 4 / 6 / 12 フレーム、23.976 fps と 25 fps で 5 フレームごとに繰り返す素材（音声はノイズ）の正しい変換はすべて合格。繰り返しが 250 ms 以下のものは映像のタイミングが `unmeasurable`、400 ms のものは測れて 0 ms。200 ms 周期の素材に 33 ms の遅れ・+300 ms のずれを入れると `VERIFY_ERROR`、ちょうど 2 周期（400 ms）ずらしたものは正しい出力と区別できず `unmeasurable`、音声を 400 ms ずらすと音声で `VERIFY_ERROR`。
   - 検証の時間（60 s の回帰サンプル）: standard-16x9 3.8 → 6.9 s、fps-59.94 5.1 → 9.8 s、fps-23.976 3.2 → 5.9 s（元の映像のデコードが広くなったことと、音声の広い探索）。

閾値はどれも **10 ms**（`SYNC_TOLERANCE_MS`、`AUDIO_TIMING_TOLERANCE_MS`）で、次の実測に基づく（Phase 5.1・5.2 で緩めていない）。

| ケース | 映像 | 音声 | A/V の差 | 結果 |
| --- | --- | --- | --- | --- |
| 59.94 → 60i（正しい） | 0 | 0 | 0 | PASS |
| VFR（映像が 1/60 s 遅れて開始）→ 60i（正しい） | 0 | 0 | 0 | PASS |
| 30 → 29.97（正しい） | 0 | 0 | 0 | PASS |
| 59.94 → 29.97p（`PROGRESSIVE_POLICY`） | 0 | 0 | 0 | PASS |
| 静止画 + クリック（正しい） | 測定不能 | 0.1 ms | 測定不能 | PASS |
| **Phase 2 の 33 ms バグ**（weave 後 `round=near`） | **33.4 ms** | 0 | **33.3 ms** | VERIFY_ERROR |
| 同上・音声なし | **33.4 ms** | 対象外 | 対象外 | VERIFY_ERROR |
| **VFR の開始時刻バグ**（`start_time=0` なし） | **16.7 ms** | 0 | **16.6 ms** | VERIFY_ERROR |
| **FI-AUDIO-DELAY-STATIC**（静止画 + クリック / ノイズ、音声の内容を 100 ms 遅らせる） | 測定不能 | **100 ms 遅れ** | 測定不能 | VERIFY_ERROR |
| 動く映像 + クリック、音声を 100 ms 遅らせる | 0 | **100 ms 遅れ** | **−100 ms** | VERIFY_ERROR |
| 静止画 + 0.2 s 周期のパルス / 440 Hz の持続音 / 無音 | 測定不能 | 測定不能 | 測定不能 | PASS |
| 同上のパルスを 100 ms（半周期）遅らせる | 測定不能 | **測定不能**（誤ったずれを主張しない） | 測定不能 | PASS |
| **REG-LOW-MOTION**: 30 / 15 / 10 / 6 fps の内容を 60 fps・59.94 fps のファイルに入れたもの（モーション素材と testsrc2、正しい変換） | 0（変化点 150 / 75 / 50 / 30） | 0 | 0 | PASS（Phase 5.1 では testsrc2 の 15 fps が +16.7 ms で VERIFY_ERROR） |
| **REG-SLIDESHOW**: 写真 3 枚 × 3 s（カット / 1 s のクロスフェード） | 測定不能（変化点が少ない） | 0 | 測定不能 | PASS |
| 同上 + 音声を 100 ms 遅らせる | 測定不能 | **100 ms 遅れ** | 測定不能 | VERIFY_ERROR |
| 33 ms バグ / VFR 開始時刻バグを 60 / 30 / 15 / 10 / 6 fps の内容の素材（上と同じ 18 種類、映像が 1/60 s 遅れて開始）に入れたもの | **+16.7 ms**（全ケース） | 0 | — | VERIFY_ERROR（全 36 ケース） |
| 33 ms バグ、15 fps の内容（開始の遅れなし） | **+33 ms** | 0 | — | VERIFY_ERROR |

PoC サンプルの回帰（§13）では、正しい出力の値はすべて 0〜0.6 ms だった。

- AC-3 エンコーダの遅延（256 サンプル = 5.3 ms）のため、VOB の音声タイムスタンプは映像より 5.3 ms 早く始まる。内容は揃っており、音声の値は 0（`vob.av_start` はこの差を ±34 ms で確認している）。

### フィールドの時間情報（`verify/fields.ts`、`video.field_temporal`）

59.94i は 29.97 フレーム/秒の中に約 59.94 フィールド/秒の異なる瞬間を持つ必要がある。第三者レビューでは、60p を 29.97p に間引いたまま `interlace-60i` と名乗る故障を注入し、残った画像はすべて正しい時刻に出るため、タイミングの検査だけでは合格していた（動きの半分が失われている）。

**生成側から独立した Oracle**: `frame-rate.ts`（フィルタも `expectedDisplayTime` も）を使わず、デコードも別に行う。

1. 同じ 5 か所の区間で、出力の各フレームを有効領域で切り出し、`field=top` / `field=bottom` で 2 つのフィールドに分ける。表示順は各フレーム自身のフィールド順フラグ（`showinfo` の `i:T` / `i:B`）で決める。
2. 元の各フレームは有効領域の大きさに縮小し（plan の入力色行列 → BT.601。色の違う輝度で比べないため）、同じく上下のラインに分ける。出力のフィールドは同じパリティの元の絵と比べる（全フレームと半分の高さのフィールドを比べると、細かい模様で残差が大きくなり、判定できなかった）。
3. 各フィールドを ±250 ms 内で最も似た元フレームに対応付ける。
4. 元の側だけで「瞬間」を数える。隣のフレームとの差が対応付けの残差（中央値）の 3 倍（最低 0.01）以上のところで新しい瞬間が始まる。同じ絵の繰り返しや、見分けられない小さな差は 1 つの瞬間にまとまる（Phase 5.2）。前後とも明確な変化で区切られた瞬間を「明確な瞬間」とする。わずかな動きは、推測せずに数えない。
5. **coverage** = フィールドに現れた明確な瞬間 ÷ 正しい出力が見せるべき数。後者は、戦略が運べる瞬間の数（**temporal capacity**: 60i は 59.94/s、3:2 は 23.976/s、29.97p 系は 29.97/s。DVD の性質であり、生成側の対応付けではない）で上限を切る。
6. **順序**: 連続するフィールドの対応先が過去に戻る割合（backward ratio）。フィールド順の取り違えを検出する。

**構造のない絵は証拠にしない**（Beta Hardening、BH-H1）: 黒・白・一様な色の絵は正規化するとゼロベクトル、ほぼ黒のノイズやグレインは乱数のベクトルになり、どちらも毎フレーム「新しい瞬間」に見えていた。出力のフィールドはそれに一致しないため coverage が下がり、黒へのカットや黒を経由するフェードがサンプリング区間に重なると、正しい変換が `VERIFY_ERROR` になっていた（モーション素材・testsrc2・実写の `opening-movie` で再現）。64×48 のライン群の**空間的にまとまった構造**（隣の画素との自己共分散。相関のないグレインや 8 bit の丸めは寄与しない）が `MIN_STRUCTURE` = 1 レベル未満なら、その絵は時刻の証拠にしない。一致にも不一致にも数えず、瞬間を作らず、coverage の分母にも入れない（前後の構造のある絵どうしを比べる）。区間の全部がそうなら、その区間は証拠を出さず、ほかの区間で判定する。1 レベルは、丸め誤差（片側 0.29）の 3 倍（0.87）未満では完全に同じ絵でも `MIN_NCC` に届かないことから決め、次の実測で確認した。

| 素材（検証と同じ復号、フィールドごと） | まとまった構造（8 bit レベル） |
| --- | --- |
| 黒・白・一様なグレー | 0 |
| ほぼ黒のノイズ、グレー + グレイン（1080p〜240p） | 0.1〜0.8（エンコードできないほど強い 240p のグレインだけ 1.5 まで） |
| testsrc2 をグレーにして明暗を 1/40（y = 16 + val/40） | 1.7 |
| 同上 + グレイン、暗い 480p + グレイン | 1.4〜2.9 |
| 黒地の小さなタイトル | 3.0 |
| グラデーション | 7 以上 |
| 回帰サンプルすべて（実写を含む） | 56 以上 |

暗くても構造のある絵は測る（グレーの testsrc2 を 1/20 にしたもの：タイミング・フィールドとも `passed`）。1/40 まで暗いと、構造は 1 レベルを超えるが動きが丸め誤差に埋もれ、Phase 5.2 の規則（明確な変化がない）で `unmeasurable`。黒を含む素材でも、33 ms の遅れと 60i の間引きは従来どおり `VERIFY_ERROR`。

| 状態 | 条件 |
| --- | --- |
| `failed` | coverage < 0.8、または backward ratio > 0.1。全区間の合計と、証拠が十分な区間（見せるべき瞬間、またはフィールドの変化が 12 以上）ごとの両方で判定する（1 区間だけの欠落が、ほかの区間で薄まらないように。Phase 5.2） |
| `unmeasurable` | 対応付けられたフィールドが半分未満、または明確な瞬間が 24 未満（静止画・ほとんど動かない映像・構造のない絵だけ） |
| `passed` | それ以外 |

閾値は次の実測に基づく（Phase 5.1）。

| ケース | coverage | backward | 結果 |
| --- | --- | --- | --- |
| 23.976 / 24 → 3:2、25 / 50 / 59.94 / 60 / 120 / VFR → 60i、29.97 / 30 → 29.97p、59.94 → `PROGRESSIVE_POLICY`（モーション素材と testsrc2、4:3、縦、回転） | 1.000 | 0 | PASS |
| **FI-60I-TEMPORAL-LOSS**（60p → 29.97p に間引いて `interlace-60i` と名乗る、16:9 / 4:3 / testsrc2） | **0.505** | 0 | VERIFY_ERROR |
| **FI-60I-FIELD-ORDER**（上下のフィールドを入れ替え） | 1.000 | **0.51** | VERIFY_ERROR |
| 静止画（正しい出力も、上の間引きも） | — | — | 測定不能（失うものがない） |
| 20 s の動画で、2 番目の区間（6.4〜7.6 s）の間だけ間引き（Phase 5.2） | 全体 0.90、その区間 **0.5** | 0 | VERIFY_ERROR（Phase 5.1 では全体の値だけで判定し PASS） |
| 同上で、区間の間（4.0〜5.5 s）だけ間引き | 1.000 | 0 | PASS（**見ていない**。§11） |

- **インターレースの元**（M-5）: 検証は、元のフレームがインターレースかを自分で調べ（ffprobe の `interlaced_frame`。解析とは別の実装）、そうなら元の各フィールドを `separatefields` でそれぞれの時刻の 1 枚として比べる。フレームをそのまま通す戦略の temporal capacity は 59.94/s、期待表示時刻はフィールド単位になる。これでフィールドの順の取り違え（BFF の逆転、フィールドの入れ替え）は `video.field_temporal` の backwards で失敗する。2 つのフィールドを混ぜた出力は、どの元のフィールドにも近くないため `unmeasurable` になり、本番の検証では失敗にならない（§11。テストでは独立したフィールド列の読み取りで確認している）。
- サンプリング: 区間の位置は長さに対する固定の割合（乱数なし、毎回同じ結果）。各区間では、その中のすべてのフィールドを調べる（特定の位相のフィールドだけを見ることはない）。H1 のような戦略全体の欠落は、どの区間にも現れる。区間は合計 6 s（20 s の動画で 30%、20 分で 0.5%）で、区間の外の部分的な故障は見えない（§11）。
- メモリ: 区間ごとに 64×48 の輝度（元 約 2 s 分、出力 1.2 s 分）だけを持ち、区間の統計を足し合わせる。全フレームを保持しない。
- 時間: 区間の読み込みは `-ss` + 入力側の `-t` で区間だけにする（フレーム数の上限で読むと 29.97 fps で約 11 s 分をデコードしていた）。元は有効領域の大きさへ縮小（色の変換を含む）してから 64 列に狭める（1920 → 64 を 1 回で縮小すると、細かい模様のぼけ方が出力と違い、動きが見えなくなった）。同じ出力で比べた検証全体の時間（Phase 5.1 前 → 後、M1 Mac）: standard-16x9（1080p 60 s）3.6 → 6.4 s、fps-59.94 3.2 → 7.8 s、m-60000_1001 1.3 → 3.7 s、long-20min-noise 33.2 → 36.0 s。Node 側のメモリは増えない（子の ffmpeg を含む最大 RSS は 1080p の 20 分で 156 → 235 MB）。

---

## 8. ISO Writer（`iso/writer.ts`）

DVD-Video 専用。汎用 ISO ライブラリではない。

```text
0-15      system area（ゼロ）
16        ISO 9660 PVD            17  terminator
18-20     BEA01 NSR02 TEA01
32-37     UDF main VDS: PVD, IUVD("*UDF LV Info"), PD("+NSR02", read-only), LVD("*OSTA UDF Compliant" rev 0x0102, type 1 map), USD, TD
48-53     reserve VDS（同内容）      64-65  LVID(close) + TD
256       AVDP
257-      partition: FSD, TD, root/AUDIO_TS/VIDEO_TS の FE + FID, 各ファイルの FE
          ISO 9660 L/M path table, root / AUDIO_TS / VIDEO_TS ディレクトリ
          VIDEO_TS.IFO … IFO が指定するオフセットに各ファイル（隙間はゼロ）
N-1       AVDP
```

- ファイル配置は `dvd/layout.ts` が IFO（VMG last sector、TT_SRPT の VTS 開始セクタ、VTS last sector、title VOBS 開始位置）から計算する。menu VOB や想定外のファイルは拒否する。
- 各ファイルは 1 extent（UDF short_ad の上限を超える場合はセクタ境界で分割するが、dvdauthor の VOB は 1,073,709,056 B で上限内）。
- タイムスタンプは `now`（ジョブ開始時刻、テストでは固定値）で、出力は決定的。
- **Reference との比較**（統合テスト）: 同じ VIDEO_TS から mkisofs `-dvd-video` で作った ISO と、ファイル・サイズ・IFO 基準の配置・FE の種類・パーミッション、ISO 9660 の Volume ID とディレクトリ、UDF の Volume ID・論理ボリューム ID・ドメイン・リビジョン・アクセスタイプ・ブロックサイズ・パーティション開始位置・VDS の構成・VRS が一致することを確認した。バイト単位の一致は求めていない（タイムスタンプ、Implementation ID、パーティション長、ISO 9660 構造の位置が異なる）。
- `isoinfo`（cdrtools の独立実装）で同じ extent が読めること、macOS で UDF としてマウントでき中身が一致することも確認した。
- **物理プレーヤーでの互換性は未検証**。Beta では mkisofs 版と自前版の両方を焼いて比べることを推奨する。

---

## 9. Lock と platform

- `acquireLock()`: `<os.tmpdir()>/mp4-to-ifo/conversion.lock` を `O_EXCL` で作る。中身は `{ token, pid, hostname, processStart, createdAt }`。30 s ごとに mtime を更新する。
- stale と判断する条件: PID が存在しない / PID は生きているが起動時刻が違う（PID の再利用）/ 起動時刻が取れない場合は、更新が 5 回分（150 s）途絶えたとき。PID だけでは判断しない。
- 奪取: 古いファイルを一意の名前に rename してから、再度 `O_EXCL` で作る。解放は自分の token のときだけ削除する。
- **v1 の仕様: Single conversion per macOS user.** 同じ macOS ユーザーの中で GUI ↔ GUI、GUI ↔ CLI、CLI ↔ CLI を排他する（macOS の `os.tmpdir()` はユーザーごと）。別の macOS ユーザー間の排他は v1 の要件に含めない。`lock.dir` で共有の場所を指定する拡張の余地は残している。
- スリープ抑止: macOS は `caffeinate -i -w <pid>`（システムのスリープだけを防ぎ、ディスプレイのスリープは許可。親プロセスが落ちると自動で終了）。
- `PlatformAdapter` は `preventSleep` / `processStartTime` / `mountImage`。macOS 以外は null adapter。

---

## 10. Tests

```bash
npm test                                            # unit + integration（LGPL 版 FFmpeg があれば優先）
npm run test:regression -w @mp4-to-ifo/core         # samples/ を使う回帰（output/core-regression/results.json）
npm run typecheck && npm run build
```

- **Unit**: 命名、Volume Label、出力名の閉じ込め（`safeChildPath`）、ビットレート・容量、フレームレートの分類と Policy、期待表示時刻のモデル、GPL フィルタの不使用、音声プランとクリップ保護、有効領域、HDR の判定、VFR の判定、エラーの対応付けとリダクション、CRC-16 / タグ / dstring、ZIP の往復と CRC 検出、finalize の採番と非上書き、プランの警告・エラー、同期照合のロジック、フィールドの時間情報の Oracle（合成データ：全瞬間、半分の欠落、フィールド順、戦略の上限、静止画は測定不能）、パケットと PES による音声ストリームの判定、音声の曖昧さの判定、ロック（取得・競合・死んだ PID・PID の再利用・生存中・heartbeat・他人のロックを消さない）。
- **Integration**: 実行時に生成する素材（FFmpeg のネイティブエンコーダのみ）で、解析、全体の変換（日本語・空白入りの名前、進捗、`-2`、元ファイルの sha256 / サイズ / mtime、`unzip -t`、`isoinfo`、mkisofs Reference との構造比較、macOS マウント、`planDigest` の一致と不一致）、全フレームレート戦略のフィールド単位の実測（`test/helpers/motion.ts`、元のデコード結果を基準にする独立した計測）、**Phase 2 のタイミングバグの回帰**（旧チェーンを Policy として差し込むと `VERIFY_ERROR`：33 ms バグは音声あり・なしの両方、VFR の開始時刻バグ）、**Phase 5.1 の回帰**（`test/integration/verify-hardening.test.ts`：FI-60I-TEMPORAL-LOSS、FI-60I-FIELD-ORDER、FI-AUDIO-DELAY-STATIC と静止画・無音・周期音の組み合わせ、1〜3 フレーム・0.5 s・1 s の短い入力、幻の音声ストリーム・2 本の音声・音声の欠落）、音声（過大な 5.1、通常の 5.1、モノラル、音声なし）、キャンセル、故障注入（VOB 破損、リージョンマスク、BUP 不一致、BUP 欠落、UDF 記述子の破損、ISO 内データの破損、ZIP 破損）、LGPL ビルドの点検、古いジョブの掃除。
- 件数は固定値として書かない（`npm test` の出力を参照）。
- **Phase 5.2 の回帰**（`test/integration/verify-robustness.test.ts`）: REG-LOW-MOTION-30 / 15 / 10 / 6（モーション素材と testsrc2）、REG-SLIDESHOW（カット・クロスフェード）、スライドショー + 100 ms の音声遅延、低動作素材と通常の素材での 33 ms バグと VFR 開始時刻バグ、sequence extension の最初・2 番目・中央・最後の破損、1 区間だけの間引き。出力フォルダの M6（`convert.test.ts`: シンボリックリンク、確認後のリンク付け替え、フォルダの置き換え、変換中の置き換え、出力先の変更）。
- **Beta Hardening の回帰**: BH-H1（`verify-robustness.test.ts`: モーション素材と testsrc2 の黒へのカット・ほぼ黒のグレインへのカット・黒を経由するフェードが合格し、タイミングを測れること。一様な白・グレーは `unmeasurable`、暗くても構造のある絵は測れること。黒を含む素材でも 33 ms の遅れ・60i の間引き・出力が黒になる故障は `VERIFY_ERROR`。回帰の `samples.test.ts` で実写の `opening-movie` にフェードを入れたもの）、M-2（`verify-timing-range.test.ts`: 上の 8 種類の繰り返す素材、繰り返しでは説明できない故障、2 周期のずれ、音声の故障、400 ms 周期での 60i のフィールド順・間引き）、M-5（`interlaced.test.ts`: TFF / BFF の 1080i 29.97、BFF の 480i、TFF の 1080i 30、TFF 1080i / BFF 576i の 25（50 フィールド/s）、プログレッシブ。出力の各フィールドのコードを独立に読み、元のフィールドがすべて順に 1 回ずつ、混ざらずに出ること。フィールドの入れ替えは `VERIFY_ERROR`）、BH-H2（`verify-timing-range.test.ts`: 15 / 30 / 45 フレームごとの保持、短い不規則な保持、短い・長い保持の交互、2.5 s の保持、複数の保持区間、区間の端をまたぐ保持が合格。保持された黒・グレー・暗い絵。保持のある素材で絵を 400 ms 遅らせると `VERIFY_ERROR`）、M-3（`verify-timing-range.test.ts`: 長さを保ったまま映像を ±400 ms（モーション素材・testsrc2）、音声を ±400 ms（ノイズ）ずらすと `VERIFY_ERROR`、同じ素材の正しい変換は合格）、M-4（`iso.capacity`）。
- **Mutation check**: `node scripts/mutation-check.mjs`。検証の修正を 1 つずつ無効にした Core のコピーでテストを実行し、各修正を守るテストが失敗することを確認する（Phase 5.2 で 17 種類すべて検出）。
- **故障注入の方法**: フレームレートの故障は `frameRatePolicy`、音声の故障は最終エンコードの引数だけを書き換える ffmpeg のラッパー（`test/helpers/fault.ts`）、ストリーム構造の故障は VOB のバイトを直接書き換える。どれも Core には手を入れない。
- **Regression**: §13。

---

## 11. Known limitations

1. **Physical DVD playback compatibility has not been verified**（59.94i、Hard Telecine、自前 ISO/UDF、DVD-R / DVD+R）。
2. ロックは macOS ユーザーごと（§9、v1 仕様）。
3. 音声は、なし・モノラル・ステレオ・5.1 のみ（v1 仕様。PoC は他の構成も ffmpeg の行列で変換していた）。
4. HDR は Experimental（v1 仕様、§6）。実素材での評価は未実施。
5. 内容による検査は素材に依存する。静止画やほとんど動かない映像、構造のない絵（黒・一様な色・グレイン）では、映像のタイミングとフィールドの時間情報が `unmeasurable`。無音・持続音・探索範囲（±250 ms）より短い周期の音では、音声のタイミングが `unmeasurable`。両方が測れない素材では、タイミングは構造の検査（`vob.av_start`、長さ）だけで確認している。±250 ms〜±1 s のずれは広い探索で失敗にする（§7）が、±1 s を超えるずれは内容の検査では判定しない。
6. **孤児プロセス**: 変換中のプロセスが `kill -9` 等で強制終了すると、子の ffmpeg は動き続ける（Phase 4 で実測。`SIGTERM` にもすぐには反応しなかった）。ロックと job フォルダは次回の実行で回収される（`cleanupStaleJobs()` / stale 判定、実測で確認）。子プロセスの監視などの根本対策は、プロセスの生存期間を管理する Desktop（Phase 5）で行う。
7. 配布用の LGPL FFmpeg（zimg の静的リンク、署名、ソース提供）と dvdauthor の Sidecar 構成は Phase 5 以降。
8. **Zip64**: 4 GB を超える ZIP は Zip64 で書く。Phase 4 で `zip64: 'always'`（小さなデータで Zip64 のレコードを強制する）を追加し、自前リーダーと Info-ZIP `unzip -t` で読めることを確認した。Beta Hardening で 4 GB を超える実データ（容量上限に近い 80 分の出力と、エントリの位置が 4 GiB を超える ZIP）を、`unzip -t`・Python・`ditto`・Archive Utility で確認した（docs/release.md §13.3）。Windows での展開は未確認。
9. 内容の検査は 5 か所（長さの 15〜90%、各 1.2 s、合計 6 s）の区間だけを見る。区間の間にある部分的な故障は見えない（実測: 20 s の動画で 4.0〜5.5 s だけの 60i の間引きは PASS）。区間の中の故障は、区間ごとの判定で検出する（Phase 5.2）。区間を増やす、長さに応じて変える、などの改善は未実施（全編の比較は、20 分以上の動画の検証時間に見合わないため行わない）。
10. HDR（トーンマッピングあり）の入力では、元と出力の輝度が非線形に違うため、内容の対応付けが `unmeasurable` になり得る（実素材での評価は未実施）。
11. **インターレースの入力で 2 つのフィールドを混ぜる故障**は、本番の検証では `unmeasurable` で、失敗にならない（混ざったフィールドはどの元のフィールドにも近くない。固定の近さの基準は置いていない、§7 M-3）。フィールドの順の誤りは失敗になる。混ぜないことは、変換側（`interl=1`、`fieldorder`、`estdif`）とテストの独立した読み取り（`interlaced.test.ts`）で確認している。
12. **インターレースとして記録されたプログレッシブ（PsF）**: 解析はフレーム自身のフラグで判断するため、中身がプログレッシブでもインターレースのフラグが付いていれば（例: PAL SD の 25PsF）、各フィールドを別々に扱う（M-5）。1080 ラインの素材ではフィールドが 540 ラインあり失うものはないが、576 ラインの素材では縦の細部が落ちる。フラグだけでは真のインターレースと区別できないため、Public Beta 後の改善候補とし、今回は変えていない。
13. **短すぎる入力**: DVD の 1 フレーム（約 1/30 s = 33.3 ms）より短い動画は、DVD のフレームが 1 枚もできず、dvdauthor が失敗する（`AUTHOR_ERROR`、出力は残らない）。実測（Phase 5.1）: 50 fps の 1 フレーム（20 ms）、120 fps の 1・3 フレーム（8.3 / 25 ms）は失敗。29.97 / 30 fps の 1 フレーム、50 fps の 2 フレーム、60 fps の 2 フレーム、120 fps の 4 フレーム（33.3 ms）以上、23.976 / 25 fps の 1 フレームは変換・検証に合格。23.976〜30 fps は 1 フレームでも変換できるので、影響するのは 59.94i の経路（50 fps 以上、VFR）の 1〜3 フレームの動画だけ。生成側の仕様は変えていない。README の Unsupported input に記載。

---

## 12. Phase 4 での Core の変更

CLI のために次を追加した（変換仕様は変えていない）。

| 変更 | 理由 |
| --- | --- |
| `package.json` の exports に `development` 条件（`./src/index.ts`） | ワークスペース内の開発・テストで、ビルドせずに Core のソースを使う。配布物には含まれない |
| `nextOutputDirectory(dir, name)` | 変換前のサマリーに実際の出力先（`-2` 等）を表示するため。命名の規則は Core に残す |
| HDR の `unknown`（既知の SDR 以外の伝達特性 → `UNSUPPORTED_HDR`） | v1 仕様「Unknown HDR → Unsupported」の実装 |
| ZIP の `zip64: 'always'` | 4 GB のデータを作らずに Zip64 の構造をテストするため |

## 13. Regression（PoC samples）

`npm run test:regression`（LGPL 版 FFmpeg 7.1、`requireLgpl: true`）で Phase 2 の全サンプルを Core で変換した。結果は `output/core-regression/results.json`（Git 管理外）。下の表は Phase 5.2 の検証での結果（映像の長さ・音声の長さ・gain は Phase 3 の結果と同じ。PoC との比較は Phase 3 で行った）。

| Sample | 戦略 | 検証（passed / 全項目） | 映像 s（期待値） | 音声 s | 映像 / 音声 / A/V の差 ms | フィールド coverage / backward | gain dB | 処理時間 / うち検証 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| standard-16x9 | passthrough-29.97 | 46/48（測定不能 2） | 60.027 (60.027) | 60.032 | 0 / — / — | 1 / 0 | 0 | 45 s / 4.2 s |
| aspect-4x3 | passthrough-29.97 | 46/48（測定不能 2） | 19.987 (19.987) | 20.032 | 0 / — / — | 1 / 0 | 0 | 14 s / 3.0 s |
| vertical-1080x1920 | passthrough-29.97 | 46/48（測定不能 2） | 19.987 (19.987) | 20.032 | 0 / — / — | 1 / 0 | 0 | 12 s / 3.0 s |
| rotated-90 | passthrough-29.97 | 46/48（測定不能 2） | 20.120 (20.087) | 20.032 | 0 / — / — | 1 / 0 | 0 | 13 s / 3.3 s |
| fps-30 | decimate-30 | 46/48（測定不能 2） | 19.987 (20.000) | 20.032 | 0 / — / — | 1 / 0 | 0 | 19 s / 4.0 s |
| fps-59.94 | interlace-60i | 46/48（測定不能 2） | 19.987 (19.987) | 20.032 | 0 / — / — | 1 / 0 | 0 | 34 s / 5.9 s |
| fps-23.976 | telecine-3-2 | 46/48（測定不能 2） | 19.953 (19.978) | 20.032 | 0 / — / — | 1 / 0 | 0 | 15 s / 3.5 s |
| audio-5.1 | passthrough-29.97 | 46/48（測定不能 2） | 19.987 (19.987) | 20.032 | 0 / — / — | 1 / 0 | 0 | 19 s / 4.0 s |
| audio-5.1-loud | passthrough-29.97 | 46/48（測定不能 2） | 10.010 (10.010) | 10.016 | 0 / — / — | 1 / 0 | -6.59 | 8 s / 2.7 s |
| audio-mono | passthrough-29.97 | 46/48（測定不能 2） | 10.010 (10.010) | 10.016 | 0 / — / — | 1 / 0 | 0 | 8 s / 2.5 s |
| no-audio | passthrough-29.97 | 46/48（対象外 2） | 20.020 (20.020) | 20.032 | 0 / 対象外 / — | 1 / 0 | 0 | 18 s / 3.5 s |
| motion/m-60000_1001 | interlace-60i | 48/48 | 19.987 (20.003) | 20.032 | 0 / 0 / 0 | 1 / 0 | 0 | 23 s / 3.5 s |
| motion/m-50 | interlace-60i | 48/48 | 19.987 (20.000) | 20.032 | 0 / -0.1 / 0.1 | 1 / 0 | 0 | 19 s / 2.9 s |
| motion/m-25 | interlace-60i | 48/48 | 19.987 (20.000) | 20.032 | 0 / 0 / 0 | 1 / 0 | 0 | 11 s / 1.9 s |
| motion/m-24000_1001 | telecine-3-2 | 48/48 | 20.020 (20.020) | 20.032 | 0 / 0 / 0 | 1 / 0 | 0 | 10 s / 1.9 s |
| motion/m-vfr | interlace-60i | 48/48 | 19.987 (19.916) | 20.032 | 0 / -0.1 / 0.1 | 1 / 0 | 0 | 15 s / 2.6 s |
| **long-20min-noise** | passthrough-29.97 | 46/48（測定不能 2） | 1200.032 (1200.032) | 1200.000 | 0 / — / — | 1 / 0 | 0 | 772 s / 32.9 s |

- 音声が — のサンプルは、音声がサイン波（持続音）で測れないもの（`unmeasurable`。「測定不能 2」は音声のタイミングと A/V の差）。映像のタイミングはすべて 0 ms、フィールドの時間情報はすべて coverage 1、backward 0（4:3、縦、回転、ノイズの 20 分を含む）。
- 処理時間は Phase 5.2 の実行時のもの。映像のタイミングは全サンプルで測定でき（Phase 5.1 と同じく 0 ms）、測定不能に落ちたサンプルはない。
- **追加の素材**（Phase 5.2、17 サンプルとは別）: standard-16x9 から作った 15 fps / 6 fps の内容の 60 fps ファイル、fps-59.94 から作った 10 fps の内容の 59.94 fps ファイル（映像のタイミング 0 ms、変化点 31〜75、フィールド coverage 1）、standard-16x9 の静止画 3 枚のスライドショー、2 フレーム・1 フレームの短い入力（どれも PASS、内容の検査は測定不能）。
- 検証の時間（同じ出力、Phase 5.1 → 5.2）: standard-16x9 6.7 → 4.3 s、fps-59.94 8.4 → 6.0 s、m-60000_1001 3.8 → 3.2 s、long-20min-noise 36.5 → 32.5 s。子の ffmpeg を含む最大 RSS: standard-16x9 168 → 154 MB、long-20min-noise 213 → 191 MB（映像のタイミング用の別のデコードをやめたため）。
- **PoC との差（原因を確認済み）**:
  - fps-59.94 / fps-30 / fps-23.976 / m-25: Core の映像のほうが 1 フレーム長い。PoC の fps フィルタが最後のフレームを落としていた（§6 の `tpad`）。Core の値が元の長さに一致する。
  - motion/m-vfr: Core 19.987 s、PoC 19.953 s。VFR のコンテナには最後のフレームの長さが記録されないため、期待値（19.916 s）自体が短めになる。検証の許容差（±0.15 s）内。
  - 処理時間（Phase 3）: PoC とほぼ同等だった。M1 MacBook Air で長時間連続して実行したため、熱による速度低下の影響を含む。
- 全ケースで元の MP4 の sha256 が変換前後で一致した。

---

## 14. Phase 5.1 での変更（Verification Hardening）

第三者レビューで、壊れた出力を検証が合格させる 2 つの false positive（H1、H2）と、正常な出力を不合格にする 2 つの false negative（M1、M2）、Desktop から渡る plan を Core が信用しすぎる問題（M3）が見つかった。**変換の仕様（エンコード、59.94i、テレシネ、dvdauthor、ISO/UDF、ZIP、容量、音声、HDR）は変えていない。**変えたのは検証と境界だけ。

| | 原因 | 変更 |
| --- | --- | --- |
| H1 | 検証は「残った画像が正しい時刻に出るか」しか見ていなかった。60p を 29.97p に間引いても、残った画像はすべて 60i の正しいフィールドの位置に出る | `video.field_temporal`（§7）。生成側と独立に、フィールドに届いた元の瞬間の数と順序を数える |
| H2 | 映像が測れないと、A/V の判定ごと skip していた。音声のずれ（105.4 ms、5 区間で一致）は測れていたのに捨てていた | `sync.audio_timing`（§7）。音声は映像ストリームの開始時刻に対して判定し、映像が測れなくても失敗にできる |
| M1 | 1〜2 枚の VOB で ffprobe が `r_frame_rate` を `60000/1001` と推定し、`streams.video` が失敗 | `mpeg2.frame_rate`。sequence header の `frame_rate_code`・拡張・picture 数で判定し、ffprobe の推定は参考にとどめる |
| M2 | ffprobe がパケットのない `mp2` ストリームを列挙し、音声ストリームの数が 2 になった | `streams.audio` はパケットを持つストリームだけを数え、VOB の PES のペイロードと突き合わせる |
| M3 | Desktop の UI から渡った plan（フィルタ、ビットレート、出力先、ISO 名）を Core がそのまま使っていた | `convert()` は plan を受け取らず、自分で作り直す。UI からは入力・出力フォルダ・`planDigest` だけ。出力名は `safeChildPath()` で閉じ込める（§2、docs/desktop.md） |

加えて、`skipped` を `status`（`passed` / `failed` / `unmeasurable` / `not_applicable`）に置き換えた。出力に音声ストリームがない場合に、同期の計測が例外で止まらず `streams.audio` の失敗として報告するようにした。

### 生成と検証で共有しているもの（Shared Logic Audit）

| 共有しているもの | 使う検証 | 同じバグを共有した場合 | 対策・残るリスク |
| --- | --- | --- | --- |
| `expectedDisplayTime`（`profile/frame-rate.ts` の、戦略ごとの表示時刻のモデル） | `sync.video_timeline` | **H1 はこれで見逃した**（間引いても残った画像はモデルどおりの時刻に出る） | `video.field_temporal` がモデルを使わずに時間情報を数える。モデル自体は生成側のフィルタではなく定義（29.97 / 59.94 / 3:2 の格子）で、テストでは `test/helpers/motion.ts` の独立した計測も使う |
| plan の戦略 ID（`frameRate.strategy`） | 期待表示時刻の選択、temporal capacity | 分類や Policy の誤り（例: 60p を 29.97 と分類）は、その戦略としては正しい出力になり、検証は合格する | 残るリスク。戦略の選択は仕様（`PROGRESSIVE_POLICY` のように意図して 29.97p にすることもある）で、検証では誤りと区別できない。分類は unit test で確認 |
| plan の有効領域（`video.active`） | 出力の切り出し（同期・フィールド） | 有効領域の計算の誤り（アスペクトの歪み）は、同じ領域を比べるため検出されない | 残るリスク（Phase 5.1 の範囲外）。有効領域の計算は unit test で確認 |
| plan の入力色行列（`video.inputColorMatrix`） | フィールド検査の元の絵の変換 | 色の誤りは検出されない（時間の検査には影響が小さい） | 残るリスク（色は検証の対象外） |
| 解析結果（`analyze.ts` → plan の原点・長さ・音声トラック） | 長さ、同期の時刻の原点 | 解析が長さを読み違えると、生成も検証も同じ値を使う | 残るリスク。解析は途中切れ検出と先頭のデコードで確認。同期は内容で測る |
| `dvd/layout.ts`（IFO からファイル配置を計算） | `iso.ifo_addresses`（ISO Writer も同じ関数で配置） | 配置の計算の誤りを、書き込みと検証が共有する | isoinfo、mkisofs Reference との比較、macOS の UDF マウント（統合テスト）。第三者レビューでは libdvdread でも確認 |
| `iso/encoding.ts`（CRC-16、タグ） | `iso/reader.ts` の記述子の検査 | CRC の誤りが自己整合する | 同上（外部の実装で読めることを確認） |
| `zip.ts`（Writer と Reader が同じモジュール） | `zip.*` | 形式の誤りが自己整合する | Info-ZIP `unzip -t`（統合テスト） |
| ffmpeg / ffprobe（同じビルドで生成とデコード） | デコード、内容の検査 | デコーダのバグが自己整合する | VOB の構造（パック、PES、sequence header、picture 数）は自前の走査（`dvd/vob.ts`、検証専用）で見る |

Phase 5.1 で独立させたもの: フィールドの時間情報（独自のデコード経路と、生成側を使わない Oracle）、音声のタイミング（映像の内容に依存しない）、フレームレート（ffprobe の推定ではなく MPEG-2 のヘッダ）、音声ストリーム（ffprobe のパケットと PES の走査）、plan（Core が作り直して digest で照合）。

---

## 15. Phase 5.2 での変更（Verification Robustness & Path Hardening）

Phase 5.1 後の独立再レビューで、正常な低動作・重複フレームの素材を `sync.video_timeline` が誤って不合格にする問題（H3、High）、後続の sequence extension を検証していない問題（M5）、確認後に出力フォルダのリンクを付け替えられる問題（M6）が見つかった。**変換の仕様は変えていない**（encode、59.94i、テレシネ、音声、dvdauthor、ISO / ZIP Writer、容量、HDR）。

| | 原因 | 変更 |
| --- | --- | --- |
| H3 | 同じ絵が続くフレームのうち、どれに「最も似ている」かは雑音で決まる。Phase 5.1 までは、その 1 枚の時刻を使っていた（testsrc2 の 15 fps を 60 fps に入れた正しい出力が +16.7 ms で VERIFY_ERROR。レビューでは 10 fps で +33.3 ms、6 fps で +50 ms） | 同じ絵の続きを 1 つの瞬間とし、瞬間に入った時刻（変化点）だけを比べる（§7）。映像のタイミングはフィールド検査と同じデコードを使い、以前の別のデコードをやめた |
| M5 | VOB の走査が最初の sequence extension しか記録していなかった（2 番目以降の `frame_rate_extension` を壊しても PASS） | すべての sequence extension を数え、すべてが 0/0 で、数が sequence header と一致することを確認する。`progressive_sequence` も全 extension で確認する |
| M6 | 出力フォルダをパスのまま使っていた（確認後にリンクを付け替えると、別のフォルダに書き込まれた） | plan で実体のパスへ解決し、device:inode を plan（digest）に含める。変換中も確認する（§2） |
| M7（一部） | フィールド検査を全区間の合計だけで判定していた（区間の中の欠落が、ほかの区間で薄まって PASS） | 証拠が十分な区間ごとにも判定する。区間の間の故障は見えないまま（§11） |

- **Mutation check**（`scripts/mutation-check.mjs`）をリポジトリに入れた（Phase 5.1 では一時的なスクリプトだった）。H1〜H3、M1〜M3、M5〜M7 の修正を 1 つずつ無効にし、テストが失敗することを確認する。最初の実行で、「出力が瞬間にきれいに入った場合だけ変化点を使う」規則を守るテストがなかったことが分かり、追加した。
- 故障注入は、生成の経路（frame-rate policy、最終エンコードの引数だけを書き換える ffmpeg のラッパー）か、出力のバイトの書き換えで行う。バイトを書き換えた場合に ZIP と ISO を作り直す（壊した項目以外を一致させる）ところだけ、Core の Writer を使う。

### 生成と検証で共有しているもの（§14 からの変更）

- 映像のタイミングは、フィールド検査と同じデコードと対応付けを使うようになった。フィールド検査（`video.field_temporal`）は引き続き `expectedDisplayTime` を使わない。`expectedDisplayTime`（生成側のモデル）を使うのは映像のタイミングだけ。
- 映像のタイミングで生成側のモデルを使うのは「瞬間が始まる時刻の、最初の表示時刻」だけ。どのフレームが重複しているかは元の内容から検証側が決める。
- 出力フォルダの同一性（M6）は Core の中で完結し、UI から来る値には依存しない。
