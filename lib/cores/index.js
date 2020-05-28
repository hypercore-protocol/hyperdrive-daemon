const { EventEmitter } = require('events')
const sub = require('subleveldown')
const bjson = require('buffer-json-encoding')
const datEncoding = require('dat-encoding')

const log = require('../log').child({ component: 'core-manager' })

class CoreManager extends EventEmitter {
  constructor (corestore, networking, db, opts = {}) {
    super()

    this.corestore = corestore
    this.networking = networking
    this.db = db

    this._seedIndex = sub(this.db, 'seeding', { valueEncoding: 'json' })
    this._mirrorIndex = sub(this.db, 'mirrors', { valueEncoding: 'utf8' })
  }

  async _rejoin () {
    if (this.noAnnounce) return
    const seedList = await collect(this._seedIndex)
    for (const { key: discoveryKey, value: networkOpts } of seedList) {
      const opts = networkOpts && networkOpts.opts
      if (!opts || !opts.announce) continue
      this.networking.join(discoveryKey, { ...networkOpts.opts, loadForLength: true })
    }
  }

  async configureNetwork (feed, opts = {}) {
    const self = this
    const encodedKey = datEncoding.encode(feed.discoveryKey)
    const networkOpts = {
      lookup: !!opts.lookup,
      announce: !!opts.announce,
      remember: !!opts.remember
    }
    const seeding = opts.lookup || opts.announce
    var networkingPromise

    const sameConfig = sameNetworkConfig(feed.discoveryKey, opts)
    // If all the networking options are the same, exit early.
    if (sameConfig) return

    const networkConfig = { key: datEncoding.encode(feed.key), opts: networkOpts }
    if (opts.remember) {
      if (seeding) await this._seedIndex.put(encodedKey, networkConfig)
      else await this._seedIndex.del(encodedKey)
    } else {
      this._transientSeedIndex.set(encodedKey, networkConfig)
    }

    // Failsafe
    if (networkOpts.announce && this.noAnnounce) networkOpts.announce = false

    try {
      if (seeding) {
        networkingPromise = this.networking.join(feed.discoveryKey, networkOpts)
      } else {
        networkingPromise = this.networking.leave(feed.discoveryKey)
      }
      networkingPromise.then(configurationSuccess)
      networkingPromise.catch(configurationError)
    } catch (err) {
      configurationError(err)
    }

    function sameNetworkConfig (discoveryKey, opts = {}) {
      const swarmStatus = self.networking.status(discoveryKey)
      if (!swarmStatus) return opts.lookup === false && opts.announce === false
      return swarmStatus.announce === opts.announce && swarmStatus.lookup === opts.lookup
    }

    function configurationError (err) {
      log.error({ err, discoveryKey: encodedKey }, 'network configuration error')
    }

    function configurationSuccess () {
      log.debug({ discoveryKey: encodedKey }, 'network configuration succeeded')
    }
  }

  async getNetworkConfiguration (drive) {
    const encodedKey = datEncoding.encode(drive.discoveryKey)
    const networkOpts = this._transientSeedIndex.get(encodedKey)
    if (networkOpts) return networkOpts.opts
    try {
      const persistentOpts = await this._seedIndex.get(encodedKey)
      return persistentOpts.opts
    } catch (err) {
      return null
    }
  }
}

module.exports = CoreManager
