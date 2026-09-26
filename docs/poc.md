# MP4 to IFO — Phase 2 PoC 結果（最終）

> **Historical record.** この文書は Phase 2 時点の PoC・設計調査の記録で、当時の調査結果と設計判断を残すためのもの。現在の製品仕様ではない。現在の仕様は [docs/core.md](core.md)。本文は当時のまま残しており、次の点は現在の実装と異なる。
>
> - **HDR**: PoC では停止した（`UNSUPPORTED_INPUT`、§5）。現在は HDR10 / HLG を experimental として SDR に変換する（互換ベースレイヤーのない Dolby Vision などは unsupported）。
> - **4ch 以上の音声**: PoC は ffmpeg の行列でダウンミックスした（§9.8）。現在は 5.1 以外のマルチチャンネルを変換しない（`UNSUPPORTED_AUDIO_LAYOUT`）。
> - **ISO / ZIP**: PoC は mkisofs と Info-ZIP `zip` で作った（§3）。現在は Core の自前の Writer で作り、mkisofs / isoinfo はテストの Reference にだけ使う。
> - **検証**: PoC の 39 項目（§6）は現在の検証を表さない。現在の検証は docs/core.md §7。
> - **4 GB を超える ZIP**: PoC では未検証（§10、§11）。現在は macOS で確認済み（docs/release.md §13.3）。Windows での展開は未確認。
> - §11 の未解決事項には、その後に対応したもの（A/V 同期の自動検証、VFR の開始時刻、LGPL 版 FFmpeg の同梱など）がある。現在の制限は docs/core.md §11。

**Result:** Phase 2 **PASS**
**Physical DVD:** **Not physically verified**
**Script:** `scripts/poc-convert.mjs`（PoC専用。Phase 3 Coreではない）
**Experiments:** `scripts/experiments/`

このドキュメントでは、確認のレベルを次の3つに分けて書く。

| 記号 | 意味 |
| --- | --- |
| **[規格]** | DVD-Video / MPEG-2 / UDF の規格・仕様書・ソースコードから判断したこと（実機・実測ではない） |
| **[SW]** | このMacで実行し、ソフトウェアVerificationで確認したこと |
| **[物理]** | DVD-Rへの書き込み・DVDプレーヤーでの再生で確認したこと — **本Phaseでは1件もない** |

---

## 1. Result

Phase 2 PoC は **PASS**。

Apple Silicon Mac実機上で `MP4 → ffprobe → FFmpeg 2-pass → MPEG-2 + AC-3 → dvdauthor → VIDEO_TS → VIDEO_TS.zip → DVD-Video ISO → Software Verification` が成立した **[SW]**。成功想定のサンプルはすべて39項目のVerificationを通過した（§6, §8）。

次のことは**確認していない**: DVD-Rへの物理書き込み、家庭用DVDプレーヤーでの再生、結婚式場設備での再生、あらゆるDVDプレーヤーとの互換性。

---

## 2. Environment

| 項目 | 値 |
| --- | --- |
| Mac | MacBook Air (MacBookAir10,1), Apple M1, 16 GB |
| macOS | 26.6.2 (25G83) |
| Architecture | arm64 |
| Node.js | 22.23.2 |
| FFmpeg / ffprobe | 7.1 — Homebrew `ffmpeg 7.1_4`（GPLv3ビルド、PoC開発用）と **自前ビルドのLGPL版**（§9.1） |
| dvdauthor | 0.7.2 (Homebrew `dvdauthor 0.7.2_4`) |
| mkisofs | 3.02a09 (Homebrew `cdrtools 3.02a09`) — ISO生成のReference |
| ZIP | Info-ZIP Zip 3.0 / UnZip 6.00（macOS標準） |

---

## 3. Verified Pipeline [SW]

```text
input.mp4 (read-only)
 ↓ sha256 / size / mtime を記録
 ↓ ffprobe -count_packets -show_streams -show_format   … 解析 + 途中切れ検出
 ↓ ffmpeg -t 2 … -f null                               … 先頭デコード確認
 ↓ 容量からビットレート計算 / 音声ダウンミックスのピーク事前計測（>2ch のとき）
 ↓ ffmpeg pass 1  (-f null)
 ↓ ffmpeg pass 2  (-f dvd)                             → $TMP/title.mpg
 ↓ dvdauthor -x dvdauthor.xml                          → $TMP/dvd/VIDEO_TS
 ↓ mkisofs -dvd-video                                  → <out>/.<name>.partial-<pid>/<name>.iso
 ↓ VIDEO_TS を staging へ移動
 ↓ zip -r -X -0                                        → VIDEO_TS.zip
 ↓ Verification（39項目）
 ↓ staging を <out>/<name>（重複時 <name>-2, -3 …）へ rename（Promote）
Success
```

- 中間ファイル（pass log, title.mpg, dvdauthor XML, ZIP展開先, ISOマウントポイント, tool log）は `os.tmpdir()/mp4-to-ifo-poc-*` に分離し、成功・失敗・キャンセルのいずれでも削除する。
- 成果物は出力先の隠しstagingで作り、Verification通過後にのみ正式名へrenameする。失敗時はstagingごと削除する。
- 失敗コード: `PREFLIGHT_FAILED` `INPUT_INVALID` `ANALYZE_FAILED` `UNSUPPORTED_INPUT` `ENCODE_FAILED` `AUTHOR_FAILED` `ISO_FAILED` `ZIP_FAILED` `OUTPUT_FAILED` `VERIFY_FAILED` `SOURCE_MODIFIED` `CANCELLED`。Exit code 0 / 1 / 2 / 3 / 4（要件15.10）。

### Commands

```bash
brew install ffmpeg dvdauthor cdrtools
node scripts/poc-convert.mjs input.mp4 --output output [--verbose] [--keep-temp] [--fps-mode field|frame]

# LGPL版FFmpegで実行する場合
scripts/experiments/build-ffmpeg-lgpl.sh
PATH="$PWD/build/ffmpeg-lgpl/bin:$PATH" node scripts/poc-convert.mjs input.mp4 --output output
```

主要コマンド（標準サンプル）:

```bash
V="-map 0:0 -vf $VF -c:v mpeg2video -b:v 8000k -maxrate 9000k -minrate 0 -bufsize 1835008
   -g 18 -bf 2 -flags +ildct+ilme -top 1 -aspect 16:9
   -color_primaries smpte170m -color_trc smpte170m -colorspace smpte170m -passlogfile $TMP/pass"
ffmpeg -nostdin -v error -y -i input.mp4 $V -pass 1 -an -f null -
ffmpeg -nostdin -v error -y -i input.mp4 $V -pass 2 -map 0:1 [-af $AF] \
  -c:a ac3 -b:a 256k -ar 48000 -ac 2 -map_metadata -1 -map_chapters -1 \
  -f dvd -muxrate 10080000 -packetsize 2048 $TMP/title.mpg
VIDEO_FORMAT=NTSC dvdauthor -x dvdauthor.xml
mkisofs -dvd-video -V LABEL -input-charset utf-8 -quiet -o name.iso $TMP/dvd
zip -r -X -0 -q VIDEO_TS.zip VIDEO_TS
```

`$VF`（16:9ソースの例。フレームレート変換部分は §9.3〜9.6）:

```text
scale=w='if(gte(dar,16/9-0.001),720,2*trunc(720*dar/(16/9)/2))'
     :h='if(gte(dar,16/9-0.001),2*trunc(480*(16/9)/dar/2),480)'
     :in_color_matrix=bt709:out_color_matrix=bt601:out_range=tv:flags=lanczos,
pad=720:480:(ow-iw)/2:(oh-ih)/2:black,[frame rate],setsar=32/27,format=yuv420p
```

dvdauthor XML:

```xml
<dvdauthor dest="dvd">
  <vmgm>
    <fpc>jump title 1;</fpc>
  </vmgm>
  <titleset>
    <titles>
      <video format="ntsc" aspect="16:9" widescreen="nopanscan"/>
      <audio format="ac3" channels="2" samplerate="48khz"/>
      <pgc>
        <vob file="title.mpg"/>
        <post>exit;</post>
      </pgc>
    </titles>
  </titleset>
</dvdauthor>
```

---

## 4. Test inputs

入力はすべて ffmpeg で生成した合成動画（`samples/` はGit管理外）。**撮影素材・編集ソフト書き出し素材・実HDR素材は未検証。**

| Sample | 内容 |
| --- | --- |
| standard-16x9 | 1920×1080 29.97p H.264 / AAC 2ch, 60 s |
| aspect-4x3 / vertical-1080x1920 / rotated-90 | 1440×1080 / 1080×1920 / 1920×1080 + rotation 90 |
| fps-30 / fps-59.94 / fps-23.976 | 1080p、各フレームレート |
| audio-5.1 / audio-5.1-loud / audio-mono / no-audio | 5.1ch（通常）/ 5.1ch（過大、ダウンミックスで+5.6 dBFS）/ モノラル / 音声なし |
| long-20min-noise | 1280×720 + ノイズ、1200 s（上限ビットレートを使わせる長尺） |
| motion/m-* | フレーム番号を12ビットの白黒ブロックで焼き込み、毎秒クリック音を入れた素材（`make-motion-sample.sh`）。29.97 / 59.94 / 60 / 50 / 25 / 23.976 / 24 / VFR |
| hdr10-synthetic / hlg-synthetic | HEVC Main10 BT.2020、PQ / HLG のタグ付き合成素材（中身は実HDRではない） |
| truncated / truncated-faststart / fake | 途中切れ（moov末尾 / 先頭）、テキストファイル |

---

## 5. Error cases [SW]

| Case | Result | 確認内容 |
| --- | --- | --- |
| corrupt MP4（moov末尾で途中切れ） | `ANALYZE_FAILED`, exit 2 | 変換開始前に停止 |
| fake MP4（テキスト） | `ANALYZE_FAILED`, exit 2 | 同上 |
| truncated MP4（moov先頭、mdat途中切れ） | `INPUT_INVALID`, exit 2 | `video has 898 of 1799 samples`。事前検出なしでは Verification の Duration照合（Δ -30.1 s）で失敗することも確認済み |
| broken VOB（`POC_FAULT=corrupt-vob` でオーサリング後にVOBの300 KBを上書き） | `VERIFY_FAILED`, exit 3 | 5項目で検出（パック構造、フルデコード `ac-tex damaged`、映像長 Δ-0.834 s、音声長 Δ-0.883 s、ISO内容不一致）。staging削除 |
| HDR入力 | `UNSUPPORTED_INPUT`, exit 2 | 検出して停止（§9.10） |
| 引数なし | Usage表示, exit 2 | – |
| Ctrl+C（pass 1 中にプロセスグループへSIGINT） | `CANCELLED`, exit 4 | staging / temp / ffmpegプロセスが残らない。元MP4のsha256不変 |

全ケースで元MP4の sha256 / size / mtime は変わらなかった。

---

## 6. Verification（39項目）[SW]

| # | 項目 |
| --- | --- |
| 1 | VIDEO_TS required files（VIDEO_TS.IFO/BUP, VTS_01_0.IFO/BUP, VTS_01_n.VOB） |
| 2 | VIDEO_TS has no unexpected files |
| 3 | 全ファイルが2048バイト境界、VOBは空でなく ≤ 1 GiB |
| 4 | BUP が IFO とバイト一致 |
| 5 | VMG identifier `DVDVIDEO-VMG` |
| 6 | VTS identifier `DVDVIDEO-VTS` |
| 7 | タイトルセット1・タイトル1 |
| 8 | Region free（VMG region mask 0x00） |
| 9 | First Play → `JumpTT 1`（Autoplay） |
| 10 | Title PGC post → `Exit`（End → Stop） |
| 11 | VTS video attributes: MPEG-2 / NTSC / 16:9 / 720×480 |
| 12 | VTS audio attributes: 1 × AC-3 / 2ch / 48 kHz |
| 13 | VTS last sector = ファイルサイズ合計 |
| 14 | Title VOBS 開始位置 = VTS IFO の直後 |
| 15 | 全パックが2048バイトの MPEG-2 PS パック |
| 16 | NAVパック（PCI/DSI）がVOBUごとに存在 |
| 17 | シーケンスヘッダ: 720×480、aspect code 3、frame rate code 4、VBV ≤ 224 KiB |
| 18 | `progressive_sequence = 0` |
| 19 | GOP ≤ 18 フレーム |
| 20 | AC-3 の PES PTS が厳密に単調増加 |
| 21 | フルデコード（`ffprobe -count_frames -err_detect crccheck`、全VOB連結）でエラーなし |
| 22 | mpeg2video 720×480 SAR 32:27 DAR 16:9 30000/1001 × 1 |
| 23 | ac3 48 kHz 2ch × 1 |
| 24 | デコードした映像フレーム数から求めた長さが元MP4と ±0.15 s 以内 |
| 25 | デコードした AC-3 フレーム数から求めた長さが ±0.15 s 以内 |
| 26 | IFO PGC 再生時間が ±0.15 s 以内 |
| 27 | ZIP integrity（`unzip -t`） |
| 28 | ZIPエントリが `VIDEO_TS/*` のみ |
| 29 | ZIP展開結果が VIDEO_TS と sha256 一致 |
| 30 | ISO9660 Volume ID = 期待ラベル |
| 31 | ISO9660 + UDF 1.02 ブリッジ（VRS `CD001 BEA01 NSR02 TEA01`、sector 256 に AVDP） |
| 32 | ISO内ファイル配置順: VMG IFO < BUP < VTS IFO < VOBs < VTS BUP |
| 33 | ISO上のセクタ位置が IFO 内のアドレスと一致 |
| 34 | macOS で読み取り専用マウント可能（`hdiutil attach`） |
| 35 | マウントされたファイルシステムが `udf` |
| 36 | ISO 内の VIDEO_TS のファイル構成が一致 |
| 37 | ISO 内の VIDEO_TS が sha256 一致 |
| 38 | ISO 内の VOB を ffprobe で読める |
| 39 | 元MP4が変更されていない（size, mtime, sha256） |

### Verificationで検出できないもの

- **A/V同期のずれ**。Phase 2 の 59.94 fps 変換には、映像が1フレーム（33 ms）遅れる不具合があった（§9.3）。39項目はすべて通過しており、`motion-probe.mjs` による追加計測で初めて見つかった。任意の入力に対して同期を自動検証する方法は、Phase 3 の課題として残る。
- 画質、色、トーンマッピングの妥当性。
- 物理ディスク・DVDプレーヤーでの互換性。

---

## 7. Phase 3 へ持ち越す確定事項

「確定」は **[SW]** で成立を確認し、Phase 3 の仕様として採用するという意味。**[物理]** の確認はしていない。

### 映像

| 項目 | 仕様 |
| --- | --- |
| 方式 | NTSC、MPEG-2 MP@ML、720×480、DVD 16:9（SAR 32:27, `-aspect 16:9`）、yuv420p |
| エンコード | FFmpeg software、2-pass（pass 1 `-f null`、pass 2 `-f dvd`） |
| パラメータ | `-g 18 -bf 2 -maxrate 9000k -minrate 0 -bufsize 1835008 -flags +ildct+ilme -top 1` |
| 多重化 | `-f dvd -muxrate 10080000 -packetsize 2048` |
| アスペクト | `scale`（`dar` 式）+ `pad`。クロップ・ストレッチなし。回転はffmpegのautorotate |
| 色 | 出力BT.601（`smpte170m` タグ）。BT.709入力は行列変換。タグなしは高さ720以上でBT.709とみなす（PoC方式） |
| フレームレート | §9.3〜9.7 の表 |

### 音声

| 項目 | 仕様 |
| --- | --- |
| 形式 | AC-3、Stereo、48 kHz、**256 kbps固定**（§9.9） |
| ダウンミックス | §9.8 の行列 + クリップ保護 |
| 音声なし | 無音 AC-3 Stereo 48 kHz を付加（§9.11） |
| 正規化 | ラウドネス正規化はしない |

### DVD構造

| 項目 | 仕様 |
| --- | --- |
| Authoring | dvdauthor 最小XML（§3）。メニューなし・チャプターなし |
| Autoplay | VMG First Play = `JumpTT 1` |
| End → Stop | Title PGC post = `Exit` |
| Region | Free（VMG region mask 0x00、dvdauthor既定） |
| 出力 | `VIDEO_TS/`, `VIDEO_TS.zip`（無圧縮格納）, `<name>.iso` |

### 処理・安全性

- 一時領域での中間生成 → staging → Verification通過後にのみPromote（正式名へrename）。
- 元MP4は読み取りのみ。前後で sha256 / size / mtime を照合。
- Ctrl+C（SIGINT）で子プロセス停止、staging・temp削除、exit 4。
- 同名出力は `<name>`, `<name>-2`, `<name>-3` … と採番。Volume Label は `[A-Z0-9_]` に正規化（最大30文字、空なら `DVD_VIDEO`）。
- 途中切れMP4の検出: ffprobe の `nb_frames`（moov上のサンプル数）と `-count_packets` の `nb_read_packets` を比較（デコード不要）。

### Verification

- §6 の39項目をPhase 3のAcceptance Testとする。
- Durationは**デコードしたフレーム数**で求め、許容差 **±0.15 s**（§9.13）。
- フルデコードは `ffprobe -count_frames -err_detect crccheck`（`ffmpeg -f null` は偽陽性があるため使わない）。
- BUP/IFO一致、NAVパック、MPEG-2ヘッダ、ISO9660 + UDF 1.02、ISO内配置とIFOアドレスの一致を検証する。

---

## 8. Regression [SW]

Phase 2 の全サンプルと追加検証サンプルを、最終版の PoC（本ドキュメントの仕様）で再実行した。

LGPL 版 FFmpeg（§9.1）を PATH の先頭に置き、`scripts/experiments/regression.sh` で1本ずつ実行した。

| Sample | Result | Duration（元 / DVD映像 / DVD音声 / IFO） |
| --- | --- | --- |
| standard-16x9 | 39/39 | 60.027 / 60.027 / 60.032 / 60.027 |
| aspect-4x3 | 39/39 | 19.987 / 19.987 / 20.032 / 20.020 |
| vertical-1080x1920 | 39/39 | 19.987 / 19.987 / 20.032 / 20.020 |
| rotated-90 | 39/39 | 20.087 / 20.120 / 20.032 / 20.120 |
| fps-30 | 39/39 | 20.000 / 19.953 / 20.032 / 20.020 |
| fps-59.94（59.94i） | 39/39 | 19.987 / 19.953 / 20.032 / 20.020 |
| fps-23.976（Hard Telecine） | 39/39 | 19.978 / 19.920 / 20.032 / 20.020 |
| audio-5.1 | 39/39 | 19.987 / 19.987 / 20.032 / 20.020 |
| no-audio | 39/39 | 20.020 / 20.020 / 20.032 / 20.020 |
| audio-5.1-loud（追加） | 39/39 | 10.010 / 10.010 / 10.016 / 10.010 |
| audio-mono（追加） | 39/39 | 10.010 / 10.010 / 10.016 / 10.010 |
| motion/m-50（追加） | 39/39 | 20.000 / 19.987 / 20.032 / 20.020 |
| motion/m-25（追加） | 39/39 | 20.000 / 19.953 / 20.032 / 20.020 |
| motion/m-vfr（追加） | 39/39 | 19.900 / 19.953 / 20.032 / 20.020 |
| **long-20min-noise** | **39/39** | 1200.032 / 1200.032 / 1200.000 / 1200.032（処理 850 s、容量見積もり 1260.8 MB vs 実測 1259.8 MB） |

- Homebrew（GPL）版の FFmpeg でも standard-16x9 が 39/39 で通過した。
- 同じ条件で2つのビルドを比べると、標準サンプルの Encode 時間は 50.6 s（Homebrew）と 51.0 s（LGPL）、VOB サイズはどちらも 25,784,320 バイトだった。
- Phase 2 では同じ処理が 36 s だった。数時間連続で負荷をかけた後のファンレス機（MacBook Air）での計測なので、熱による速度低下とみられる。処理時間の絶対値は参考程度に扱う。
- Phase 2 で出力した opening-movie と日本語ファイル名のサンプル（採番の確認用）は再実行していない。命名処理は変更していない。

---

## 9. 追加検証

### 9.1 FFmpeg LGPL-only 構成 [SW]

`scripts/experiments/build-ffmpeg-lgpl.sh` で FFmpeg 7.1 をソースからビルドした。`--enable-gpl` も nonfree も付けていない。

```text
--disable-autodetect --disable-network --disable-doc --disable-ffplay
--disable-shared --enable-static --enable-zlib --enable-iconv --enable-libzimg
--extra-libs=-liconv
→ ffmpeg -L: "GNU Lesser General Public License ... version 2.1 or later"
```

- PoC が使う機能はすべて含まれる: h264 / hevc / prores / vp9 / av1 / mpeg4 / aac decoder、`mpeg2video` / `ac3` encoder、`dvd` muxer、`scale pad fps setsar setfield separatefields select weave telecine format pan volume astats anullsrc aresample zscale tonemap`。
- GPL専用の `tinterlace` / `interlace` / `cropdetect` は**含まれない**ことを確認した。
- このLGPL版をPATHの先頭に置いて §8 のリグレッションを実行し、全サンプルが通過した。
- 外部ライブラリは libzimg（WTFPL、`zscale` 用。HDRを扱わないなら不要）と、macOS の libz / libiconv / システムフレームワークのみ。
- 配布用ビルドではない。コード署名、zimg の静的リンク、ビルドの再現性、ライセンス文書の同梱は Phase 3 以降で行う。

### 9.2 ISO Writer（自前 DVD-Video ISO9660 / UDF 1.02）の実現可能性 [規格] + [SW]

Reference（mkisofs `-dvd-video`）の出力を `scripts/experiments/iso-structure.mjs` でセクタ単位に分解した。標準サンプル（13,062 sectors）の実測:

```text
sector 0-15      system area（全ゼロ）
sector 16        ISO9660 PVD（volume id, volume space = 総セクタ数, block 2048, path tables, root dir）
sector 17        ISO9660 terminator
sector 18-20     UDF VRS: BEA01, NSR02, TEA01
sector 32-37     UDF Main VDS: PVD, IUVD, PD("+NSR02", partition start 257), LVD, USD, TD
sector 48-53     UDF Reserve VDS（同内容）
sector 64-65     UDF LVID
sector 256       AVDP（main VDS 32, reserve VDS 48）
sector 257-      UDF partition: FSD(lb 0), root FE, AUDIO_TS FE, VIDEO_TS FE, 各ファイルの FE + FID
sector 270-276   ISO9660 L/M path table, root / AUDIO_TS / VIDEO_TS ディレクトリ
sector 277-      ファイル本体（下表）
sector N-1       AVDP（2つ目）
LVD: block 2048, domain "*OSTA UDF Compliant", UDF revision 0x0102, File Entry(非Extended), short_ad
```

| File | Extent（ISO9660 と UDF で同一） | 決まり方 |
| --- | --- | --- |
| VIDEO_TS.IFO | 277 +3 | 任意の開始位置 = VMG 開始 |
| VIDEO_TS.BUP | 306 +3 | VMG開始 + VMG last sector + 1 − BUPのセクタ数（IFOに記載） |
| VTS_01_0.IFO | 309 +6 | VMG開始 + TT_SRPT の VTS start sector（= 32） |
| VTS_01_n.VOB | 315 +12590 … | VTS IFO + title VOBS start sector。VOBは連続して配置 |
| VTS_01_0.BUP | 12905 +6 | VTS開始 + VTS last sector + 1 − BUPのセクタ数 |

必要な構造と制約:

- **Bridge**: ISO9660 と UDF 1.02 の両方のディレクトリから、同じ連続extentを指す。各ファイルは1 extent。
- **ファイル配置は dvdauthor が書いた IFO で完全に決まる**。Writer がすることは「IFOのアドレスどおりに置き、隙間をゼロで埋める」だけで、配置を判断する余地はない。§6 の #32/#33 がそのままこの受け入れ試験になる。
- **Sector alignment**: 全ファイルが2048バイトの倍数（dvdauthor が保証）。Reference は16セクタ（ECCブロック）境界には揃えていない。
- **VOB サイズ**: dvdauthor は VOB を 1,073,709,056 バイト（524,272 sectors）で分割する。UDF short_ad の extent 長の上限（2^30 − 1）に収まるので、1 extent で表せる。
- **ISO9660**: Level 1 名（`VIDEO_TS.IFO;1` 等は8.3形式に収まる）、ディレクトリは `VIDEO_TS`（と空の `AUDIO_TS`）のみ。
- **UDF**: 記述子タグ（チェックサム + CRC-16/CCITT）、OSTA CS0 dstring、タイムスタンプ、FE（ICB strategy 4）、FID、LVID（close状態）、AVDP ×2。
- **Volume Label**: ISO9660 は d-characters 32 文字以内、UDF dstring は 8bit CS0 で30文字以内 → 現行の `[A-Z0-9_]`・30文字でどちらにも収まる。
- **macOS mount**: AVDP（256）→ VDS → LVD → FSD → root FE が正しく辿れること。Verification #34/#35 で確認できる。

**判断: Core に DVD-Video 専用の小さな Writer を実装するのは妥当。**

- 対象は「ルート直下に VIDEO_TS（+空の AUDIO_TS）、最大で十数ファイル、各1 extent、配置はIFOが決める」という固定構造だけで、汎用ISOツールの機能（Joliet / Rock Ridge / 深い階層 / 断片化 / マルチセッション）は一切不要。
- 必要な記述子は上のセクタマップに全部出ており、書き出しは固定レイアウトの組み立て + ファイルのストリームコピーで済む。規模の見積もりは TypeScript で 600〜1000 行程度（未実装なので見積もりのみ）。
- 検証手段が揃っている: (1) 39項目のうち ISO 関連の #30〜#38、(2) `iso-structure.mjs` による mkisofs 出力との構造比較（Reference は開発時のテストでのみ使い、配布しない）、(3) hdiutil マウント。GitHub Actions の Linux で UDF マウントして二重確認することもできる（未実施）。
- Sidecar を1つ減らせ、cdrtools の GPL/CDDL 論点を配布物から外せる。
- リスク: UDF の細部（CRC、タイムスタンプ、Implementation ID、LVID）を誤ると、macOS ではマウントできても一部のプレーヤーが読めない可能性がある。これは **[物理]** でしか確認できない。Beta では mkisofs 版と自前版の両方を焼いて比べることを推奨する。

### 9.3 60 fps [SW]

同じ素材（motion/m-60000_1001, m-60、20 s）から両方式を作り、`motion-probe.mjs` でフィールド単位に解析した。

| 方式 | 入力 | 1秒あたりの独立した動き | 欠落/重複 | 2フィールドが別時刻のフレーム | 表示時刻誤差 rms / max | A/V sync |
| --- | --- | --- | --- | --- | --- | --- |
| **A. 29.97p**（`fps=30000/1001`） | 59.94 | 29.97 | 1つおきに間引き（598） | 0 | 0.0 / 0.0 ms | 0.0 ms |
| | 60 | 29.97 | 間引き（599） | 0 | 5.1 / 10.0 ms | +10.0 ms |
| **B. 59.94i**（LGPLの weave チェーン） | 59.94 | **59.94** | 0 / 0 | 599 / 599 | **0.0 / 0.0 ms** | **0.0 ms** |
| | 60 | 59.94 | 1001枚に1枚間引き（1） | 599 / 599 | 4.5 / 9.1 ms | -0.8 ms |

B のフィルタ:

```text
fps=60000/1001,setfield=tff,separatefields,
select='not(mod(n\,4))+eq(mod(n\,4)\,3)',weave=first_field=top,
fps=30000/1001:round=down,setfield=tff
```

1080p の実素材サイズ（fps-59.94、20 s）で LGPL 版を使い、他の処理と並行させずに計測した:

| 方式 | Encode 時間 | VIDEO_TS | 39項目 |
| --- | --- | --- | --- |
| A. 29.97p | 28.5 s | 8.5 MB | ✓ |
| B. 59.94i | 29.6 s | 10.3 MB | ✓ |

- 処理時間はほぼ同じ。B のほうが大きいのは、この素材が目標ビットレートに届いておらず、インターレースの画をより多くのビットで符号化したため。上限ビットレートに張り付く長さの素材では、サイズは同じになる。

- **Phase 2 からの修正**: weave は出力フレームに**2枚目のフィールドの時刻（+½フレーム）**を付ける。Phase 2 のチェーン（末尾 `fps=30000/1001`、丸め既定 near）ではこれが1フレーム繰り上がり、**映像が33 ms遅れていた**（音声が先行。39項目は通過していた）。`round=down` にして誤差0を確認した。
- B は `tinterlace=mode=interleave_top` とビット単位で一致する（Phase 2 で確認済み）。`tinterlace` は GPL 専用なので使わない。
- DVD構造としては A も B も同一。どちらも `progressive_sequence=0`・TFF で、39項目を通過した。

**推奨: v1 の既定は B（59.94i）。**

- 60 fps 素材の動きの情報（59.94 の独立した時刻）を DVD-Video が表せる最大限まで保持し、表示時刻の誤差は 0。A は動きの半分を捨てる。
- NTSC DVD の再生系（プレーヤー → TV）は 480i を前提に作られている **[規格]**。また本ツールの出力は、どの入力でも MPEG-2 上はインターレースとしてフラグされる（`+ildct+ilme`）。そのため、デインターレースの有無という点では A と B でプレーヤーの扱いは変わらない。
- リスク: デインターレースしない表示系（プレーヤーを通さずにPCでVOBを直接開く等）では、B は動きのある部分に櫛状のノイズが出る **[規格]**。Beta の物理テストで 60i サンプルを必ず含め、問題があればフィルタ1行で A に切り替えられる。

### 9.4 23.976 / 24 fps [SW] + [規格]

| | A. Hard Telecine（`telecine=first_field=top:pattern=23`） | B. Soft Telecine（RFFフラグ） |
| --- | --- | --- |
| DVD-Video 準拠 | ✓ 29.97i として準拠 | ✓（フィルム素材の一般的な格納方法）**[規格]** |
| MPEG-2 構造 | 29.97 フレーム、5フレーム中2フレームは別フレームのフィールドを含む | 23.976 で符号化し、`repeat_first_field` / `top_field_first` で 3:2 を表現。frame rate code は 4 |
| FFmpeg 単体 | ✓（LGPL） | ✗ `mpeg2video` エンコーダは RFF を出力できない。`mpeg2_metadata` BSF でも RFF は変更できない |
| 外部ツール | 不要 | DGPulldown / mjpegtools `mpeg2enc` 等（いずれも別ツール、GPL系）、または MPEG-2 ES の自前パッチャー |
| dvdauthor | ✓ 警告なし | 未検証 |
| 計測（motion） | 23.976: 479枚すべて表示、3:2 の周期どおり、表示時刻誤差 rms 5.9 / max 8.3 ms、sync 0.0 ms | 未実装 |
| 比較: 29.97p 化（フレーム複製） | rms 10.2 / max 16.7 ms（4枚に1枚複製） | – |

**推奨: v1 は A（Hard Telecine）。**

- FFmpeg（LGPL）だけで完結し、追加の依存がない。動きのタイミングは 3:2 プルダウンとして正しい（ソフトテレシネと同じ表示順）。
- 損失は符号化効率（混合フレームにビットを使う）だけで、数分〜十数分の動画は常に上限ビットレートになるため、実用上の差は小さい。
- B を実装するなら外部ツールではなく、Core 内での ES パッチ（sequence header / picture coding extension のビット書き換え + 再多重化）が候補。ただし VBV の整合と dvdauthor の扱いに検証が必要で、v1 には入れない。
- 重要な安全策（Phase 2 で判明）: 23.976 で符号化した MPEG-2 を dvdauthor に渡すと、警告を出すだけで VIDEO_TS を生成してしまう。Verification #17（frame rate code 4）で必ず弾く。

### 9.5 25 / 50 fps [SW]

NTSC 出力のみ（PAL DVD 出力は追加しない）。再生時間を変えないことを前提に比較した（25→23.976 のスローダウン + テレシネは長さと音程が変わるため不採用）。

| 方式 | 入力 | 独立した動き/s | 表示時刻誤差 rms / max | A/V sync | 備考 |
| --- | --- | --- | --- | --- | --- |
| 29.97p（`fps=30000/1001`） | 50 | 29.97 | 5.8 / 10.0 ms | +6.7 ms | 5枚中2枚を間引き（400） |
| | 25 | 25.01 | 9.6 / 16.7 ms | 0.0 ms | 5枚に1枚を複製（99） |
| **59.94i（60i チェーン）** | 50 | **49.98** | **4.8 / 8.3 ms** | 0.1 ms | フィールド単位で6枚に1枚を複製 |
| | 25 | 25.01 | **4.8 / 8.3 ms** | 0.1 ms | 各フレームを 2 / 3 フィールドで表示（プルダウン相当） |

- どちらも Duration は維持され（映像 19.987 / 19.953 s、元 20.000 s）、音声には手を加えないので同期は保たれる。
- 動き補間（`minterpolate`）は不要と判断した。処理が遅く、補間の破綻が出るリスクがあり、結婚式ムービーの用途に見合わない。
- **推奨: 25 / 50 は 59.94i（60 fps と同じチェーン）。** フレーム単位の複製・間引きより、表示時刻の誤差が約半分になる。

### 9.6 VFR [SW]

- 素材: 60 fps の番号付きフレームから、不規則に間引いた MP4（`-fps_mode vfr`、775 フレーム / 20 s）。
- 検出: ffprobe で `r_frame_rate = 60/1` に対して `avg_frame_rate = 7750/199 (38.9)` と不一致。Phase 3 ではこれに加えて、パケット長のばらつき（`-show_entries packet=duration`、デコード不要）で判定することを推奨する。

| 方式 | 表示された元フレーム | 表示時刻誤差 rms / max | A/V sync | Duration（元 / DVD映像 / 音声） |
| --- | --- | --- | --- | --- |
| 29.97p（`fps=30000/1001`） | 582 / 775 | 11.1 / 18.5 ms | -1.1 ms | 19.900 / 19.953 / 20.032 |
| **59.94i（60i チェーン）** | **774 / 775** | 4.8 / 33.8 ms | -17.1 ms（一定） | 19.900 / 19.953 / 20.032 |

- どちらも39項目を通過した。
- **推奨: 29.97 / 30 / 23.976 / 24 の CFR 以外（VFR を含む）は 59.94i チェーン**、とする1つのルールにする。
- 未解決: この素材は最初のフレームが 16 ms の位置から始まり、59.94i では先頭に1フィールドの重複が入って、以降が一定 17 ms（1フィールド）ずれた。一般的な音ズレの知覚閾値（音声先行 約45 ms）より小さいが、開始時刻の扱いは Phase 3 で揃える。スマートフォンの実VFR素材（平均 29.97 付近）は未検証。

### 9.7 フレームレート変換ルール（Phase 3 仕様案）

| 入力 | 変換 | フィルタ |
| --- | --- | --- |
| 29.97 CFR | なし | – |
| 30 CFR | 29.97p（1001枚に1枚間引き） | `fps=30000/1001` |
| 23.976 / 24 CFR | Hard Telecine | `fps=24000/1001,telecine=first_field=top:pattern=23` |
| 59.94 / 60 / 50 / 25 / その他 / VFR | 59.94i | §9.3 のチェーン |

PoC の `--fps-mode field`（既定）がこの表。`--fps-mode frame` は比較用（全入力を `fps=30000/1001`）。

### 9.8 Audio Downmix [SW]

`scripts/experiments/downmix.sh`（float でのピーク / RMS / クリップ数と、AC-3 256k を経たピーク）。

| 信号 | M0 ffmpeg 既定 (`-ac 2`) | M2 ITU 常に正規化 (÷2.414) | **M3 ITU + クリップ保護** |
| --- | --- | --- | --- |
| coherent（全ch同一トーン -6 dBFS） | AC-3後 **+1.64 dBFS（クリップ）** | -6.0 | **-1.0** |
| typical（L/R -10, C -12, 後方 -20） | -4.65（AC-3後） | -12.4 | **-4.65**（ゲイン 0） |
| frontonly（L/R -3 のみ） | -3.0（AC-3後） | **-10.65（常に -7.65 dB）** | **-3.0**（ゲイン 0） |
| loud（大音量マスター） | AC-3後 **+3.87 dBFS（クリップ）** | -3.8 | **-1.0** |

- **発見**: ffmpeg 既定のダウンミックスは、後段が要求するサンプル形式によって正規化するかどうかが変わる。astats（整数形式を選ぶ）では正規化され、AC-3 エンコーダ（float）の前では正規化されない。そのため同じ `-ac 2` でも、本番のパイプラインではクリップする。既定動作に頼らず、行列を明示する必要がある。
- **発見**: モノラル入力は `-ac 2` で **-3 dB** 下がる（センター扱いで 0.707 倍に振られる）。

**推奨（PoC に実装済み）:**

```text
5.1 / 5.1(side):
  L = FL + 0.7071·FC + 0.7071·(BL|SL)
  R = FR + 0.7071·FC + 0.7071·(BR|SR)          ITU-R BS.775 Lo/Ro、LFE は使わない
  → ダウンミックス後の sample peak を事前計測（astats、音声のみのデコード）
  → peak > -1 dBFS のときだけ、固定ゲイン (-1 − peak) dB で減衰。増幅はしない
Mono:   L = R = mono（unity）
Stereo: そのまま
その他のマルチチャンネル: ffmpeg の行列を float で適用 + 同じクリップ保護（PoC。Phase 3 で個別に検討）
```

- ラウドネス正規化ではない。正しくマスタリングされた素材ではゲインは 0 dB で、元の音量バランスをそのまま保つ（typical / frontonly）。過大な素材だけを一定量下げる（loud: -6.59 dB、ピーク -1.0 dBFS）。
- パイプラインでの実測: audio-5.1 → ゲイン 0、ピーク -10.1 dBFS。audio-5.1-loud → ゲイン -6.59 dB、DVD上のピーク -1.4 / -1.0 dBFS。audio-mono → 左右とも元と同じ -1.27 dBFS。すべて39項目を通過した。
- すべて LGPL のフィルタ（`pan` `volume` `astats`）で構成している。

### 9.9 AC-3 Bitrate [SW] + [規格]

`scripts/experiments/ac3-bitrate.sh`（ピンクノイズ + スイープ + 高域トーン + バースト、30 s。エンコーダ遅延256サンプルを補正して asdr を計測）。

| Bitrate | SDR L / R | 14 / 16 / 18 kHz 超のエネルギー | 10分 | 2時間 |
| --- | --- | --- | --- | --- |
| 192k | 27.5 / 23.5 dB | 原音と同等 | 14.4 MB | 172.8 MB |
| 224k | 28.6 / 24.1 dB | 同等 | 16.8 MB | 201.6 MB |
| **256k** | **29.9 / 25.1 dB** | 同等 | 19.2 MB | 230.4 MB |
| 448k（参考） | 44.7 / 31.5 dB | 同等 | 33.6 MB | 403.2 MB |

- DVD-Video では AC-3 48 kHz の 32〜448 kbps が有効 **[規格]**。192 / 224 / 256 はいずれも互換性は同じで、PoC では 256k で全サンプルが通過している。
- ffmpeg の AC-3 エンコーダは、どのビットレートでも帯域を削っていなかった。差は量子化ノイズで、192→256 で SDR が約 2 dB 改善する。SDR は知覚上の音質ではなく、聴感評価はしていない。
- 容量への影響: 256k は 192k より 2時間で 57.6 MB（ディスクの約1.2%）多い。72分以下の動画ではビットレートが上限の 8000 kbps のままなので、映像に影響しない。
- **推奨: v1 は 256 kbps 固定。** 可変選択にはしない。

### 9.10 HDR [SW] + [規格]

| 種類 | ffprobe での識別 | 確認状況 |
| --- | --- | --- |
| HDR10 | `color_transfer=smpte2084`、`color_primaries=bt2020`、フレームのサイドデータに `Mastering display metadata` / `Content light level metadata` | 合成サンプルで識別を確認 **[SW]** |
| HLG | `color_transfer=arib-std-b67` | 合成サンプルで識別を確認 **[SW]** |
| Dolby Vision | ストリームのサイドデータ `DOVI configuration record`（`dv_profile`, `dv_bl_signal_compatibility_id`）、`codec_tag` が `dvh1` / `dvhe` | **未確認**（サンプルなし）**[規格]** |
| iPhone HDR | HEVC Main10、BT.2020、HLG + Dolby Vision profile 8.4（HLG互換のベースレイヤー） | **未確認**（サンプルなし）**[規格]** |

- LGPL 構成での候補パイプライン（LGPL 版で動作を確認、1080p 5 s を約 3 s で処理）:

  ```text
  zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,
  tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p
  → 以降は通常の scale/pad（BT.709 → BT.601）
  ```

- 使っているのは `zscale`（libzimg、WTFPL）と `tonemap`（LGPL）。libplacebo は Vulkan / MoltenVK が必要で、Sidecar 構成が重くなるため候補から外した。
- 実素材なしでは確認できないこと: 明るさ・色・白飛びの妥当性、HLG の OOTF の扱い（`npl` の値）、Dolby Vision profile 5（ベースレイヤーが IPTPQc2 で、通常の HDR としてデコードすると色が破綻する）、profile 8.x をベースレイヤーとして扱ってよいか、iPhone 素材の回転や VFR との組み合わせ。
- **推奨: Phase 3 では Experimental 扱い。** HDR10 / HLG はパイプラインを実装するが、既定では「HDR → SDR（実験的）」の警告付きとし、実際の iPhone HLG / DV 8.4 素材と HDR10 素材での評価を終えてから正式対応とする。Dolby Vision profile 5（互換ベースレイヤーなし）は Unsupported として停止する。

### 9.11 No Audio [SW]

```text
No Audio MP4 → anullsrc=r=48000:cl=stereo（-t = 元の長さ）→ AC-3 Stereo 48 kHz 256k → VIDEO_TS → 39項目通過
```

- no-audio（20.020 s）: DVD映像 20.020 s / 無音 AC-3 20.032 s。差 12 ms は AC-3 のフレーム単位（32 ms）以内。VTS の音声属性は通常と同じ（AC-3 / 2ch / 48 kHz）。
- **Phase 3 仕様として採用**: 出力構造を常に「映像1 + AC-3 Stereo 1」に統一する。

### 9.12 Capacity [SW] + [規格]

実測（`rate-control.sh`、LGPL 版、180 s、PoC と同じエンコード設定）:

| 素材 | 目標 | 実測 | 誤差 | PS多重化オーバーヘッド |
| --- | --- | --- | --- | --- |
| ノイズ（最悪ケース） | 2000 | 2001 | +0.04% | 3.17% |
| | 3000 | 3001 | +0.05% | 2.53% |
| | 4000 | 4002 | +0.04% | 2.23% |
| | 5000 | 5002 | +0.03% | 2.03% |
| | 8000 | 8003 | +0.03% | 1.71% |
| 易しい素材 | 2000〜8000 | 同上 | ≤ +0.05% | 3.17〜1.72% |
| 20分長尺（Phase 2） | 8000 | 8001 | +0.01% | 1.71% |

- 2-pass のレート制御は、最悪ケースの素材でも目標から +0.05% 以内に収まった。
- オーバーヘッドはビットレートに依存し、ほぼ「ストリームの 1.16% + 45 kbps」（パックヘッダ・PESヘッダの比率分 + NAVパック等の固定分）。Phase 2 で仮に置いた一律 3% は、低ビットレート（＝容量が効いてくる長尺）では足りない。
- IFO/BUP + ISO9660/UDF + VMG のパディングは、60 s でも 20 分でも約 1 MB。
- 単層ディスクは **DVD+R SL のほうが小さい**: DVD-R SL 2,298,496 sectors（4,707,319,808 B）に対して、DVD+R SL は 2,295,104 sectors（4,700,372,992 B）**[規格]**。

**推奨（PoC に実装済み）:**

```text
TARGET_USABLE_BYTES = 4,550,000,000        # DVD+R SL の 96.8%、約150 MB の余裕
muxed_kbps = (TARGET_USABLE_BYTES × 8 / duration_s / 1000 − 50) / 1.012
video_kbps = min(8000, floor(muxed_kbps − 256))
```

| 長さ | 映像 kbps |
| --- | --- |
| 〜72 分 | 8000（上限） |
| 90 分 | 6355 |
| 120 分 | 4690 |
| 150 分 | 3691 |
| 180 分 | 3024 |
| 240 分 | 2192 |

- 約150 MB の余裕の内訳: ファイルシステム等 1 MB、レート誤差 0.05%（約 2 MB）、未検証の素材のばらつき。オーバーヘッドのモデル（1.2% + 50 kbps）は、実測値の全点より大きい側に置いている。

### 9.13 Low Bitrate Warning [規格] + [SW]

- 合成素材の SSIM は、ビットレートを変えてもほぼ一定（易しい素材で 0.86〜0.89）で、閾値の根拠にならなかった。実素材での評価が必要。
- 参考 **[規格/慣例]**: DVDレコーダーの標準モード SP（2時間）は映像 約 4.6〜5 Mbps、LP（4時間）は約 2.2〜2.5 Mbps。一般に LP では画質の低下が目立つとされる。
- **推奨: `video_kbps < 3500` で警告**（約 2時間35分以上で出る。Hard Error にはしない）。これとは別に、`< 1000 kbps`（約 7.5 時間以上）は「単層DVDに収まらない」として拒否する（PoC 実装済み）。

### 9.14 Duration Tolerance [SW]

- Phase 2 と追加検証での最大差: 映像 0.058 s（23.976 → テレシネ）、音声 0.055 s、IFO 0.042 s。
- 追加検証（60i / 25 / 50 / VFR / 音声系）でも ±0.15 s を超える正常ケースはなかった（最大は VFR の映像 +0.053 s、音声 +0.132 s（元 19.900 s に対して AC-3 20.032 s）。後者は、元の音声が 20.000 s あるのに映像が 19.900 s で終わっているため）。
- **Phase 3 の初期値 ±0.15 s**（PoC に実装済み）。VOBU 1つ分の欠落は約 0.5 s 以上になるので、欠落の検出には影響しない。
- 注意: 映像と音声の長さが元から異なる MP4 では、「元MP4の長さ」を映像・音声それぞれのストリームの長さで比較すべきである（PoC は映像ストリームの長さと比較している）。

---

## 10. Technical findings（Phase 2）

- **`progressive_sequence`**: ffmpeg の既定は 1。DVD-Video では 0 が要求されるとされる **[規格]** ため、`-flags +ildct+ilme -top 1` で 0 にした。その結果、全ピクチャが `progressive_frame=0`（インターレース扱い、TFF）になる。ffmpeg には `progressive_sequence=0` のまま `progressive_frame=1` を出すオプションがない。
- **フルデコード時の偽陽性**: `ffmpeg -v error -i VOB -f null -` は null muxer の `non monotonically increasing dts` を error レベルで約8秒ごとに出す。PES 上の AC-3 PTS は厳密に単調増加しており、ffmpeg の PS デマルチプレクサが補間したタイムスタンプによるもの。Verification では `ffprobe -count_frames` を使う。
- **2-pass とフィルタのタイムスタンプ**: pass 1（`-f null`、VFR扱い）と pass 2（MPEG出力、CFR）では fps_mode が異なり、フィルタ出力のタイムスタンプが不規則だと pass 2 でフレームが増えて失敗する（`Input is longer than 2-pass log file`）。Phase 3 では両パスで `-fps_mode` を明示すべき。
- **dvdauthor**: `VIDEO_FORMAT=NTSC` が必要。1 GiB 手前で VOB を分割する。PGC 再生時間（BCD）は**ノンドロップ 30 fps で数えたフレーム数**なので、`(h·3600 + m·60 + s)·30 + ff` を 1001/30000 倍して秒にする。
- **ISO ツール**: hdiutil `makehybrid` は `VIDEO_TS.IFO` を VOB の後ろに置くため使えない。xorriso は UDF に非対応。
- **ZIP**: Info-ZIP、無圧縮格納（`-0`）。Zip64 対応ビルド。4 GB を超える ZIP は未検証。

---

## 11. Remaining Unresolved

1. **物理DVD互換性すべて**（§12）。とくに次の3点は実機でしか判断できない: 59.94i / テレシネ / 全出力のインターレースフラグ（`progressive_frame=0`）の表示、自前 ISO Writer の互換性、DVD+R / DVD-R メディアでの差。
2. A/V同期の自動検証方法（39項目ではずれを検出できない。§6）。
3. VFR の開始時刻の扱い（-17 ms の一定ずれ）と、スマートフォンの実VFR素材。
4. HDR 全般の画質（実素材なし）。Dolby Vision / iPhone HDR の識別とベースレイヤーの扱い。
5. 5.1 / モノラル以外のチャンネルレイアウト（4.0、7.1 など）のダウンミックス係数。
6. 低ビットレート警告の閾値の実素材での裏付け。
7. 撮影素材・編集ソフト書き出し素材、ProRes 等の他コーデック入力。
8. 4 GB を超える ZIP、ディスク容量に近い長尺（60〜240分）の実測。
9. 720 幅 vs 704 幅の 16:9 解釈。
10. 60i の縦ローパス（ちらつき対策）の要否。
11. 自前 ISO Writer の実装と、mkisofs 出力との互換性の確認（Phase 3）。
12. LGPL 版 FFmpeg の配布用ビルド（zimg の静的リンク、コード署名、ソース提供の方法）。

---

## 12. Physical DVD Verification

**Not physically verified.**

DVD-R / DVD+R への書き込み、家庭用DVDプレーヤーでの再生、結婚式場設備での再生は、一切実施していない。本ドキュメントの **[SW]** の結果は「DVD-Video規格に沿った構造を生成し、ソフトウェアVerificationを通過した」ことだけを示す。

---

## 13. License findings

| Tool | Version | License | 本PoCでの位置付け |
| --- | --- | --- | --- |
| FFmpeg / ffprobe（配布候補） | 7.1 自前ビルド | **LGPL-2.1+**（`--enable-gpl` なし、nonfree なし） | Phase 3 の配布方針。必要機能はすべて揃う（§9.1） |
| FFmpeg（Homebrew） | 7.1_4 | GPL-3.0+ | 開発・サンプル生成のみ。配布しない |
| libzimg | Homebrew | WTFPL | `zscale`（HDR）用 |
| dvdauthor | 0.7.2 | GPL-2.0-or-later | Sidecar 候補。別プロセスとして同梱する場合、GPL に従ったソース提供が必要。MIT の SENA コードとは単なる集積 |
| mkisofs（cdrtools） | 3.02a09 | 本体 GPL-2.0 + CDDL のライブラリ | **Reference 専用**。配布物からは外し、自前 Writer に置き換える方針（§9.2） |
| zip / unzip | Info-ZIP | Info-ZIP license | PoC のみ。Core ではライブラリか `ditto` を選定する |

GPL 専用で使わないもの: `tinterlace`, `interlace`, `cropdetect`（cropdetect は Phase 2 の手動確認でのみ使用）。

---

## 14. Experiments

| Script | 内容 |
| --- | --- |
| `build-ffmpeg-lgpl.sh` | LGPL 版 FFmpeg 7.1 のビルド（`build/`、Git 管理外） |
| `make-motion-sample.sh` | フレーム番号 + 毎秒クリック音入りの素材（CFR / VFR） |
| `motion-probe.mjs` | VOB をフィールド単位で解析（表示された元フレーム、欠落・重複、表示時刻誤差、A/V sync） |
| `downmix.sh` | 5.1 → Stereo の行列比較 |
| `ac3-bitrate.sh` | AC-3 ビットレート比較（SDR、帯域） |
| `rate-control.sh` | 2-pass のレート制御精度、多重化オーバーヘッド、SSIM |
| `iso-structure.mjs` | ISO9660 / UDF 構造のダンプ |
| `regression.sh` | 全サンプルの再実行（任意の FFmpeg を PATH に指定可能） |

`scripts/poc-convert.mjs` のテスト用フック: `POC_FAULT=corrupt-vob`（オーサリング後の VOB を破損させ、Verification が失敗することを確認する）。
