#!/usr/bin/env node
const yargs = require('yargs')

yargs.commandDir('bin')
  .demandCommand()
  .help()
  .argv
