#!/usr/bin/env bash
# test_orchestrate_index_resolution.sh — proves orchestrate.sh resolves --index to a matcher-ready DIRECTORY
# from EITHER a directory (offline / tests / package_path mount — unchanged, byte-identical) OR a single .tar
# artifact (the live shape: engine mounts ONE blob_ref file, this process untars it). Fail-closed on anything
# else. The success cases here stop BEFORE run_match (junk subject args) so the test needs no heavy matcher deps
# — it asserts only the index-resolution branch (unpack happens before `exec run_match`).
#
# Run: bash test_orchestrate_index_resolution.sh   ->   exit 0 = all PASS, exit 1 = a FAIL.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ORCH="$HERE/orchestrate.sh"
T="$(mktemp -d)"
fails=0
pass(){ echo "  PASS $1"; }
fail(){ echo "  FAIL $1"; fails=$((fails+1)); }

# a fake 2-entry materialized index dir + its tar artifact
mkdir -p "$T/idx/_work"
echo '{"schema":"motion-clip-descriptor.v1"}' > "$T/idx/k1.desc.json"
echo '{"schema":"motion-clip-descriptor.v1"}' > "$T/idx/k2.desc.json"
echo '{"fps":30}' > "$T/idx/_work/k1.kp.json"
echo '{"fps":30}' > "$T/idx/_work/k2.kp.json"
tar -cf "$T/index.tar" -C "$T/idx" .

echo "=== tar artifact unpacks to a matcher-ready dir (before run_match) ==="
bash "$ORCH" --subject-desc "$T/missing.json" --subject-kp "$T/missing.kp.json" --index "$T/index.tar" --out "$T/out" 2>"$T/errB" >/dev/null
grep -q "unpacked index artifact" "$T/errB" && pass "unpack marker emitted" || fail "no unpack marker"
[ -f "$T/out/_index_unpacked/k1.desc.json" ] && [ -f "$T/out/_index_unpacked/k2.desc.json" ] && pass "both .desc.json unpacked at top level" || fail "desc files missing"
[ -f "$T/out/_index_unpacked/_work/k1.kp.json" ] && [ -f "$T/out/_index_unpacked/_work/k2.kp.json" ] && pass "both kp.json unpacked under _work/" || fail "kp files missing"

echo "=== nonexistent --index is fail-closed (exit 2) ==="
bash "$ORCH" --subject-desc x --subject-kp y --index "$T/nope" --out "$T/o2" 2>"$T/errC" >/dev/null; rc=$?
[ "$rc" = 2 ] && pass "exit 2" || fail "exit $rc (expected 2)"
grep -q "neither a directory nor a file" "$T/errC" && pass "fail-closed message" || fail "wrong message"

echo "=== non-tar file --index is fail-closed (exit 2) ==="
echo "not a tar" > "$T/junk.bin"
bash "$ORCH" --subject-desc x --subject-kp y --index "$T/junk.bin" --out "$T/o3" 2>"$T/errD" >/dev/null; rc=$?
[ "$rc" = 2 ] && pass "exit 2" || fail "exit $rc (expected 2)"
grep -q "not a readable tar" "$T/errD" && pass "fail-closed message" || fail "wrong message"

echo "=== orchestrate.sh parses clean ==="
bash -n "$ORCH" && pass "syntax ok" || fail "syntax error"

mv "$T" "/tmp/trash-orchestrate-index-test-$$" 2>/dev/null || true
echo "RESULT: $([ $fails -eq 0 ] && echo PASS || echo "FAIL ($fails)")"
exit $([ $fails -eq 0 ] && echo 0 || echo 1)
