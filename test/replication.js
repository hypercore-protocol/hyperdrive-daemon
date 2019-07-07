const test = require('tape')

const { create } = require('./util/create')

test('can replicate a single drive between daemons', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  try {
    const { opts, id: id1 } = await firstClient.drive.get()
    await firstClient.drive.publish(id1)

    const { id: id2 } = await secondClient.drive.get({ key: opts.key })

    await firstClient.drive.writeFile(id1, 'hello', 'world')

    // 100 ms delay for replication.
    await delay(100)

    const replicatedContent = await secondClient.drive.readFile(id2, 'hello')
    t.same(replicatedContent, Buffer.from('world'))
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can replicate many mounted drives between daemons', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  const NUM_MOUNTS = 100

  try {
    const mounts = await createFirst()
    const second = await createSecond(mounts)

    // 100 ms delay for replication.
    console.log('VALIDATING IN 10s')
    await delay(10000)

    await validate(mounts, second)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()

  async function createFirst () {
    const { opts: rootOpts, id: rootId } = await firstClient.drive.get()
    const mounts = []
    for (let i = 0; i < NUM_MOUNTS; i++) {
      const key = '' + i
      const { opts: mountOpts, id: mountId } = await firstClient.drive.get()
      await firstClient.drive.mount(rootId, key, { ...mountOpts, version: null })
      await firstClient.drive.writeFile(mountId, key, key)
      await firstClient.drive.publish(mountId)
      mounts.push({ key: mountOpts.key, path: key + '/' + key, content: key })
    }
    return mounts
  }

  async function createSecond (mounts) {
    const { opts: rootOpts, id: rootId } = await secondClient.drive.get()
    for (const { key, path, content } of mounts) {
      const { id } = await secondClient.drive.get({ key })
      await secondClient.drive.mount(rootId, content, { key })
    }
    return rootId
  }

  async function validate (mounts, id) {
    for (const { key, path, content } of mounts) {
      const readContent = await secondClient.drive.readFile(id, path)
      t.same(readContent, Buffer.from(content))
    }
  }
})

test('can replicate recursive mounts between daemons', async t => {
  t.end()
})

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
