const p = require('path')
const test = require('tape')
const { create } = require('./util/create')

test('can replicate a single drive between daemons', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })

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

test('can get drive stats containing only networking info', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })

    const drive2 = await secondClient.drive.get({ key: drive1.key })

    await drive1.writeFile('hello', 'world')

    // 100 ms delay for replication.
    await delay(100)
    await drive2.readFile('hello')

    const { stats: stats1 } = await drive1.stats({ networkingOnly: true })
    const { stats: stats2 } = await drive2.stats({ networkingOnly: true })

    const firstStats = stats1[0]
    const secondStats = stats2[0]
    t.same(firstStats.metadata.peers, 1)
    t.same(secondStats.metadata.peers, 1)
    t.same(firstStats.metadata.downloadedBlocks, 0)
    t.same(secondStats.metadata.downloadedBlocks, 0)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can download a directory between daemons', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })

    const drive2 = await secondClient.drive.get({ key: drive1.key })

    await drive1.writeFile('/a/1', 'hello')
    await drive1.writeFile('/a/2', 'world')
    await drive1.writeFile('/a/3', 'three')
    await drive1.writeFile('/a/4', 'four')
    await drive1.writeFile('/a/5', 'five')

    var { stats } = await drive1.stats()
    t.same(stats[0].content.totalBlocks, 5)
    t.same(stats[0].content.downloadedBlocks, 5)

    // 100 ms delay for replication.
    await delay(100)

    const d2Stats1 = await drive2.stats()
    stats = d2Stats1.stats

    // Since there has not been a content read yet, the stats will not report the latest content length.
    t.same(stats[0].content.totalBlocks, 0)

    // TODO: Uncomment after hypercore bug fix.
    // t.same(stats[0].content.downloadedBlocks, 0)

    var fileStats = await drive2.fileStats('/a/1')

    // TODO: Uncomment after hypercore bug fix.
    // t.same(fileStats.get('/a/1').downloadedBlocks, 0)

    await drive2.download('a')

    // 200 ms delay for download to complete.
    await delay(200)

    const d2Stats2 = await drive2.stats()
    stats = d2Stats2.stats

    fileStats = await drive2.fileStats('a')
    t.same(stats[0].content.totalBlocks, 5)
    t.same(stats[0].content.downloadedBlocks, 5)
    t.same(fileStats.get('/a/1').downloadedBlocks, 1)
    t.same(fileStats.get('/a/2').downloadedBlocks, 1)
    t.same(fileStats.get('/a/3').downloadedBlocks, 1)
    t.same(fileStats.get('/a/4').downloadedBlocks, 1)
    t.same(fileStats.get('/a/5').downloadedBlocks, 1)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can cancel an active download', async t => {
  const { clients, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })

    const drive2 = await secondClient.drive.get({ key: drive1.key })

    await writeFile(drive1, '/a/1', 50)
    await writeFile(drive1, '/a/2', 50)

    var fileStats = await drive2.fileStats('/a/1')
    // TODO: Uncomment after hypercore bug fix
    // t.same(fileStats.downloadedBlocks, 0)

    const handle = await drive2.download('a')
    await delay(100)
    await handle.destroy()

    // Wait to make sure that the download is not continuing.
    await delay(100)

    const { stats: totals } = await drive2.stats()
    fileStats = await drive2.fileStats('a')
    const contentTotals = totals[0].content
    t.true(contentTotals.downloadedBlocks < 100 && contentTotals.downloadedBlocks > 0)
    t.true(fileStats.get('/a/1').downloadedBlocks < 50 && fileStats.get('/a/1').downloadedBlocks > 0)
    t.true(fileStats.get('/a/2').downloadedBlocks < 50 && fileStats.get('/a/2').downloadedBlocks > 0)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()

  async function writeFile (drive, name, numBlocks) {
    const writeStream = drive.createWriteStream(name)
    return new Promise((resolve, reject) => {
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
      for (let i = 0; i < numBlocks; i++) {
        writeStream.write(Buffer.alloc(1024 * 1024).fill('abcdefg'))
      }
      writeStream.end()
    })
  }
})

test('can replicate many mounted drives between daemons', async t => {
  const { clients, cleanup } = await create(2)
  console.time('many-mounts')
  const firstClient = clients[0]
  const secondClient = clients[1]

  const NUM_MOUNTS = 15

  try {
    const mounts = await createFirst()
    const second = await createSecond(mounts)
    await validate(mounts, second)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  console.timeEnd('many-mounts')
  t.end()

  async function createFirst () {
    const rootDrive = await firstClient.drive.get()
    const mounts = []
    for (let i = 0; i < NUM_MOUNTS; i++) {
      const key = '' + i
      const mountDrive = await firstClient.drive.get()
      await mountDrive.configureNetwork({ lookup: true, announce: true })
      await rootDrive.mount(key, { key: mountDrive.key })
      await mountDrive.writeFile(key, key)
      mounts.push({ key: mountDrive.key, path: key + '/' + key, content: key, drive: mountDrive })
    }
    return mounts
  }

  async function createSecond (mounts) {
    const rootDrive = await secondClient.drive.get()
    for (const { key, content } of mounts) {
      await rootDrive.mount(content, { key })
    }
    return rootDrive
  }

  async function validate (mounts, secondRoot) {
    const contents = await Promise.all(mounts.map(async ({ path, content }) => {
      const contents = await secondRoot.readFile(path)
      return contents
    }))
    for (let i = 0; i < mounts.length; i++) {
      t.same(contents[i], Buffer.from(mounts[i].content))
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
    await firstMount2.configureNetwork({ lookup: true, announce: true })

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
    await firstMount2.configureNetwork({ lookup: true, announce: true })

    await firstRoot.mount('a', { key: firstMount1.key })
    await firstRoot.mount('b', { key: firstMount2.key })
    await delay(100)

    await firstMount2.writeFile('hello', 'world')

    const firstStats = await firstClient.drive.allStats()
    t.same(firstStats.length, 3)
    const rootStats = firstStats[0]
    t.same(rootStats.length, 3)
    t.same(rootStats[0].metadata.uploadedBytes, 0)

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

    const { stats: thirdStats } = await firstMount2.stats()
    t.same(thirdStats[0].content.uploadedBytes, uploadedBytes)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('no-announce mode prevents discovery for read-only hyperdrives', async t => {
  const { clients, daemons, cleanup } = await create(3, [null, { noAnnounce: true }, { noAnnounce: true }])
  const firstClient = clients[0]
  const secondClient = clients[1]
  const thirdClient = clients[2]

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })

    const drive2 = await secondClient.drive.get({ key: drive1.key })

    await drive1.writeFile('hello', 'world')

    // 100 ms delay for replication.
    await delay(100)

    const replicatedContent = await drive2.readFile('hello')
    t.same(replicatedContent, Buffer.from('world'))

    await daemons[0].stop()

    const drive3 = await thirdClient.drive.get({ key: drive1.key })
    await delay(100)

    var error = null
    try {
      const shouldNotHave = await drive3.readFile('hello')
      t.false(shouldNotHave)
    } catch (err) {
      // This should error because the thirdClient cannot discover the secondClient
      error = err
    }
    t.true(error)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('published drives are swarmed by both reader and writer', async t => {
  const { clients, daemons, cleanup } = await create(3)
  const serviceOwner = clients[0]
  const groupOwner = clients[1]
  const groupReader = clients[2]

  try {
    const service = await serviceOwner.drive.get()
    await service.writeFile('a/1', 'a/1')
    await service.writeFile('a/2', 'a/2')
    await service.writeFile('a/3', 'a/3')

    // The service owner announces the service.
    await service.configureNetwork({ lookup: true, announce: true })

    const profile = await groupOwner.drive.get()
    const group = await groupOwner.drive.get()

    // The group owner announces the group.
    await group.configureNetwork({ announce: true, lookup: true })
    await delay(100)

    await group.mount('profile', { key: profile.key })
    await profile.mount('service', { key: service.key })

    const reader = await groupReader.drive.get({ key: group.key })

    // The profile should be discoverable through the group without a separate announce.
    const profileRootDir = await reader.readdir('profile')
    t.same(profileRootDir, ['service'])

    // The update heuristic should do any early abort here:
    //  - the reader is connected to the profile peer, which has mount metadata for service but no files (reader <-> profile only)
    //  - an update on service will proceed immediately because it has 1 peer (early abort), but that peer has no files
    try {
      await reader.stat('profile/service/a')
    } catch (err) {
      t.true(err)
    }

    // After a small delay, reader <-> service directly.
    await delay(100)

    let serviceDir = await reader.readdir('profile/service')
    t.same(serviceDir.length, 1)
    // This time it works because reader <-> service directly
    const stat = await reader.stat('profile/service/a')
    t.true(stat)

    // Killing the second daemon should still let us get service stats through the serviceOwner
    await daemons[1].stop()
    serviceDir = await reader.readdir('profile/service/a')
    t.same(serviceDir, ['3', '1', '2'])
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('deep mounts with added latency', async t => {
  const { clients, cleanup } = await create(2, { latency: 20 })
  const firstClient = clients[0]
  const secondClient = clients[1]

  const DEPTH = 10

  try {
    const firstRoot = await createFirst(firstClient)
    const secondRoot = await secondClient.drive.get({ key: firstRoot.key })

    let path = ''
    for (let i = 0; i < DEPTH; i++) {
      const component = '' + i
      console.time('readdir')
      const dirContents = await secondRoot.readdir(path)
      console.timeEnd('readdir')
      t.same(dirContents.length, 2)
      path = p.join(path, component)
    }
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()

  async function createFirst (client) {
    const rootDrive = await client.drive.get()
    await rootDrive.configureNetwork({ lookup: true, announce: true })
    let currentDrive = rootDrive
    for (let i = 0; i < DEPTH; i++) {
      currentDrive.writeFile('content', '' + i)
      const nextDrive = await client.drive.get()
      currentDrive.mount('' + i, { key: nextDrive.key })
      currentDrive = nextDrive
    }
    return rootDrive
  }
})

test('can get peer counts for a drive', async t => {
  const { clients, cleanup } = await create(3)
  const firstClient = clients[0]
  const secondClient = clients[1]
  const thirdClient = clients[2]

  try {
    const drive1 = await firstClient.drive.get()
    const drive2 = await firstClient.drive.get()
    await drive1.writeFile('hello', 'world')
    await drive1.configureNetwork({ lookup: true, announce: true })
    await drive2.configureNetwork({ lookup: true, announce: true })

    await secondClient.drive.get({ key: drive1.key })
    await thirdClient.drive.get({ key: drive1.key })
    await thirdClient.drive.get({ key: drive2.key })

    // 100 ms delay for replication.
    await delay(100)

    const peerCounts = await firstClient.drive.peerCounts([drive1.key, drive2.key])
    t.same(peerCounts.length, 2)
    t.same(peerCounts[0], 2)
    t.same(peerCounts[1], 1)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can get peer info globally', async t => {
  const { clients, cleanup } = await create(3)
  const firstClient = clients[0]
  const secondClient = clients[1]
  const thirdClient = clients[2]

  try {
    const drive1 = await firstClient.drive.get()
    const drive2 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })
    await drive2.configureNetwork({ lookup: true, announce: true })

    await secondClient.drive.get({ key: drive1.key })
    await thirdClient.drive.get({ key: drive2.key })

    // 100 ms delay for replication.
    await delay(100)

    const peers = await firstClient.peers.listPeers()
    t.same(peers.length, 2)
    t.true(peers[0].address)
    t.true(peers[0].noiseKey)
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

test('can get peer info for one discovery key', async t => {
  const { clients, daemons, cleanup } = await create(3)
  const firstClient = clients[0]
  const secondClient = clients[1]
  const thirdClient = clients[2]

  try {
    const drive1 = await firstClient.drive.get()
    const drive2 = await firstClient.drive.get()
    await drive1.writeFile('hello', 'world')
    await drive1.configureNetwork({ lookup: true, announce: true })
    await drive2.configureNetwork({ lookup: true, announce: true })

    await secondClient.drive.get({ key: drive1.key })
    await thirdClient.drive.get({ key: drive2.key })

    // 100 ms delay for replication.
    await delay(100)

    const peers = await firstClient.peers.listPeers(drive2.discoveryKey)
    t.same(peers.length, 1)
    t.true(peers[0].noiseKey.equals(daemons[2].noiseKeyPair.publicKey))
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()
})

// This will hang until we add timeouts to the hyperdrive reads.
test('can continue getting drive info after remote content is cleared (no longer available)', async t => {
  const { clients, cleanup, daemons } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  const localStore = daemons[0].corestore

  try {
    const drive = await firstClient.drive.get()
    await drive.configureNetwork({ announce: true, lookup: true })
    await drive.writeFile('hello', 'world')
    const clone = await secondClient.drive.get({ key: drive.key })

    await delay(500)

    t.same(await clone.readFile('hello'), Buffer.from('world'))
    await drive.writeFile('hello', 'brave new world')

    await clearContent([drive.key], localStore)

    // const cloneStats = await clone.stats()
  } catch (err) {
    t.fail(err)
  }

  await cleanup()
  t.end()

  async function clearContent (metadataKeys, store) {
    const metadataKeySet = new Set(metadataKeys.map(k => k.toString('hex')))
    for (const [, core] of store._externalCores) {
      if (metadataKeySet.has(core.key.toString('hex'))) continue
      await new Promise((resolve, reject) => {
        core.clear(0, core.length, err => {
          if (err) return reject(err)
          return resolve()
        })
      })
    }
  }
})

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
