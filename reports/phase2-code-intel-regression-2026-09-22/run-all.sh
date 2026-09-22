#!/bin/bash
cd /c/dev/Docteur/cortex-server
OUTDIR=../reports/phase2-code-intel-regression-2026-09-22
SUMMARY=$OUTDIR/SUMMARY.txt
> "$SUMMARY"
for f in test-*.mjs; do
  echo "=== $f ===" 
  logfile="$OUTDIR/${f}.log"
  timeout 60 node --test --test-timeout=20000 --experimental-test-module-mocks "$f" > "$logfile" 2>&1
  code=$?
  if [ $code -eq 0 ]; then
    echo "PASS  $f" | tee -a "$SUMMARY"
  else
    echo "FAIL($code)  $f" | tee -a "$SUMMARY"
  fi
done
echo "DONE" >> "$SUMMARY"
