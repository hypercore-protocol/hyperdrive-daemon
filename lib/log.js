const pino = require('pino')
const argv = require('yargs').argv

// Forever will redirect stdout to the correct log file.
module.exports = pino({
  name: 'hyperdrive',
  level: argv['log-level'] || 'info',
  enabled: true,
}, pino.destination(2))
