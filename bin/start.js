const p = require('path')

const ora = require('ora')
const chalk = require('chalk')
const mkdirp = require('mkdirp')

const constants = require('hyperdrive-daemon-client/lib/constants')
const { start } = require('../manager')

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
    default: constants.root
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
  },
  'memory-only': {
    description: 'Use in-memory storage only.',
    type: 'boolean',
    default: false
  },
  '--foreground': {
    description: 'Run the daemon in the foreground without detaching it from the launch process.',
    type: 'boolean',
    default: false
  }
}

exports.handler = async function (argv) {
  let spinner = ora(chalk.blue('Starting the Hyperdrive daemon...')).start()
  try {
    const { opts } = await start(argv)
    return onsuccess(opts)
  } catch (err) {
    return onerror(err)
  }

  function onerror (err) {
    spinner.fail(chalk.red(err))
    if (!argv.foreground) process.exit(1)
  }
  function onsuccess (opts) {
    spinner.succeed(chalk.green(`Hyperdrive daemon listening on ${opts.endpoint}`))
    if (!argv.foreground) process.exit(0)
  }
}
