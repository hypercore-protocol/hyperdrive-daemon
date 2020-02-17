#!/usr/bin/env node
const client = require('hyperdrive-daemon-client/cli')

module.exports = client.commandDir('bin')
  .demandCommand()
  .help()
  .argv
