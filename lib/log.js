const os = require('os')
const p = require('path')

const pino = require('pino')
const argv = require('yargs').argv

// TODO: Move to a consts file.
const LOGFILE = p.join(os.homedir(), '.hyperdrive', 'log.json')

// Forever will redirect stdout to the correct log file.
module.exports = pino({
  name: 'hyperdrive',
  level: argv['log-level'] || 'info',
  enabled: true,
}, LOGFILE)
