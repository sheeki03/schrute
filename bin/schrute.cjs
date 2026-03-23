#!/usr/bin/env node
'use strict';
const major = parseInt(process.version.slice(1), 10);
if (major < 22) {
  console.error(`Error: Node >= 22 required (found ${process.version}). Run: nvm use 22`);
  process.exit(1);
}
import('../dist/index.js');
