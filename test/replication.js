const test = require('tape')

const { create } = require('./util/create')

test('can replicate a single drive between daemons', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.publish()

    const drive2 = await secondClient.drive.get({ key: drive1.key })

    await drive1.writeFile('hello', 'world')

    // 100 ms delay for replication.
    await delay(100)

    const replicatedContent = await drive2.readFile('hello')
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
    const rootDrive = await firstClient.drive.get()
    const mounts = []
    for (let i = 0; i < NUM_MOUNTS; i++) {
      const key = '' + i
      const mountDrive = await firstClient.drive.get()
      await rootDrive.mount(key, { key: mountDrive.key })
      await mountDrive.writeFile(key, key)
      await mountDrive.publish()
      mounts.push({ key: mountDrive.key, path: key + '/' + key, content: key })
    }
    return mounts
  }

  async function createSecond (mounts) {
    const rootDrive = await secondClient.drive.get()
    for (const { key, content } of mounts) {
      await secondClient.drive.get({ key })
      await rootDrive.mount(content, { key })
    }
    return rootDrive
  }

  async function validate (mounts, secondRoot) {
    for (const { path, content } of mounts) {
      const readContent = await secondRoot.readFile(path)
      t.same(readContent, Buffer.from(content))
    }
  }
})

test('can replicate nested mounts between daemons', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  try {
    const firstRoot = await firstClient.drive.get()
    const firstMount1 = await firstClient.drive.get()
    const firstMount2 = await firstClient.drive.get()
    await firstMount2.publish()

    await firstRoot.mount('a', { key: firstMount1.key })
    await firstMount1.mount('b', { key: firstMount2.key })

    await firstMount2.writeFile('hello', 'world')

    const secondRoot = await secondClient.drive.get()
    await secondClient.drive.get({ key: firstMount2.key })

    await secondRoot.mount('c', { key: firstMount2.key })

    // 100 ms delay for replication.
    await delay(100)

    const replicatedContent = await secondRoot.readFile('c/hello')
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
    const firstRoot = await firstClient.drive.get()
    const firstMount1 = await firstClient.drive.get()
    const firstMount2 = await firstClient.drive.get()
    await firstMount2.publish()

    await firstRoot.mount('a', { key: firstMount1.key })
    await firstRoot.mount('b', { key: firstMount2.key })

    await firstMount2.writeFile('hello', 'world')

    const firstStats = await firstClient.drive.allStats()
    t.same(firstStats.length, 3)
    for (const mountStats of firstStats) {
      t.same(mountStats.length, 1)
      t.same(mountStats[0].metadata.uploadedBytes, 0)
    }

    const secondRoot = await secondClient.drive.get()
    await secondClient.drive.get({ key: firstMount2.key })

    await secondRoot.mount('c', { key: firstMount2.key })

    // 100 ms delay for replication.
    await delay(100)

    const replicatedContent = await secondRoot.readFile('c/hello')
    t.same(replicatedContent, Buffer.from('world'))

    const secondStats = await firstClient.drive.allStats()
    t.same(secondStats.length, 3)

    var uploadedBytes = null
    for (const mountStats of secondStats) {
      if (mountStats[0].metadata.key.equals(firstMount2.key)) {
        uploadedBytes = mountStats[0].content.uploadedBytes
        t.notEqual(uploadedBytes, 0)
      }
    }
    t.true(uploadedBytes)

    const thirdStats = await firstMount2.stats()
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
