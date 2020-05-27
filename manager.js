const fs = require('fs').promises
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

  const client = new HyperdriveClient({ endpoint: opts.endpoint, storage: initialOpts.storage || opts.root })
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
  opts.noDebug = opts['no-debug']
  opts.logLevel = opts['log-level']

  /**
   * HACK
   * If 'pm2' detects a space in the 'script' path, it assumes the call is something like "python foo.py".
   * When that's the case, it transforms the call into `/bin/bash -c python foo.py`.
   * This creates a problem for some hyperdrive apps because they may have spaces in their install paths.
   * The resulting call ends up being `${interpreter} /bin/bash -c ${script}`, which is wrong.
   * (To add a little more complexity, it does *not* do this on Windows.)
   *
   * To solve that, we craft the pm2 call to use '/bin/bash -c' correctly.
   * -prf
   */
  const IS_WINDOWS = (process.platform === 'win32' || process.platform === 'win64' || /^(msys|cygwin)$/.test(process.env.OSTYPE))
  var script = p.join(__dirname, 'index.js')

  var args = []
  if (opts.port) args.push('--port', opts.port)
  if (opts.storage) args.push('--storage', opts.storage)
  if (opts.logLevel) args.push('--log-level', opts.logLevel)
  if (opts.memoryOnly) args.push('--memory-only')
  if (opts.noAnnounce) args.push('--no-announce')
  if (opts.noDebug) args.push('--no-debug')

  if (opts.bootstrap === false) args.push('--bootstrap', false)
  else if (Array.isArray(opts.bootstrap) && opts.bootstrap.length) args.push('--bootstrap', opts.bootstrap.join(','))

  var interpreter = opts.interpreter || process.execPath
  var interpreterArgs = [`--max-old-space-size=${opts.heapSize}`]
  if (!IS_WINDOWS) {
    const execArg = [interpreter, interpreterArgs, script].concat(args).map(escapeStringArg).join(' ')
    args = ['-c', execArg]
    script = 'bash'
    interpreter = undefined
    interpreterArgs = undefined
  }

  const description = {
    script,
    args,
    interpreter,
    interpreterArgs,
    name: opts.processName || 'hyperdrive',
    env: opts.env || process.env,
    output: opts.unstructuredLog,
    error: opts.structuredLog,
    killTimeout: 10000,
    autorestart: false
  }

  try {
    if (opts.structuredLog === constants.structuredLog) {
      await fs.rename(constants.structuredLog, constants.structuredLog.replace('.json', '.old.json'))
    }
    if (opts.unstructuredLog === constants.unstructuredLog) {
      await fs.rename(constants.unstructuredLog, constants.unstructuredLog.replace('.log', '.old.log'))
    }
  } catch (err) {
    // If the log file couldn't be rotated, it's OK.
  }

  if (opts.foreground) {
    return startForeground(description, opts)
  } else {
    return startDaemon(description, opts)
  }

  function startForeground (description, opts) {
    const daemon = new HyperdriveDaemon({ ...opts, metadata: null, main: true })
    process.title = 'hyperdrive'
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
    daemon.start()
    return { opts, description }
  }

  function startDaemon (description, opts) {
    return new Promise((resolve, reject) => {
      pm2.connect(!!opts.noPM2DaemonMode, err => {
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

function escapeStringArg (v) {
  return (typeof v === 'string' && v.includes(' ')) ? `"${v}"` : v
}
