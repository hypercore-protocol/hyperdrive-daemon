const p = require('path')
const { URL } = require('url')
const request = require('request-promise-native')
const chalk = require('chalk')
const forever = require('forever')

const { loadMetadata, createMetadata } = require('../lib/metadata')

exports.command = 'start'
exports.desc = 'Start the Hypermount daemon.'
exports.builder = {
  port: {
    description: 'The HTTP port that the daemon will bind to.',
    type: 'number',
    default: 3101
  },
  replicationPort: {
    description: 'The port that the hypercore replicator will bind to.',
    type: 'number',
    default: 3102
  }
}
exports.handler = async function (argv) {
  let metadata = await loadMetadata()
  if (metadata) {
    try {
      await request.get(new URL('/status', metadata.endpoint).toString(), {
        auth: {
          bearer: metadata.token
        }
      })
    } catch (err) {
      await start(argv)
    }
  } else {
    await start(argv)
  }
}

async function start (argv) {
  let endpoint = `http://localhost:${argv.port}`
  await createMetadata(endpoint)
  forever.startDaemon(p.join(__dirname, '..', 'index.js'), {
    uid: 'hypermount',
    max: 1,
    logFile: './hypermount.log',
    outFile: './hypermount.log',
    errFile: './hypermount.log',
    args: ['--replicationPort', argv.replicationPort, '--port', argv.port]
  })
  console.log(chalk.green(`Daemon started at ${endpoint}`))
}
