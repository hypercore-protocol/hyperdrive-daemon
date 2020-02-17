const ora = require('ora')
const chalk = require('chalk')

const constants = require('hyperdrive-daemon-client/lib/constants')
const { stop } = require('../manager')

exports.command = 'stop'
exports.desc = 'Stop the Hyperdrive daemon.'
exports.builder = {
  name: {
    description: 'The process name of the daemon to stop.',
    type: 'string',
    defaults: constants.processName
  },
  port: {
    description: 'The gRPC port of the running daemon.',
    type: 'number',
    default: constants.port
  }
}

exports.handler = async function (argv) {
  const spinner = ora(chalk.blue('Stopping the Hyperdrive daemon (might take a while to unannounce)...')).start()
  try {
    await stop(argv.name, argv.port)
    return onsuccess()
  } catch (err) {
    return onerror(err)
  }

  function onerror (err) {
    spinner.fail(chalk.red(err))
    process.exit(1)
  }
  function onsuccess () {
    spinner.succeed(chalk.green('The Hyperdrive daemon has been stopped.'))
    process.exit(0)
  }
}
