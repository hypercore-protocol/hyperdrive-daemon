const p = require('path')
const mkdirp = require('mkdirp')
const pm2 = require('pm2')

const { HyperdriveClient } = require('hyperdrive-daemon-client')
const constants = require('hyperdrive-daemon-client/lib/constants')

async function start (opts = {}) {
  opts = { ...constants, ...opts }
  opts.endpoint = `localhost:${opts.port}`

  const client = new HyperdriveClient(opts.endpoint)
  const running = await new Promise((resolve, reject) => {
    client.ready(err => {
      if (!err) return resolve(true)
      if (err.versionMismatch) return reject(new Error(`Daemon is already running with incompatible version: ${err.version}`))
      return resolve(false)
    })
  })
  if (running) return { opts }

  return new Promise((resolve, reject) => {
    mkdirp(constants.root, err => {
      if (err) return reject(new Error(`Could not create storage directory: ${constants.root}`))
      pm2.connect(err => {
        if (err) return reject(new Error('Could not connect to the process manager to start the daemon.'))
        const description = {
          script: p.join(__dirname, 'index.js'),
          name: opts.processName,
          autorestart: true,
          output: opts.unstructuredLog,
          error: opts.structuredLog,
          args: ['--port', opts.port, '--storage', opts.storage, '--log-level', opts.logLevel, '--bootstrap', opts.bootstrap.join(',')],
          interpreterArgs: `--max-old-space-size=${opts.heapSize}`
        }
        pm2.start(description, err => {
          pm2.disconnect()
          if (err) return reject(err)
          return resolve({ opts, description })
        })
      })
    })
  })
}

async function stop (name, port) {
  name = name || constants.processName
  port = port || constants.port

  const client = new HyperdriveClient(`localhost:${port}`)
  const running = await new Promise((resolve, reject) => {
    client.ready(err => {
      if (!err) return resolve(true)
      if (err.versionMismatch) return reject(new Error(`Daemon is already running with incompatible version: ${err.version}`))
      return resolve(false)
    })
  })
  if (!running) return null

  return new Promise((resolve, reject) => {
    pm2.connect(err => {
      if (err) return reject(new Error('Could not connect to the process manager to stop the daemon.'))
      pm2.delete(name, err => {
        pm2.disconnect()
        if (err) return reject(err)
        return resolve()
      })
    })
  })
}

module.exports = {
  start,
  stop
}
