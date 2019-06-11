const crypto = require('crypto')
const { EventEmitter } = require('events')

const datEncoding = require('dat-encoding')
const Stat = require('hyperdrive/lib/stat')
const hyperfuse = require('hyperdrive-fuse')

const { daemon: api } = require('hyperdrive-daemon-api')
const { serverError, requestError } = require('../errors')
const log = require('./log').child({ component: 'fuse-manager' })

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
    log.debug('FUSE manager is getting ready')
    const mountInfo = await this._refreshMount()
    log.debug({ mountInfo }, 'FUSE manager is ready')
  }

  async _refreshMount () {
    try {
      var mountInfo = await this.db.get('root-drive')
    } catch (err) {
      if (!err.notFound) return Promise.resolve()
    }
    return this.mount(mountInfo)
  }

  _getHandlerMapper () {
    const self = this
    const handlerIndex = new Map()

    const RootListHandler = {
      id: '/',
      path: '^(\/)$',
      ops: ['readdir'],
      handler: (op, match, args, cb) => {
        return this._rootHandler['readdir'].apply(null, [...args, (err, list) => {
          if (err) return cb(err)
          return cb(0, [...list, 'by-key', 'stats', 'active'])
        }])
      }
    }

    const ByKeyHandler = {
      id: 'by-key',
      ops: '*',
      path: '^\/(by\\-key)(\/(\\w+)(\\+(\\d+))?(\\+(\\w+))?\/?)?',
      handler: (op, match, args, cb) => {
        // If this is a stat on '/by-key', return a directory stat.
        if (!match[2]) {
          if (op === 'getattr') return cb(0, Stat.directory())
          return handlerIndex[op].apply(null, [...args, cb])
        }

        // Otherwise this is operating on a subdir of by-key, in which case perform the op on the specified drive.
        try {
          var key = datEncoding.decode(match[3])
        } catch (err) {
          log.error({ err }, 'key encoding error')
          return cb(-2)
        }

        if (op === 'symlink') {
          // Symlinks into the 'by-key' directory should be treated as mounts in the root drive.
          const version = (match[5] && +match[5]) ? +match[5] : null
          const hash = match[7]
          return this.mountDrive(args[0], { version, hash })
            .then(() => cb(0))
            .catch(err => {
              log.error({ err }, 'mount error')
              cb(-2)
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
      ops: ['readdir', 'getattr', 'open', 'read', 'symlink'],
      path: '^\/(stats)(\/(\\w+)\/?)?',
      handler: (op, match, args, cb) => {
        // If this is a stat on '/stats', return a directory stat.
        if (!match[2]) {
          if (op === 'getattr') return cb(0, Stat.directory())
          return handlerIndex[op].apply(null, [...args, cb])
        }

        // TODO: Implement
        return handlerIndex[op].apply(null, [...args, cb])
      }
    }

    const ActiveHandler = {
      id: 'active',
      ops: ['readdir', 'getattr', 'open', 'read', 'symlink'],
      path: '^\/(active)(\/(\\w+)\/?)?',
      handler: (op, match, args, cb) => {
        // If this is a stat on '/active', return a directory stat.
        if (!match[2]) {
          if (op === 'getattr') return cb(0, Stat.directory())
          return handlerIndex[op].apply(null, [...args, cb])
        }

        // TODO: Implement
        return handlerIndex[op].apply(null, [...args, cb])
      }
    }

    const handlers = [
      RootListHandler,
      ByKeyHandler,
      StatsHandler,
      ActiveHandler
    ]
    for (let handler of handlers) {
      handlerIndex.set(handler.id, handler)
    }

    return function (baseHandlers) {
      const wrappedHandlers = {}
      for (let handlerName of Object.getOwnPropertyNames(baseHandlers)) {
        const baseHandler = baseHandlers[handlerName]
        if (typeof baseHandler !== 'function') {
          wrappedHandlers[handlerName] = baseHandler
        } else {
          wrappedHandlers[handlerName] = wrapHandler(handlerName, handler)
        }
      }
      return wrappedHandlers
    }

    function wrapHandler (handlerName, handler) {
      const activeHandlers = handlers.filter(({ ops }) => ops === '*'  || (ops.indexOf(handlerName) !== -1))
      if (!activeHandlers.length) return handler

      const matcher = new RegExp(activeHandlers.map(({ path }) => path).join('|'))

      return function () {
        const match = matcher.exec(handlerName === 'symlink' ? arguments[1] : arguments[0])
        if (!match) return handler(...arguments)
        if (log.islevelenabled('trace')) {
          log.trace({ id: match[1], args: arguments.slice(0, -1) }, 'syscall interception')
        }

        // TODO: Don't slice here.
        return handlerIndex.get(match[1]).handler(handlerName, match, arguments.slice(0, -1), arguments[arguments.length - 1])
      }
    }
  }

  async mount ({ key, mnt, opts } = {}) {
    this._rootDrive = await this.driveManager.get(key, { ...this.opts, opts })
    this._rootHandler = hyperfuse.getHandlers(this._rootDrive, { ...this.opts, opts })

    const keyString = key || datEncoding.encode(this._rootDrive.key)
    this._handlers.set(keyString, this._rootHandler)

    log.debug({ mnt }, 'mounting the root drive')
    const mountInfo = await hyperfuse.mount(this._rootDrive, mountInfo.mnt, {
      force: true,
      displayFolder: true,
      map: this._getHandlerMapper(),
      log: log.child({ component: 'fuse' }),
      debug: log.islevelenabled('debug')
    })
    log.debug({ mnt }, 'mounted the root drive')

    await this.db.put('root-drive', { key, mnt, opts })
    this._rootMnt = mnt

    return mountInfo
  }

  async unmount () {
    if (!this._rootMnt) throw new Error('A root hyperdrive is not mounted')
    log.debug({ mnt: this._rootMnt }, 'unmounting the root drive')
    await hyperfuse.unmount(this._rootMnt)
    await this.db.delete('root-drive')
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
    mountRoot: async (call, cb) => {
      if (!call.request.req || !call.request.req.mountRoot) return cb(requestError('Request must contain mount options.'))
      const mountRequest = call.request.req.mountRoot
      if (!mountRequest.path || !mountRequest.mount) return cb(requestError('Request must specify a path and mount info.'))

      const info = await fuseManager.mount(mountRequest.mount.key, mountRequest.path, {
        ...mountRequest.mount,
        ...mountRequest.driveOpts
      })

      const rsp = new api.fuse.messages.MountRootResponse()
      rsp.path = info.mnt
      rsp.mountInfo = rsp.mount

      return cb(null, rsp)
    },

    unmountRoot: async (call, cb) => {
      const rsp = new api.fuse.messages.UnmountRootResponse()
      await fuseManager.unmount()
      return cb(null, rsp)
    },

    status: async (call, cb) => {
      const rsp = new api.fuse.messages.FuseStatusResponse()
      rsp.available = !!hyperfuse
      if (!hyperfuse) {
        rsp.configured = false
        return cb(null, rsp)
      }
      hyperfuse.isConfigured((err, configured) => {
        if (err) return cb(serverError(err))
        rsp.configured = configured
        return cb(null, rsp)
      })
    }
  }
}

module.exports = {
  FuseManager,
  createFuseHandlers
}
