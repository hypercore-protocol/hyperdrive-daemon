const p = require('path')

const mkdirp = require('mkdirp')
const pm2 = require('pm2')

const { HyperdriveClient } = require('hyperdrive-daemon-client')
const constants = require('hyperdrive-daemon-client/lib/constants')

const HyperdriveDaemon = require('.')

async function start (opts = {}) {
  const initialOpts = opts
  opts = { ...constants, ...opts }
  opts.endpoint = `localhost:${opts.port}`

  if (opts.env && !opts.env.PATH) {
    opts.env = { ...opts.env, PATH: process.env.PATH }
  }

  const client = new HyperdriveClient(opts.endpoint, { storage: initialOpts.storage || opts.root })
  const running = await new Promise((resolve, reject) => {
    client.ready(err => {
      if (!err) return resolve(true)
      if (err.versionMismatch) return reject(new Error(`Daemon is already running with incompatible version: ${err.version}`))
      return resolve(false)
    })
  })
  if (running) return { opts }

  await new Promise((resolve, reject) => {
    const storagePath = p.join(opts.storage, 'storage')
    mkdirp(storagePath, err => {
      if (err) return reject(new Error(`Could not create storage directory: ${storagePath}`))
      return resolve()
    })
  })

  opts.memoryOnly = opts['memory-only']
  opts.noAnnounce = opts['no-announce']
  opts.logLevel = opts['log-level']

  const description = {
    script: p.join(__dirname, 'index.js'),
    args: [
      '--port', opts.port,
      '--storage', opts.storage,
      '--log-level', opts.logLevel,
      '--bootstrap', opts.bootstrap.join(','),
      '--memory-only', !!opts.memoryOnly,
      '--telemetry', !!opts.telemetry,
      '--no-announce', !!opts.noAnnounce
    ],
    interpreter: opts.interpreter || process.execPath,
    interpreterArgs: `--max-old-space-size=${opts.heapSize}`,
    name: opts.processName || 'hyperdrive',
    env: opts.env || process.env,
    output: opts.unstructuredLog,
    error: opts.structuredLog,
    killTimeout: 10000,
    autorestart: false
  }

  if (opts.foreground) {
    return startForeground(description, opts)
  } else {
    return startDaemon(description, opts)
  }

  function startForeground (description, opts) {
    const daemon = new HyperdriveDaemon({ ...opts, metadata: null, main: true })
    daemon.start()
    return { opts, description }
  }

  function startDaemon (description) {
    return new Promise((resolve, reject) => {
      pm2.connect(err => {
        if (err) return reject(new Error('Could not connect to the process manager to start the daemon.'))
        pm2.start(description, err => {
          pm2.disconnect()
          if (err) return reject(err)
          return resolve({ opts, description })
        })
      })
    })
  }
}

async function stop (name, port) {
  name = name || constants.processName
  port = port || constants.port

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
