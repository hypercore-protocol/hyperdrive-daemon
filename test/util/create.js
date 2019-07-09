const tmp = require('tmp-promise')
const dht = require('@hyperswarm/dht')

const loadClient = require('hyperdrive-daemon-client/lib/loader')
const start = require('../..')

const BASE_PORT = 4101
const BOOTSTRAP_PORT = 3100
const BOOTSTRAP_URL = `localhost:${BOOTSTRAP_PORT}`

async function create (numServers) {
  const cleanups = []
  const clients = []

  const bootstrapper = dht({
    bootstrap: false
  })
  bootstrapper.listen(BOOTSTRAP_PORT)
  await new Promise(resolve => {
    return bootstrapper.once('listening', resolve)
  })

  for (let i = 0; i < numServers; i++) {
    const { client, cleanup } = await createInstance(i, BASE_PORT + i,  [BOOTSTRAP_URL])
    clients.push(client)
    cleanups.push(cleanup)
  }

  return { clients, cleanup }

  async function cleanup () {
    for (let cleanupInstance of cleanups) {
      await cleanupInstance()
    }
    await bootstrapper.destroy()
  }
}

async function createOne () {
  const { clients, cleanup } = await create(1)
  return {
    client: clients[0],
    cleanup
  }
}

async function createInstance (id, port, bootstrap) {
  const { path, cleanup: dirCleanup } = await tmp.dir({ unsafeCleanup: true })

  const token = `test-token-${id}`
  const endpoint = `localhost:${port}`

  const stop = await start({
    storage: path,
    bootstrap,
    port,
    metadata: {
      token,
      endpoint
    }
  })

  return new Promise((resolve, reject) => {
    return loadClient(endpoint, token, (err, client) => {
      if (err) return reject(err)
      return resolve({
        client,
        cleanup
      })
    })
  })

  async function cleanup () {
    await stop()
    await dirCleanup()
  }
}

module.exports = {
  create,
  createOne
}
