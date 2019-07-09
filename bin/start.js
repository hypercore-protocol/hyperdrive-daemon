const p = require('path')
const os = require('os')

const chalk = require('chalk')
const forever = require('forever')

const { createMetadata } = require('../lib/metadata')
const { HyperdriveClient } = require('hyperdrive-daemon-client')

const HYPERDRIVE_DIR = p.join(os.homedir(), '.hyperdrive')

exports.command = 'start'
exports.desc = 'Start the Hyperdrive daemon.'
exports.builder = {
  port: {
    description: 'The gRPC port that the daemon will bind to.',
    type: 'number',
    default: 3101
  },
  storage: {
    description: 'The storage directory for hyperdrives and associated metadata.',
    type: 'string',
    default: p.join(HYPERDRIVE_DIR, 'storage')
  },
  'log-level': {
    description: 'The log level',
    type: 'string',
    default: 'info'
  },
  'bootstrap': {
    description: 'Comma-separated bootstrap servers to use.',
    type: 'array',
    default: []
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
  await createMetadata(endpoint)
  forever.startDaemon(p.join(__dirname, '..', 'index.js'), {
    uid: 'hyperdrive',
    max: 1,
    logFile: './hyperdrive.log',
    outFile: './hyperdrive.log',
    errFile: './hyperdrive.log',
    args: ['--port', argv.port, '--storage', argv.storage, '--log-level', argv['log-level'], '--bootstrap', argv.bootstrap.join(',')]
  })
  console.log(chalk.green(`Daemon started at ${endpoint}`))
}
