const request = require('request-promise-native')
const chalk = require('chalk')

const { loadMetadata } = require('../lib/metadata')

exports.command = 'status'
exports.desc = 'Get information about the hypermount daemon.'
exports.handler = async function (argv) {
  try {
    let metadata = await loadMetadata()
    let rsp = await request.get(new URL('/status', metadata.endpoint).toString(), {
      auth: {
        bearer: metadata.token
      },
      resolveWithFullResponse: true
    })
    if (rsp.statusCode === 200) {
      console.log(chalk.green('The daemon is up and running!'))
    } else {
      console.log(chalk.orange('Cannot get the deamon\'s status. Did you start it?'))
    }
  } catch (err) {
    console.error(chalk.red(`Could not get server status: ${err}`))
  }
}
