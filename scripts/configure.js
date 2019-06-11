#!/usr/bin/env node
const hyperfuse = require('hyperdrive-fuse')

hyperfuse.configure(err => {
  if (err) return process.exit(1)
  return process.exit(0)
})
