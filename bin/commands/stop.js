const ora = require('ora')
const { Command, flags } = require('@oclif/command')

const constants = require('hyperdrive-daemon-client/lib/constants')
const { stop } = require('../../manager')

class StopCommand extends Command {
  static usage = 'stop'
  static description = 'Stop the Hyperdrive daemon.'
  static flags = {
    name: flags.string({
      description: 'The PM2 process name to stop.',
      required: false,
      default: constants.processName
    }),
    port: flags.integer({
      description: 'The gRPC port of the running daemon.',
      required: false,
      default: constants.port
    })
  }

  async run () {
    const { flags } = this.parse(StopCommand)
    const spinner = ora('Stopping the Hyperdrive daemon (might take a while to unannounce)...').start()
    try {
      await stop(flags.name, flags.port)
      spinner.succeed('The Hyperdrive daemon has been stopped.')
    } catch (err) {
      spinner.fail('Could not stop the Hyperdrive daemon:')
      console.error(err)
      this.exit(1)
    }
    this.exit()
  }
}

module.exports = StopCommand
