#!/usr/bin/env node

const datEncoding = require('dat-encoding')
const forever = require('forever-monitor')
const yargs = require('yargs')

yargs.commandDir('bin')
  .demandCommand()
  .help()
  .argv
