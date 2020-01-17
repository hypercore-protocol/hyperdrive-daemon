const get = require('simple-get')
const log = require('./log').child({ component: 'telemetry' })

// Report telemetry once per hour.
const TELEMETRY_INTERVAL = 1000 * 60 * 60
// TODO: Update with an actual URL (and HTTPS).
const TELEMETRY_URL = 'http://35.221.61.137:3000'

module.exports = class TelemetryManager {
  constructor (daemon) {
    this.daemon = daemon
    this._interval = null
  }

  // There's nothing confidential in an update. It includes:
  // 1) Uptime
  // 2) The number of connections you current have (but no other info about those connections).
  // 3) How many Hypercores you currently have in memory (but not they're keys).
  _update () {
    const update = {
      uptime: this.daemon.uptime
    }
    if (this.daemon.networking) {
      update.peers = this.daemon.networking._replicationStreams.length
    }
    const corestoreInfo = this.daemon.corestore._info()
    for (let key of Object.keys(corestoreInfo)) {
      update['corestore.' + key] = corestoreInfo[key]
    }
    return update
  }

  async send () {
    try {
      const update = this._update()
      log.info({ update }, 'sending telemetry')
      await new Promise((resolve, reject) => {
        get.concat({
          method: 'POST',
          url: TELEMETRY_URL,
          body: update,
          json: true
        }, (err, res) => {
          if (err) return reject(err)
          log.info({ statusCode: res.statusCode }, 'received telemetry response')
          return resolve()
        })
      })
    } catch (err) {
      log.error({ error: err.stack }, 'could not send a telemetry update')
    }
  }

  start () {
    // Since we're only sending updates infrequently, we can assume it'll complete before the next interval.
    this._interval = setInterval(this.send.bind(this), TELEMETRY_INTERVAL)
  }

  stop () {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
  }
}
