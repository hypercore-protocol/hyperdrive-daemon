const p = require('path')

const ora = require('ora')
const chalk = require('chalk')
const pm2 = require('pm2')
const mkdirp = require('mkdirp')

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
  let spinner = ora(chalk.blue('Starting the Hyperdrive daemon...')).start()
  mkdirp(constants.root, err => {
    if (err) return onerror(`Could not create storage directory: ${constants.root}`)
    pm2.connect(err => {
      if (err) return onerror('Could not connect to the process manager to start the daemon.')
      pm2.start({
        script: p.join(__dirname, '..', 'index.js'),
        name: 'hyperdrive',
        autorestart: false,
        output: constants.unstructuredLog,
        error: constants.unstructuredLog,
        args: ['--port', argv.port, '--storage', argv.storage, '--log-level', argv['log-level'], '--bootstrap', argv.bootstrap.join(',')],
        interpreterArgs: '--max-old-space-size=4096'
      }, err => {
        pm2.disconnect()
        if (err) return onerror(`The daemon did not start successfully: ${err}`)
        return onsuccess()
      })
    })
  })

  function onerror (err) {
    spinner.fail(chalk.red(err))
  }

  function onsuccess () {
    spinner.succeed(chalk.green(`Hyperdrive daemon listening on ${endpoint}`))
  }
}
