const sub = require('subleveldown')
const bjson = require('buffer-json-encoding')
const datEncoding = require('dat-encoding')
const { NanoresourcePromise: Nanoresource } = require('nanoresource-promise/emitter')

const {
  fromNetworkConfiguration,
  toNetworkConfiguration
} = require('hyperdrive-daemon-client/lib/common')
const { rpc } = require('hyperdrive-daemon-client')

const { dbGet, dbCollect } = require('./common')
const log = require('./log').child({ component: 'network-manager' })

class NetworkManager extends Nanoresource {
  constructor (networking, db, opts = {}) {
    super()
    this.networking = networking
    this.db = db
    this.noAnnounce = !!opts.noAnnounce

    const dbs = NetworkManager.generateSubDbs(db)
    this._seedIndex = dbs.seeding
  }

  ready () {
    return this.open()
  }

  async _open () {
    return Promise.all([
      this._rejoin()
    ])
  }

  async _rejoin () {
    if (this.noAnnounce) return
    const seedList = await dbCollect(this._seedIndex)
    for (const { key: discoveryKey, value: networkOpts } of seedList) {
      const opts = networkOpts && networkOpts.opts
      if (!opts || !opts.announce) continue
      this.networking.join(discoveryKey, { ...networkOpts.opts, loadForLength: true })
    }
  }

  async configure (discoveryKey, opts = {}) {
    const self = this
    const encodedKey = datEncoding.encode(discoveryKey)
    const networkOpts = {
      lookup: !!opts.lookup,
      announce: !!opts.announce,
    }
    const seeding = opts.lookup || opts.announce
    var networkingPromise

    const sameConfig = sameNetworkConfig(discoveryKey, opts)
    // If all the networking options are the same, exit early.
    if (sameConfig) return

    const networkConfig = { opts: networkOpts }
    if (seeding) await this._seedIndex.put(encodedKey, networkConfig)
    else await this._seedIndex.del(encodedKey)

    // Failsafe
    if (networkOpts.announce && this.noAnnounce) networkOpts.announce = false

    try {
      if (seeding) {
        networkingPromise = this.networking.join(discoveryKey, networkOpts)
      } else {
        networkingPromise = this.networking.leave(discoveryKey)
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

  async getConfiguration (discoveryKey) {
    const networkOpts = await dbGet(this._seedIndex, datEncoding.encode(discoveryKey))
    return networkOpts ? networkOpts.opts : null
  }

  async getAllConfigurations () {
    const storedConfigurations = (await dbCollect(this._seedIndex)).map(({ key, value }) => [key, value])
    return new Map(storedConfigurations)
  }

  async _rpcAllNetworkConfigurations (call) {
    const networkConfigurations = await this.getAllConfigurations()

    const rsp = new rpc.drive.messages.NetworkConfigurationsResponse()
    rsp.setConfigurationsList([...networkConfigurations].map(([, value]) => toNetworkConfiguration({
      ...value.opts,
      key: Buffer.from(value.key, 'hex')
    })))

    return rsp
  }
}
NetworkManager.generateSubDbs = function (db) {
  return {
    seeding: sub(db, 'seeding', { valueEncoding: 'json '})
  }
}

module.exports = NetworkManager

