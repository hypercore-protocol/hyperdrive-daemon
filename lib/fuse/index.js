const { EventEmitter } = require('events')
const crypto = require('crypto')

const hyperdrive = require('hyperdrive')
const datEncoding = require('dat-encoding')
const Stat = require('hyperdrive/lib/stat')
const hyperfuse = require('hyperdrive-fuse')

const { rpc } = require('hyperdrive-daemon-client')
const { fromHyperdriveOptions, toHyperdriveOptions } = require('hyperdrive-daemon-client/lib/common')

const log = require('../log').child({ component: 'fuse-manager' })

class FuseManager extends EventEmitter {
  constructor (megastore, driveManager, db, opts) {
    super()

    this.megastore = megastore
    this.driveManager = driveManager
    this.db = db
    this.opts = opts

    // TODO: Replace with an LRU cache.
    this._handlers = new Map()

    // Set in ready.
    this._rootDrive = null
    this._rootMnt = null
    this._rootHandler = null
  }

  async ready () {
    return this._refreshMount()
  }

  async _refreshMount () {
    try {
      const rootDriveMeta = await this.db.get('root-drive')
      log.debug({ rootDriveMeta }, 'got this')
      const { opts, mnt } = rootDriveMeta
      log.debug({ opts, mnt }, 'refreshing mount on restart')
      await this.mount(mnt, opts)
    } catch (err) {
      if (!err.notFound) throw err
      return null
    }
  }

  _getHandlerMapper () {
    const self = this
    const handlerIndex = new Map()

    const RootListHandler = {
      id: 'root',
      test: '^\/$',
      search: /^\/$/,
      ops: ['readdir'],
      handler: (op, match, args, cb) => {
        log.trace('in root handler')
        return this._rootHandler['readdir'].apply(null, [...args, (err, list) => {
          if (err) return cb(err)
          return cb(0, [...list, 'by-key', 'stats', 'active'])
        }])
      }
    }

    const NonWritableRootHandler = {
      id: 'nowriteroot',
      test: '^\/\\w+\/?$',
      search: /./,
      ops: ['write', 'truncate', 'setxattr', 'chown', 'chmod', 'mkdir', 'create', 'utimens', 'rmdir', 'unlink'],
      handler: (op, match, args, cb) => {
        // The top-level directory is not writable
        return process.nextTick(cb, -1)
      }
    }

    const ByKeyHandler = {
      id: 'bykey',
      test: '^\/by-key',
      ops: '*',
      search: /^\/(by\-key)(\/(?<key>\w+)(\+(?<version>\d+))?(\+(?<hash>\w+))?\/?)?/,
      handler: (op, match, args, cb) => {
        log.trace('in by-key handler')
        // If this is a stat on '/by-key', return a directory stat.
        if (!match.groups['key']) {
          if (op === 'getattr') return cb(0, Stat.directory())
          return handlers[op].apply(null, [...args, cb])
        }

        // Otherwise this is operating on a subdir of by-key, in which case perform the op on the specified drive.
        try {
          var key = datEncoding.decode(match.groups['key'])
        } catch (err) {
          log.error({ err }, 'key encoding error')
          return cb(-1)
        }

        if (op === 'symlink') {
          // Symlinks into the 'by-key' directory should be treated as mounts in the root drive.
          var version = match['version']
          if (version && +version) version = +version
          const hash = match['hash']
          return this.mountDrive(args[0], { version, hash })
            .then(() => cb(0))
            .catch(err => {
              log.error({ err }, 'mount error')
              cb(-1)
            })
        }

        const drive = this._createDrive(key)

        var handlers = this._handlers.get(drive)
        if (!handlers) {
          handlers = hyperfuse.getHandlers(drive, this.opts)
          this._handlers.set(drive, handlers)
        }

        return handlers[op].apply(null, [...args, cb])
      }
    }

    const StatsHandler = {
      id: 'stats',
      test: '^\/stats',
      ops: ['readdir', 'getattr', 'open', 'read', 'symlink'],
      search: /^\/(stats)(\/(?<key>\w+)\/?)?/,
      handler: (op, match, args, cb) => {
        // If this is a stat on '/stats', return a directory stat.
        log.trace('in stats handler')
        if (!match['key']) {
          if (op === 'getattr') return cb(0, Stat.directory())
          return handlers[op].apply(null, [...args, cb])
        }

        // TODO: Implement
        return handlers[op].apply(null, [...args, cb])
      }
    }

    const ActiveHandler = {
      id: 'active',
      test: '^\/active',
      ops: ['readdir', 'getattr', 'open', 'read', 'symlink'],
      search: /^\/(active)(\/(?<key>\w+)\/?)?/,
      handler: (op, match, args, cb) => {
        log.trace('in active handler')
        // If this is a stat on '/active', return a directory stat.
        if (!match.groups['key']) {
          if (op === 'getattr') return cb(0, Stat.directory())
          return handlers[op].apply(null, [...args, cb])
        }

        // TODO: Implement
        return handlers[op].apply(null, [...args, cb])
      }
    }

    const handlers = [
      RootListHandler,
      NonWritableRootHandler,
      ByKeyHandler,
      StatsHandler,
      ActiveHandler
    ]
    for (let handler of handlers) {
      handlerIndex.set(handler.id, handler)
    }

    return function (baseHandlers) {
      log.trace({ baseHandlers }, 'wrapping base handlers')
      const wrappedHandlers = {}
      for (let handlerName of Object.getOwnPropertyNames(baseHandlers)) {
        log.trace({ handlerName }, 'wrapping handler outer')
        const baseHandler = baseHandlers[handlerName]
        if (typeof baseHandler !== 'function') {
          wrappedHandlers[handlerName] = baseHandler
        } else {
          wrappedHandlers[handlerName] = wrapHandler(handlerName, baseHandler)
        }
      }
      log.trace({ wrappedHandlers }, 'wrapped base handlers')
      return wrappedHandlers
    }

    function wrapHandler (handlerName, handler) {
      log.debug({ handlerName }, 'wrapping handler')
      const activeHandlers = handlers.filter(({ ops }) => ops === '*'  || (ops.indexOf(handlerName) !== -1))
      if (!activeHandlers.length) return handler

      const matcher = new RegExp(activeHandlers.map(({ test, id }) => `(?<${id}>${test})`).join('|'))

      return function () {
        const arg = handlerName === 'symlink' ? arguments[1] : arguments[0]
        const match = matcher.exec(arg)

        if (!match) return handler(...arguments)

        // TODO: Don't slice here.
        const args = [...arguments].slice(0, -1)

        if (log.isLevelEnabled('trace')) {
          log.trace({ id: match[1], args }, 'syscall interception')
        }

        // TODO: Don't iterate here.
        for (let key in match.groups) {
          if (!match.groups[key]) continue
          var id = key
          break
        }

        const { handler: wrappedHandler, search } = handlerIndex.get(id)
        return wrappedHandler(handlerName, search.exec(arg), args, arguments[arguments.length - 1])
      }
    }
  }

  async mount (mnt, mountOpts = {}) {
    await ensureFuse()

    log.debug({ mnt, mountOpts }, 'mounting the root drive')
    if (this._rootDrive) {
      await this.unmount()
    }

    const drive = await this.driveManager.get(mountOpts.key, { ...mountOpts, configure: { rootDrive: true } })
    const fuseLogger = log.child({ component: 'fuse' })
    var mountInfo = await hyperfuse.mount(drive, mnt, {
      force: true,
      displayFolder: true,
      map: this._getHandlerMapper(),
      log: fuseLogger.trace.bind(fuseLogger),
      debug: false
    })
    log.debug({ mnt }, 'mounted the root drive')
    mountOpts.key = drive.key

    await this.db.put('root-drive', { mnt, opts: { ...mountOpts, key: datEncoding.encode(drive.key) } })

    this._rootDrive = drive
    this._rootMnt = mnt
    this._rootHandler = hyperfuse.getHandlers(this._rootDrive, this.opts)

    return mountOpts
  }

  async unmount () {
    await ensureFuse()

    if (!this._rootMnt) return

    log.debug({ mnt: this._rootMnt }, 'unmounting the root drive')
    await hyperfuse.unmount(this._rootMnt)
    await this.db.del('root-drive')

    this._rootDrive = null
    this._rootMnt = null
    this._rootHandler = null
  }

  async mountDrive (path, opts) {
    if (!this._rootDrive) throw new Error('The root hyperdrive must first be created before mounting additional drives.')
    if (!this._rootMnt || !path.startsWith(this._rootMnt)) throw new Error('Drives can only be mounted within the mountpoint.')

    // The corestore name is not very important here, since the initial drive will be discarded after mount.
    const drive = await this._createDrive(null, { ...this.opts, name: crypto.randomBytes(64).toString('hex') })

    log.debug({ path, key: drive.key }, 'mounting a drive at a path')
    return new Promise((resolve, reject) => {
      const innerPath = path.slice(this._rootMnt.length)
      this._rootDrive.mount(innerPath, opts, err => {
        if (err) return reject(err)
        log.debug({ path, key: drive.key }, 'drive mounted')
        return resolve()
      })
    })
  }

  list () {
    return new Map([...this._drives])
  }
}

function createFuseHandlers (fuseManager) {
  return {
    mount: async (call) => {
      console.error('right here')
      var mountOpts = call.request.getOpts()
      const mnt = call.request.getPath()
      if (mountOpts) mountOpts = fromHyperdriveOptions(mountOpts)
      console.error({ mnt }, 'handling a mount request')

      if (!mnt) throw new Error('A mount request must specify a mountpoint.')
      const mountInfo = await fuseManager.mount(mnt, mountOpts)

      console.error('MOUNT INFO:', mountInfo)
      const rsp = new rpc.fuse.messages.MountResponse()
      rsp.setMountinfo(toHyperdriveOptions(mountInfo))
      rsp.setPath(mnt)

      return rsp
    },

    unmount: async (call) => {
      const rsp = rpc.fuse.messages.UnmountResponse()
      await fuseManager.unmount()
      return rsp
    },

    status: (call) => {
      const rsp = rpc.fuse.messages.StatusResponse()
      rsp.available = true
      return new Promise((resolve, reject) => {
        hyperfuse.isConfigured((err, configured) => {
          if (err) return reject(err)
          rsp.configured = configured
          return resolve(rsp)
        })
      })
    }
  }
}

function ensureFuse () {
  return new Promise((resolve, reject) => {
    hyperfuse.isConfigured((err, configured) => {
      if (err) return reject(err)
      if (!configured) return reject(new Error('FUSE is not configured. Please run `hyperdrive setup` first.'))
      return resolve()
    })
  })
}

module.exports = {
  FuseManager,
  createFuseHandlers
}
