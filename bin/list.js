const request = require('request-promise-native')
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
        console.log(`  Network Stats:`)
        console.log(`    Metadata:`)
        console.log(`      Uploaded:   ${networking.metadata.totals.uploadedBytes / 1e6} MB`)
        console.log(`      Downloaded: ${networking.metadata.totals.downloadedBytes / 1e6} MB`)
        console.log(`    Content:`)
        console.log(`      Uploaded:   ${networking.content.totals.uploadedBytes / 1e6} MB`)
        console.log(`      Downloaded: ${networking.content.totals.downloadedBytes / 1e6} MB`)
      }
    } else {
      console.log(chalk.orange('Cannot get the deamon\'s mount list.'))
    }
  } catch (err) {
    console.error(chalk.red(`Could not get server status: ${err}`))
  }
}
