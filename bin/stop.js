const { URL } = require('url')
const request = require('request-promise-native')
const chalk = require('chalk')

const { loadMetadata } = require('../lib/metadata')

exports.command = 'stop'
exports.desc = 'Stop the Hypermount daemon.'
exports.handler = async function (argv) {
  let metadata = await loadMetadata()
  if (metadata) {
    try {
      await request.post(new URL('/close', metadata.endpoint).toString(), {
        auth: {
          bearer: metadata.token
        }
      })
      console.log(chalk.green(`The Hypermount daemon has been stopped.`))
    } catch (err) {
      console.error(chalk.red(`Could not stop the daemon. Are you using any mountpoints?`))
    }
  }
}
