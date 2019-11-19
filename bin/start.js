const p = require('path')

const chalk = require('chalk')
const forever = require('forever')

const { HyperdriveClient } = require('hyperdrive-daemon-client')
const constants = require('hyperdrive-daemon-client/lib/constants')

exports.command = 'start'
exports.desc = 'Start the Hyperdrive daemon.'
exports.builder = {
  port: {
    description: 'The gRPC port that the daemon will bind to.',
    type: 'number',
    default: constants.port
  },
  storage: {
    description: 'The storage directory for hyperdrives and associated metadata.',
    type: 'string',
    default: constants.storage
  },
  'log-level': {
    description: 'The log level',
    type: 'string',
    default: constants.logLevel
  },
  bootstrap: {
    description: 'Comma-separated bootstrap servers to use.',
    type: 'array',
    default: constants.bootstrap
  }
}

exports.handler = async function (argv) {
  const client = new HyperdriveClient(`localhost:${argv.port}`)
  client.ready(err => {
    if (err) return onerror(err)
    console.log(chalk.green('The Hyperdrive daemon is already running.'))
  })

  function onerror (err) {
    if (!err.disconnected) return showError(err)
    start(argv).catch(showError)
  }

  function showError (err) {
    console.error(chalk.red('Could not start the Hyperdrive daemon:'))
    console.error(chalk.red(`   ${err}`))
  }
}

async function start (argv) {
  let endpoint = `localhost:${argv.port}`
  forever.startDaemon(p.join(__dirname, '..', 'index.js'), {
    uid: constants.uid,
    max: 1,
    logFile: constants.unstructuredLog,
    outFile: constants.unstructuredLog,
    errFile: constants.unstructuredLog,
    args: ['--port', argv.port, '--storage', argv.storage, '--log-level', argv['log-level'], '--bootstrap', argv.bootstrap.join(',')]
  })
  console.log(chalk.green(`Daemon started at ${endpoint}`))
}
