#!/usr/bin/env node
const fs = require('fs');

if (process.env.STUB_GH_CALLS_LOG) {
  try { fs.appendFileSync(process.env.STUB_GH_CALLS_LOG, `${process.argv.slice(2).join(' ')}\n`); } catch {}
}
if (process.env.STUB_GH_FAIL === '1') process.exit(1);
const state = String(process.env.STUB_GH_STATE || 'NONE').toUpperCase();
process.stdout.write(JSON.stringify(state === 'NONE' ? [] : [{ state }]));
