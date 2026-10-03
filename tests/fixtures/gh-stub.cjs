#!/usr/bin/env node
const fs = require('fs');

let callNumber = 1;
if (process.env.STUB_GH_CALLS_LOG) {
  try {
    if (fs.existsSync(process.env.STUB_GH_CALLS_LOG)) {
      callNumber = fs.readFileSync(process.env.STUB_GH_CALLS_LOG, 'utf8').split('\n').filter(Boolean).length + 1;
    }
    fs.appendFileSync(process.env.STUB_GH_CALLS_LOG, `${process.argv.slice(2).join(' ')}\n`);
  } catch {}
}
if (process.env.STUB_GH_FAIL === '1') process.exit(1);
const selectedState = callNumber > 1 && process.env.STUB_GH_STATE_AFTER_FIRST
  ? process.env.STUB_GH_STATE_AFTER_FIRST : process.env.STUB_GH_STATE;
const state = String(selectedState || 'NONE').toUpperCase();
const headRefOid = process.env.STUB_GH_HEAD_OID || 'head123';
process.stdout.write(JSON.stringify(state === 'NONE' ? [] : [{ state, headRefOid }]));
