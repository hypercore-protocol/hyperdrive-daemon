const ora = require('ora')
const { Command, flags } = require('@oclif/command')

const constants = require('hyperdrive-daemon-client/lib/constants')
const { start } = require('../../manager')

class StartCommand extends Command {
  static usage = 'start'
  static description = 'Start the Hyperdrive daemon.'
  static flags = {
    port: flags.integer({
      description: 'The gRPC port that the daemon will bind to.',
      default: constants.port
    }),
    storage: flags.string({
      description: 'The storage directory for hyperdrives and associated metadata.',
      default: constants.root
    }),
    'log-level': flags.string({
      description: 'The log level',
      default: constants.logLevel
    }),
    bootstrap: flags.string({
      description: 'Comma-separated bootstrap servers to use.',
      default: constants.bootstrap,
      parse: bootstrapString => {
        return bootstrapString.split(',')
      }
    }),
    'memory-only': flags.boolean({
      description: 'Use in-memory storage only.',
      default: false
    }),
    foreground: flags.boolean({
      description: 'Run the daemon in the foreground without detaching it from the launch process.',
      default: false
    }),
    'no-announce': flags.boolean({
      description: 'Never announce read-only drives on the swarm by default.',
      default: false
    }),
    'no-debug': flags.boolean({
      description: 'Disable debugging-related RPC methods.',
      default: false
    })
  }

  async run () {
    const self = this
    const { flags } = this.parse(StartCommand)

    const spinner = ora('Starting the Hyperdrive daemon...').start()
    try {
      const { opts } = await start(flags)
      spinner.succeed(`Hyperdrive daemon listening on ${opts.endpoint}`)
    } catch (err) {
      spinner.fail(err)
      if (!flags.foreground) this.exit(1)
    }
    if (!flags.foreground) this.exit()
  }
}

module.exports = StartCommand
