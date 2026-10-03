#!/usr/bin/env node
const fs = require('fs');

if (process.env.STUB_LAUNCHCTL_LOG) {
  try { fs.appendFileSync(process.env.STUB_LAUNCHCTL_LOG, `${process.argv.slice(2).join(' ')}\n`); } catch {}
}
process.exit(process.env.STUB_LAUNCHCTL_FAIL === '1' ? 1 : 0);
