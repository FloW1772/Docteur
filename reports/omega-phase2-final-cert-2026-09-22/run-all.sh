#!/bin/bash
cd /c/dev/Docteur/cortex-server
OUTDIR=../reports/omega-phase2-final-cert-2026-09-22
SUMMARY=$OUTDIR/SUMMARY.txt
> "$SUMMARY"
for f in test-*.mjs; do
  logfile="$OUTDIR/${f}.log"
  timeout 60 node --test --test-timeout=20000 --experimental-test-module-mocks "$f" > "$logfile" 2>&1
  code=$?
  tests=$(grep -m1 "^# tests" "$logfile" | grep -oE "[0-9]+")
  pass=$(grep -m1 "^# pass" "$logfile" | grep -oE "[0-9]+")
  fail=$(grep -m1 "^# fail" "$logfile" | grep -oE "[0-9]+")
  cancelled=$(grep -m1 "^# cancelled" "$logfile" | grep -oE "[0-9]+")
  if [ $code -eq 0 ]; then
    echo "PASS  $f  tests=$tests pass=$pass fail=$fail cancelled=$cancelled" >> "$SUMMARY"
  else
    echo "FAIL($code)  $f  tests=$tests pass=$pass fail=$fail cancelled=$cancelled" >> "$SUMMARY"
  fi
done
echo "DONE" >> "$SUMMARY"
