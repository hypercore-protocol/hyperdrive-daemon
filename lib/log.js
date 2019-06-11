const pino = require('pino')

// Forever will redirect stdout to the correct log file.
module.exports = pino({
  name: 'hyperdrive',
  level: 'trace',
  enabled: true,
}, pino.destination(2))
