const os = require('os')
const p = require('path')

const pino = require('pino')
const argv = require('yargs').argv
const constants = require('hyperdrive-daemon-client/lib/constants')

// Forever will redirect stdout to the correct log file.
module.exports = pino({
  name: 'hyperdrive',
  level: argv['log-level'] || 'info',
  enabled: true,
}, (process.env['NODE_ENV'] === 'test') ? pino.destination(2) : constants.structuredLog)
