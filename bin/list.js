const request = require('request-promise-native')
const pretty = require('prettier-bytes')
const chalk = require('chalk')

const { loadMetadata } = require('../lib/metadata')

exports.command = 'list'
exports.desc = 'List all mounted Hyperdrives.'
exports.handler = async function (argv) {
  try {
    let metadata = await loadMetadata()
    let rsp = await request.get(new URL('/list', metadata.endpoint).toString(), {
      auth: {
        bearer: metadata.token
      },
      resolveWithFullResponse: true,
      json: true
    })
    if (rsp.statusCode === 200) {
      for (let key of Object.keys(rsp.body)) {
        const { mnt, networking } = rsp.body[key]
        console.log(`${chalk.green(key)} => ${chalk.green(mnt)}`)
        console.log(chalk.yellow(`    Metadata:`))
        console.log(`      Connected Peers: ${networking.metadata.peers}`)
        console.log(`      Uploaded:        ${pretty(networking.metadata.totals.uploadedBytes)}`)
        console.log(`      Downloaded:      ${pretty(networking.metadata.totals.downloadedBytes)}`)
        console.log(chalk.yellow(`    Content:`))
        console.log(`      Connected Peers: ${networking.content.peers}`)
        console.log(`      Uploaded:        ${pretty(networking.content.totals.uploadedBytes)}`)
        console.log(`      Downloaded:      ${pretty(networking.content.totals.downloadedBytes)}`)
      }
    } else {
      console.log(chalk.orange('Cannot get the deamon\'s mount list.'))
    }
  } catch (err) {
    console.error(chalk.red(`Could not get server status: ${err}`))
  }
}
