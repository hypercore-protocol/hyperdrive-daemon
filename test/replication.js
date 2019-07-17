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

  const NUM_MOUNTS = 15

  try {
    const mounts = await createFirst()
    const second = await createSecond(mounts)

    // 100 ms delay for replication.
    await delay(100)

    await validate(mounts, second)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()

  async function createFirst () {
    const { id: rootId } = await firstClient.drive.get()
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
    const { id: rootId } = await secondClient.drive.get()
    for (const { key, content } of mounts) {
      await secondClient.drive.get({ key })
      await secondClient.drive.mount(rootId, content, { key })
    }
    return rootId
  }

  async function validate (mounts, id) {
    for (const { path, content } of mounts) {
      const readContent = await secondClient.drive.readFile(id, path)
      t.same(readContent, Buffer.from(content))
    }
  }
})

test('can replicate nested mounts between daemons', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  try {
    const { id: rootId1 } = await firstClient.drive.get()
    const { opts: mountOpts1, id: mountId1 } = await firstClient.drive.get()
    const { opts: mountOpts2, id: mountId2 } = await firstClient.drive.get()
    await firstClient.drive.publish(mountId2)

    await firstClient.drive.mount(rootId1, 'a', { ...mountOpts1, version: null })
    await firstClient.drive.mount(mountId1, 'b', { ...mountOpts2, version: null })

    await firstClient.drive.writeFile(mountId2, 'hello', 'world')

    const { id: rootId2 } = await secondClient.drive.get()
    await secondClient.drive.get({ key: mountOpts2.key })

    await secondClient.drive.mount(rootId2, 'c', { ...mountOpts2, version: null })

    // 100 ms delay for replication.
    await delay(100)

    const replicatedContent = await secondClient.drive.readFile(rootId2, 'c/hello')
    t.same(replicatedContent, Buffer.from('world'))
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can get networking stats for multiple mounts', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  try {
    const { id: rootId1 } = await firstClient.drive.get()
    const { opts: mountOpts1 } = await firstClient.drive.get()
    const { opts: mountOpts2, id: mountId2 } = await firstClient.drive.get()
    await firstClient.drive.publish(mountId2)

    await firstClient.drive.mount(rootId1, 'a', { ...mountOpts1, version: null })
    await firstClient.drive.mount(rootId1, 'b', { ...mountOpts2, version: null })

    await firstClient.drive.writeFile(mountId2, 'hello', 'world')

    const firstStats = await firstClient.drive.allStats()
    t.same(firstStats.length, 3)
    for (const mountStats of firstStats) {
      t.same(mountStats.length, 1)
      t.same(mountStats[0].metadata.uploadedBytes, 0)
    }

    const { id: rootId2 } = await secondClient.drive.get()
    await secondClient.drive.get({ key: mountOpts2.key })

    await secondClient.drive.mount(rootId2, 'c', { ...mountOpts2, version: null })

    // 100 ms delay for replication.
    await delay(100)

    const replicatedContent = await secondClient.drive.readFile(rootId2, 'c/hello')
    t.same(replicatedContent, Buffer.from('world'))

    const secondStats = await firstClient.drive.allStats()
    t.same(secondStats.length, 3)

    var uploadedBytes = null
    for (const mountStats of secondStats) {
      if (mountStats[0].metadata.key.equals(mountOpts2.key)) {
        uploadedBytes = mountStats[0].content.uploadedBytes
        t.notEqual(uploadedBytes, 0)
      }
    }
    t.true(uploadedBytes)

    const thirdStats = await firstClient.drive.stats(mountId2)
    t.same(thirdStats[0].content.uploadedBytes, uploadedBytes)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
