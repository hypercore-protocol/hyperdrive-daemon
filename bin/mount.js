const p = require('path')
const request = require('request-promise-native')
const chalk = require('chalk')

const { loadMetadata, createMetadata } = require('../lib/metadata')

exports.command = 'mount <mnt> [key]'
exports.desc = 'Mount a hyperdrive at the specified mountpoint.'
exports.builder = {
  sparse: {
    description: 'Create a sparse content feed.',
    type: 'boolean',
    default: true
  },
  sparseMetadata: {
    description: 'Create a sparse metadata feed.',
    type: 'boolean',
    default: true
  }
}
exports.handler = async function (argv) {
  try {
    let metadata = await loadMetadata()
    let body = {
      sparse: argv.sparse,
      sparseMetadata: argv.sparseMetadata,
      key: argv.key,
      mnt: p.resolve(argv.mnt)
    }
    let rsp = await request(`${metadata.endpoint}/mount`, {
      method: 'POST',
      json: true,
      auth: {
        bearer: metadata.token
      },
      body,
      resolveWithFullResponse: true,
    })
    if (rsp.statusCode === 201) {
      let { key, mnt } = rsp.body
      console.log(chalk.green(`Mounted ${key} at ${mnt}`))
    } else {
      console.error(chalk.red(`Could not mount hyperdrive: ${rsp.body}`))
    }
  } catch (err) {
    console.error(chalk.red(`Could not mount hyperdrive: ${err}`))
  }
}

