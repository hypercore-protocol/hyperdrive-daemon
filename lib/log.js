const pino = require('pino')
const argv = require('yargs').argv

module.exports = pino({
  name: 'hyperdrive',
  level: argv['log-level'] || 'info',
  enabled: true
}, pino.destination(2))
