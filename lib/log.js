const pino = require('pino')

// Forever will redirect stdout to the correct log file.
module.exports = pino({
  name: 'hypermount',
  level: 'debug',
  enabled: true,
})
