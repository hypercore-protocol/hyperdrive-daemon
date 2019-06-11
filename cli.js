#!/usr/bin/env node
const client = require('hyperdrive-daemon-client/cli')

client.commandDir('bin')
  .demandCommand()
  .help()
  .argv



