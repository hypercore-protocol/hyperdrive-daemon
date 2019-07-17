const p = require('path')
const { EventEmitter } = require('events')
const crypto = require('crypto')

const hyperdrive = require('hyperdrive')
const datEncoding = require('dat-encoding')
const Stat = require('hyperdrive/lib/stat')
const hyperfuse = require('hyperdrive-fuse')


const { rpc } = require('hyperdrive-daemon-client')
const { fromHyperdriveOptions, toHyperdriveOptions } = require('hyperdrive-daemon-client/lib/common')
const constants = require('hyperdrive-daemon-client/lib/constants')

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

    this.fuseConfigured = false
    this._rootDrive = null
    this._rootMnt = null
    this._rootHandler = null
  }

  async ready () {
    try {
      await ensureFuse()
      this.fuseConfigured = true
    } catch (err) {
      this.fuseConfigured = false
    }
    if (this.fuseConfigured) return this._refreshMount()
    return null
  }

  async _refreshMount () {
    log.debug('attempting to refresh the root drive if it exists.')
    try {
      const rootDriveMeta = await this.db.get('root-drive')
      log.debug({ rootDriveMeta }, 'got root drive metadata')
      const { opts, mnt } = rootDriveMeta
      log.debug({ opts, mnt }, 'refreshing mount on restart')
      await this.mount(mnt, opts)
    } catch (err) {
      if (!err.notFound) throw err
      log.debug('no root drive found to remount')
      return null
    }
  }

  _wrapHandlers (handlers) {
    const self = this
    const interceptorIndex = new Map()

    const RootListHandler = {
      id: 'root',
      test: '^\/$',
      search: /^\/$/,
      ops: ['readdir'],
      handler: (op, match, args, cb) => {
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
        // If this is a stat on '/by-key', return a directory stat.
        if (!match.groups['key']) {
          if (op === 'readdir') return cb(0, [])
          if (op === 'releasedir') return cb(0)
          if (op === 'getattr') return cb(0, Stat.directory({ uid: process.getuid(), gid: process.getgid()}))
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
          var version = match.groups['version']
          if (version && +version) version = +version
          const hash = match.groups['hash']
          return this.mountDrive(args[0], { version, hash })
            .then(() => cb(0))
            .catch(err => {
              log.error({ err }, 'mount error')
              cb(-1)
            })
        }

        return this.driveManager.get(key, { ...this.opts })
          .then(drive => {
            var handlers = this._handlers.get(drive)
            if (!handlers) {
              handlers = hyperfuse.getHandlers(drive, `/by-key/${key}`, this.opts)
              this._handlers.set(drive, handlers)
            }
            args[0] = args[0].slice(match[0].length) || '/'
            return handlers[op].apply(null, [...args, (err, result) => {
              if (err) {
                log.trace({ err }, 'error in sub-fuse handler')
                return cb(err)
              }
              log.trace({ result }, 'sub-fuse handler result')
              return cb(null, result)
            }])
          })
          .catch(err => {
            log.error({ err: err.stack }, 'by-key handler error')
            return cb(-1)
          })
      }
    }

    const StatsHandler = {
      id: 'stats',
      test: '^\/stats',
      ops: ['readdir', 'getattr', 'open', 'read', 'symlink'],
      search: /^\/(stats)(\/(?<key>\w+)\/?)?/,
      handler: (op, match, args, cb) => {
        // If this is a stat on '/stats', return a directory stat.
        if (!match['key']) {
          if (op === 'getattr') return cb(0, Stat.directory({ uid: process.getuid(), gid: process.getgid() }))
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
        // If this is a stat on '/active', return a directory stat.
        if (!match.groups['key']) {
          if (op === 'getattr') return cb(0, Stat.directory({ uid: process.getuid(), gid: process.getgid() }))
          return handlers[op].apply(null, [...args, cb])
        }

        // TODO: Implement
        return handlers[op].apply(null, [...args, cb])
      }
    }

    const interceptors = [
      RootListHandler,
      NonWritableRootHandler,
      ByKeyHandler,
      StatsHandler,
      ActiveHandler
    ]
    for (let interceptor of interceptors) {
      interceptorIndex.set(interceptor.id, interceptor)
    }

    const wrappedHandlers = {}
    for (let handlerName of Object.getOwnPropertyNames(handlers)) {
      const baseHandler = handlers[handlerName]
      if (typeof baseHandler !== 'function') {
        wrappedHandlers[handlerName] = baseHandler
      } else {
        wrappedHandlers[handlerName] = wrapHandler(handlerName, baseHandler)
      }
    }

    return wrappedHandlers

    function wrapHandler (handlerName, handler) {
      log.debug({ handlerName }, 'wrapping handler')
      const activeInterceptors = interceptors.filter(({ ops }) => ops === '*'  || (ops.indexOf(handlerName) !== -1))
      if (!activeInterceptors.length) return handler

      const matcher = new RegExp(activeInterceptors.map(({ test, id }) => `(?<${id}>${test})`).join('|'))

      return function () {
        const arg = handlerName === 'symlink' ? arguments[1] : arguments[0]
        const match = matcher.exec(arg)

        if (!match) return handler(...arguments)

        // TODO: Don't slice here.
        const args = [...arguments].slice(0, -1)

        if (log.isLevelEnabled('trace')) {
          log.trace({ id: match[1], path: args[0] }, 'syscall interception')
        }

        // TODO: Don't iterate here.
        for (let key in match.groups) {
          if (!match.groups[key]) continue
          var id = key
          break
        }

        const { handler: wrappedHandler, search } = interceptorIndex.get(id)
        return wrappedHandler(handlerName, search.exec(arg), args, arguments[arguments.length - 1])
      }
    }
  }

  _getMountPath (path) {
    if (!this._rootDrive && path !== constants.mountpoint) {
      throw new Error(`You can only mount the root drive at ${constants.mountpoint}`)
    }
    if (!this._rootDrive) return { path: constants.mountpoint, root: true}
    if (path.startsWith(this._rootMnt) && path !== this._rootMnt) {
      const relativePath = path.slice(this._rootMnt.length)
      if (!relativePath.startsWith('/home')) throw new Error('You can only mount sub-hyperdrives within the home directory.')
      return { path: relativePath, root: false }
    }
  }

  async _driveForPath (path, opts = {}) {
    const self = this
    if (!this._rootDrive && path !== constants.mountpoint) {
      throw new Error(`You can only mount the root hyperdrive at ${constants.mountpoint}`)
    }

    if (!this._rootDrive) {
      const drive = await this.driveManager.get(opts.key, { ...opts, configure: { rootDrive: true } })
      return { drive, root: true }
    }

    if (path.startsWith(this._rootMnt) && path !== this._rootMnt) {
      const relativePath = path.slice(this._rootMnt.length)
      if (!relativePath.startsWith('/home')) throw new Error('You can only mount sub-hyperdrives within the home directory.')
      return getSubdrive(relativePath)
    }

    console.error('path:', path, 'rootMnt:', this._rootMnt, 'claiming it is root')
    return { drive: this._rootDrive, root: true }

    async function getSubdrive (relativePath) {
      const key = await new Promise((resolve, reject) => {
        self._rootDrive.readFile(p.join(relativePath, '.key'), (err, key) => {
          if (err && err.errno !== 2) return reject(err)
          key = key ? datEncoding.decode(key.toString('utf8')) : opts.key
          return resolve(key)
        })
      })
      const drive = await self.driveManager.get(key, { ...opts })
      if (opts.key) {
        await self.driveManager.publish(drive)
      }
      return { drive, relativePath, root: false }
    }
  }

  async mount (mnt, mountOpts = {}) {
    const self = this

    await ensureFuse()
    log.debug({ mnt, mountOpts }, 'mounting a drive')

    const { drive, root, relativePath } = await this._driveForPath(mnt, mountOpts)
    if (root) {
      await this.unmount()
      return mountRoot(drive)
    }
    return mountSubdrive(relativePath, drive)

    async function mountSubdrive (relativePath, drive) {
      log.debug({ key: drive.key.toString('hex') }, 'mounting a sub-hyperdrive')
      mountOpts.uid = process.getuid()
      mountOpts.gid = process.getgid()
      return new Promise((resolve, reject) => {
        self._rootDrive.mount(relativePath, drive.key, mountOpts, err => {
          if (err) return reject(err)
          return resolve({ ...mountOpts, key: drive.key })
        })
      })
    }

    async function mountRoot (drive) {
      log.debug({ key: drive.key.toString('hex')}, 'mounting the root drive')
      const fuseLogger = log.child({ component: 'fuse' })

      const handlers = hyperfuse.getHandlers(drive, mnt)
      const wrappedHandlers = self._wrapHandlers(handlers)

      var mountInfo = await hyperfuse.mount(drive, wrappedHandlers, mnt, {
        force: true,
        displayFolder: true,
        log: fuseLogger.trace.bind(fuseLogger),
        debug: log.isLevelEnabled('trace')
      })
      log.debug({ mnt, wrappedHandlers }, 'mounted the root drive')
      mountOpts.key = drive.key

      await self.db.put('root-drive', { mnt, opts: { ...mountOpts, key: datEncoding.encode(drive.key) } })

      self._rootDrive = drive
      self._rootMnt = mnt
      self._rootHandler = handlers

      return mountOpts
    }
  }

  async unmount (mnt) {
    await ensureFuse()
    const self = this

    if (!this._rootMnt) return

    // If a mountpoint is not specified, then it is assumed to be the root mount.
    if (!mnt) return unmountRoot()

    // Otherwise, unmount the subdrive
    const { path, root } = this._getMountPath(mnt)
    if (root) return unmountRoot()
    return unmountSubdrive(path)

    async function unmountRoot () {
      log.debug({ mnt: self._rootMnt }, 'unmounting the root drive')

      await hyperfuse.unmount(self._rootMnt)

      self._rootDrive = null
      self._rootMnt = null
      self._rootHandler = null
    }

    function unmountSubdrive (path) {
      return new Promise((resolve, reject) => {
        self._rootDrive.unmount(path, err => {
          if (err) return reject(err)
          return resolve()
        })
      })
    }
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

  async publish (mnt) {
    await ensureFuse()
    const { drive } = await this._driveForPath(mnt)
    return this.driveManager.publish(drive)
  }

  async unpublish (mnt) {
    await ensureFuse()
    const { drive } = await this._driveForPath(mnt)
    return this.driveManager.publish(drive)
  }

  list () {
    return new Map([...this._drives])
  }

  getHandlers () {
    return {
      mount: async (call) => {
        var mountOpts = call.request.getOpts()
        const mnt = call.request.getPath()
        if (mountOpts) mountOpts = fromHyperdriveOptions(mountOpts)

        if (!mnt) throw new Error('A mount request must specify a mountpoint.')
        const mountInfo = await this.mount(mnt, mountOpts)

        const rsp = new rpc.fuse.messages.MountResponse()
        rsp.setMountinfo(toHyperdriveOptions(mountInfo))
        rsp.setPath(mnt)

        return rsp
      },

      publish: async (call) => {
        const mnt = call.request.getPath()

        if (!mnt) throw new Error('A publish request must specify a mountpoint.')
        await this.publish(mnt)

        return new rpc.fuse.messages.PublishResponse()
      },

      unpublish: async (call) => {
        const mnt = call.request.getPath()

        if (!mnt) throw new Error('An unpublish request must specify a mountpoint.')
        await this.unpublish(mnt)

        return new rpc.fuse.messages.UnpublishResponse()
      },

      unmount: async (call) => {
        const mnt = call.request.getPath()

        await this.unmount(mnt)

        const rsp = rpc.fuse.messages.UnmountResponse()
        return rsp
      },

      status: (call) => {
        const rsp = new rpc.fuse.messages.FuseStatusResponse()
        rsp.setAvailable(true)
        return new Promise((resolve, reject) => {
          hyperfuse.isConfigured((err, configured) => {
            if (err) return reject(err)
            rsp.setConfigured(configured)
            return resolve(rsp)
          })
        })
      }
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

module.exports = FuseManager
