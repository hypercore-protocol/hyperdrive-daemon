const p = require('path')
const request = require('request-promise-native')
const chalk = require('chalk')

const { loadMetadata, createMetadata } = require('../lib/metadata')

exports.command = 'unmount <mnt>'
exports.desc = 'Unmount the hyperdrive that was mounted at the specified mountpoint.'
exports.handler = async function (argv) {
  try {
    let metadata = await loadMetadata()
    let body = {
      mnt: p.resolve(argv.mnt)
    }
    let rsp = await request(`${metadata.endpoint}/unmount`, {
      method: 'POST',
      json: true,
      auth: {
        bearer: metadata.token
      },
      body,
      resolveWithFullResponse: true,
    })
    if (rsp.statusCode === 200) {
      console.log(chalk.green(`Unmounted hyperdrive at ${argv.mnt}`))
    } else {
      console.error(chalk.red(`Could not unmount hyperdrive: ${rsp.body}`))
    }
  } catch (err) {
    console.error(chalk.red(`Could not unmount hyperdrive: ${err}`))
  }
}
