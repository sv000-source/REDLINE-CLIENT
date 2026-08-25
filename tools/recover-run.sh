#!/usr/bin/env bash
# =============================================================================
# recover-run.sh — глубокий разбор release-asset REDLINE.Client.exe (v1.8.1-beta)
# Запускается на GitHub Actions-раннере диспетчером с main. Все шаги
# best-effort: сбой одного шага не роняет остальные. Результаты коммитятся
# в ветку arena/01a03a78-redline-client → recovered/release-exe/.
# =============================================================================
set -uo pipefail

BRANCH="arena/01a03a78-redline-client"
WORK="$(pwd)"
DEST="$WORK/recovered/release-exe"
EXE=/tmp/asset/REDLINE.Client.exe
mkdir -p "$DEST" /tmp/asset /tmp/out

log(){ echo "[recover] $(date -u +%H:%M:%S) $*"; }

{
  echo "started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "commit: ${GITHUB_SHA:-?}"
} > "$DEST/STATUS.txt"

# ---------- 1. Скачивание asset ----------
if [ ! -s "$EXE" ]; then
  log "downloading asset…"
  curl -L --fail --retry 3 --retry-delay 5 -o "$EXE" \
    "https://github.com/${GITHUB_REPOSITORY:-sv000-source/REDLINE-CLIENT}/releases/download/v1.8.1-beta/REDLINE.Client.exe" || true
fi
if [ -s "$EXE" ]; then
  {
    echo "size_bytes: $(stat -c %s "$EXE")"
    echo "sha256: $(sha256sum "$EXE" | cut -d' ' -f1)"
    echo "file_type: $(file -b "$EXE")"
  } >> "$DEST/STATUS.txt"
else
  echo "DOWNLOAD_FAILED" >> "$DEST/STATUS.txt"
fi

ASAR_VERDICT="unknown"
PAYLOAD_OK=""

# ---------- 2. PE-структура: все ресурсы и маленькие секции ----------
if [ -s "$EXE" ]; then
  log "7z: unpacking PE…"
  rm -rf /tmp/out/pe
  7z x -y -o/tmp/out/pe "$EXE" > "$DEST/pe-extract-log.txt" 2>&1 || true
  if [ -d /tmp/out/pe/.rsrc ]; then
    rm -rf "$DEST/rsrc"
    mkdir -p "$DEST/rsrc"
    cp -a /tmp/out/pe/.rsrc/. "$DEST/rsrc/" || true
  fi
  mkdir -p "$DEST/sections"
  for s in prot CPADinfo .fptable LZMADEC malloc_h .tls .eh_fram _RDATA .rodata .rsrc_1; do
    if [ -f "/tmp/out/pe/$s" ]; then
      cp "/tmp/out/pe/$s" "$DEST/sections/$(echo "$s" | tr -d '.')-section.bin" || true
    fi
  done
fi

# ---------- 3. ELECTRONASAR — integrity-хэш встроенного app.asar ----------
if [ -f "$DEST/rsrc/1033/INTEGRITY/ELECTRONASAR" ]; then
  log "ELECTRONASAR resource found"
  { echo "--- od ---"; od -A x -t x1z "$DEST/rsrc/1033/INTEGRITY/ELECTRONASAR"; } > "$DEST/electronasar.txt" || true
  python3 - "$DEST/rsrc/1033/INTEGRITY/ELECTRONASAR" > "$DEST/electronasar-parsed.txt" <<'PY' || true
import sys, re
raw = open(sys.argv[1],'rb').read()
print('raw_bytes:', len(raw))
txt = raw.decode('utf-8', 'replace')
print('raw_text:', txt.strip()[:400])
print('sha256_candidates:', re.findall(r'[0-9a-fA-F]{64}', txt))
PY
fi

# ---------- 4. Сравнение хэша с app.asar из репозитория ----------
if [ -f "$WORK/resources/app.asar" ]; then
  log "computing asar header hash candidates…"
  python3 - "$WORK/resources/app.asar" "$DEST/rsrc/1033/INTEGRITY/ELECTRONASAR" > "$DEST/asar-compare.txt" <<'PY' || true
import sys, hashlib, struct, re
data = open(sys.argv[1],'rb').read()
# Структура asar: [4]=pickle размер поля размера, [4:8]=u1 размер pickle заголовка,
# [8:12]=размер строки с паддингом, [12:16]=длина JSON, [16:]=JSON+pad.
# Заголовок = data[0 : 8+u1]; данные файлов начинаются с 8+u1.
u0, u1, u2, u3 = struct.unpack('<IIII', data[:16])
hdr_end = 8 + u1
js = data[16:16+u3]
cands = {
  'sha256_full_header_0_hdr_end':  hashlib.sha256(data[:hdr_end]).hexdigest(),
  'sha256_pickle_payload_8_end':   hashlib.sha256(data[8:hdr_end]).hexdigest(),
  'sha256_json_raw':               hashlib.sha256(js).hexdigest(),
  'sha256_json_padded':            hashlib.sha256(data[16:hdr_end]).hexdigest(),
  'sha256_from_4_hdr_end':         hashlib.sha256(data[4:hdr_end]).hexdigest(),
}
print('repo_asar_size:', len(data))
print('u0_u1_u2_u3:', u0, u1, u2, u3)
print('header_end:', hdr_end)
print('repo_asar_sha256:', hashlib.sha256(data).hexdigest())
for k, v in cands.items(): print(k + ':', v)
exe_hash = None
try:
    raw = open(sys.argv[2],'rb').read().decode('utf-8', 'replace')
    m = re.findall(r'[0-9a-fA-F]{64}', raw)
    if m: exe_hash = m[0].lower()
except Exception as e:
    print('integrity_read_error:', e)
print('exe_integrity_hash:', exe_hash)
if exe_hash and exe_hash in {v.lower() for v in cands.values()}:
    print('VERDICT: ASAR_HEADER_HASH_MATCH — встроенный app.asar идентичен репозиторному (по хэшу заголовка)')
elif exe_hash:
    print('VERDICT: ASAR_HEADER_HASH_MISMATCH — совпадений нет (другой asar либо другая формула)')
else:
    print('VERDICT: NO_INTEGRITY_HASH')
PY
  if grep -q "ASAR_HEADER_HASH_MATCH\b" "$DEST/asar-compare.txt" 2>/dev/null; then ASAR_VERDICT="header-hash-match"; fi
  if grep -q "ASAR_HEADER_HASH_MISMATCH" "$DEST/asar-compare.txt" 2>/dev/null; then ASAR_VERDICT="header-hash-mismatch"; fi
fi

# ---------- 5. Скан подписей встроенных архивов ----------
if [ -s "$EXE" ]; then
  log "scanning for embedded archive signatures…"
  python3 - "$EXE" > "$DEST/signature-scan.txt" <<'PY' || true
import sys
data = open(sys.argv[1],'rb').read()
sigs = {
  '7z':        bytes.fromhex('377ABCAF271C'),
  'zip':       b'PK\x03\x04',
  'zstd':      bytes.fromhex('28B52FFD'),
  'gzip':      b'\x1f\x8b\x08',
  'cab':       b'MSCF',
  'rar':       b'Rar!\x1a\x07',
  'asar_json': b'{"files"',
}
for name, sig in sigs.items():
    offs = []
    start = 0
    while len(offs) < 40:
        i = data.find(sig, start)
        if i < 0: break
        offs.append(i); start = i + 1
    print(f'{name}: first40_count={len(offs)} offsets={offs[:20]}')
PY
fi

# ---------- 6. Вырезание и распаковка 7z-пейлоада ----------
if [ -s "$EXE" ]; then
  FIRST7Z=$(python3 -c "
data=open('$EXE','rb').read()
print(data.find(bytes.fromhex('377ABCAF271C')))" 2>/dev/null || true)
  if [ -n "$FIRST7Z" ] && [ "$FIRST7Z" != "-1" ] && [ "$FIRST7Z" -gt 0 ] 2>/dev/null; then
    log "carving 7z payload at offset $FIRST7Z…"
    python3 -c "
data=open('$EXE','rb').read()
open('/tmp/out/payload.7z','wb').write(data[$FIRST7Z:])" || true
    if 7z t /tmp/out/payload.7z >/dev/null 2>&1; then
      log "valid 7z payload — extracting…"
      rm -rf /tmp/out/payload
      7z x -y -o/tmp/out/payload /tmp/out/payload.7z > "$DEST/payload-extract-log.txt" 2>&1 || true
      if [ -n "$(find /tmp/out/payload -type f 2>/dev/null | head -1)" ]; then
        PAYLOAD_OK=1
      fi
    else
      echo "carved_7z_offset_${FIRST7Z}_test_failed" >> "$DEST/STATUS.txt"
      7z l /tmp/out/payload.7z > "$DEST/payload-7z-listing.txt" 2>&1 || true
    fi
  fi
fi

# ---------- 7. Маркеры несжатых данных ----------
if [ -s "$EXE" ]; then
  python3 - "$EXE" > "$DEST/marker-scan.txt" <<'PY' || true
import sys
data = open(sys.argv[1],'rb').read()
markers = [b'REDLINE', b'AccarTunnelBot', b'TUN CORE', b'happ-redline', b'app.asar',
           b'chrome_100_percent', b'winws', b'sing-box', b'DPI SHIELD', b'xray.exe',
           b'Local Operator', b'redline://']
for m in markers:
    print(f'{m.decode(errors="replace")}: count={data.count(m)} first_offset={data.find(m)}')
PY
fi

# ---------- 8. Строки для идентификации упаковщика ----------
if [ -s "$EXE" ]; then
  {
    strings -n 6 "$EXE" | grep -aiE 'enigma|vmprotect|themida|upx!|aspack|molebox|boxedapp|nsis|inno setup|sfx|electron.?builder|app-builder|7-?zip' | sort | uniq -c | sort -rn | head -30
  } > "$DEST/packer-strings.txt" || true
fi

# ---------- 9. Сбор урожая с пейлоада ----------
if [ -n "$PAYLOAD_OK" ]; then
  log "harvesting payload…"
  find /tmp/out/payload -type f -printf '%s\t%p\n' 2>/dev/null | sort -k2 > "$DEST/payload-files.txt" || true
  ASAR_PATHS=$(find /tmp/out/payload -name '*.asar' 2>/dev/null | head -5)
  if [ -n "$ASAR_PATHS" ]; then
    rm -rf "$DEST/payload-extracted"
    mkdir -p "$DEST/payload-extracted"
    for a in $ASAR_PATHS; do
      cp "$a" "$DEST/payload-extracted/$(basename "$a")" || true
    done
    find "$DEST/payload-extracted" -name '*.asar' -exec sha256sum {} \; > "$DEST/payload-asar-hashes.txt" || true
    REPO_ASAR_SHA=$(sha256sum "$WORK/resources/app.asar" 2>/dev/null | cut -d' ' -f1)
    for a in $ASAR_PATHS; do
      if [ "$(sha256sum "$a" | cut -d' ' -f1)" = "$REPO_ASAR_SHA" ]; then ASAR_VERDICT="byte-identical"; fi
    done
  fi
  ( cd "$WORK" && git ls-files -s | awk '{print $4"\t"$2}' | sort > /tmp/out/repo-index.txt ) || true
  ( cd /tmp/out/payload && find . -type f | sed 's|^\./||' | while read -r f; do
      printf '%s\t%s\n' "$f" "$(git hash-object "$f" 2>/dev/null)"
    done | sort > /tmp/out/payload-index.txt ) || true
  python3 - > "$DEST/payload-compare-repo.txt" <<'PY' || true
repo = {}
for line in open('/tmp/out/repo-index.txt'):
    p = line.rstrip('\n').split('\t')
    if len(p) == 2: repo[p[0]] = p[1]
pl = {}
try:
    for line in open('/tmp/out/payload-index.txt'):
        p = line.rstrip('\n').split('\t')
        if len(p) == 2: pl[p[0]] = p[1]
except FileNotFoundError:
    pass
new = sorted(set(pl) - set(repo))
ch = sorted(p for p in set(pl) & set(repo) if pl[p] != repo[p])
miss = sorted(set(repo) - set(pl))
print('NEW in payload (%d):' % len(new))
for p in new[:200]: print('  +', p)
print('CHANGED vs repo (%d):' % len(ch))
for p in ch[:200]: print('  ~', p)
print('In repo but NOT in payload (%d):' % len(miss))
for p in miss[:80]: print('  -', p)
PY
fi

# ---------- 10. Wine-самораспаковка (последний шанс) ----------
if [ -s "$EXE" ] && [ -z "$PAYLOAD_OK" ] && [ "$ASAR_VERDICT" != "byte-identical" ] && [ "$ASAR_VERDICT" != "header-hash-match" ]; then
  log "trying wine self-extraction…"
  ( sudo apt-get update -qq && sudo apt-get install -y -qq wine64 xvfb >/dev/null 2>&1 ) || true
  if command -v wine64 >/dev/null 2>&1 || command -v wine >/dev/null 2>&1; then
    export WINEDEBUG=-all WINEPREFIX=/tmp/wineprefix
    wineboot -i >/dev/null 2>&1 || true
    ( Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & ) || true
    sleep 2
    export DISPLAY=:99
    ( timeout 160 wine64 "$EXE" >/tmp/out/wine.log 2>&1 || true ) &
    sleep 95
    log "harvesting wine temp…"
    find /tmp/wineprefix/drive_c -type f -path '*emp*' -printf '%s\t%p\n' 2>/dev/null | sort -k2 | head -400 > "$DEST/wine-temp-listing.txt" || true
    ASAR_PATHS=$(find /tmp/wineprefix/drive_c -name '*.asar' 2>/dev/null | head -5)
    if [ -n "$ASAR_PATHS" ]; then
      mkdir -p "$DEST/payload-extracted"
      for a in $ASAR_PATHS; do
        cp "$a" "$DEST/payload-extracted/$(basename "$a")" || true
      done
      find "$DEST/payload-extracted" -name '*.asar' -exec sha256sum {} \; > "$DEST/payload-asar-hashes.txt" || true
      REPO_ASAR_SHA=$(sha256sum "$WORK/resources/app.asar" 2>/dev/null | cut -d' ' -f1)
      for a in $ASAR_PATHS; do
        if [ "$(sha256sum "$a" | cut -d' ' -f1)" = "$REPO_ASAR_SHA" ]; then ASAR_VERDICT="byte-identical"; fi
      done
    fi
    cp /tmp/out/wine.log "$DEST/wine-log.txt" 2>/dev/null || true
    pkill -f wine64 2>/dev/null || true
    pkill -f Xvfb 2>/dev/null || true
  else
    echo "wine_not_available" >> "$DEST/STATUS.txt"
  fi
fi

# ---------- 11. Итог и коммит ----------
{
  echo "finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "asar_verdict: $ASAR_VERDICT"
  echo "payload_extracted: ${PAYLOAD_OK:-no}"
} >> "$DEST/STATUS.txt"
log "verdict: $ASAR_VERDICT / payload: ${PAYLOAD_OK:-no}"

cd "$WORK"
git config user.name "arena-recovery-bot" || true
git config user.email "arena-recovery@users.noreply.github.com" || true
git add recovered || true
if git diff --cached --quiet; then
  log "nothing to commit"
else
  git commit -m "Глубокий разбор REDLINE.Client.exe: verdict=$ASAR_VERDICT [skip ci]" || true
  git push origin "HEAD:refs/heads/$BRANCH" || true
fi
log "done"
