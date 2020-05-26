const test = require('tape')
const { create } = require('./util/create')

test('peersockets, unidirectional send one', async t => {
  const { clients, daemons, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  const firstKey = daemons[0].noiseKeyPair.publicKey
  const secondKey = daemons[1].noiseKeyPair.publicKey
  let received = false

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })
    await secondClient.drive.get({ key: drive1.key })

    // 100 ms delay for swarming.
    await delay(100)

    // The two peers should be swarming now.
    const firstTopic = firstClient.peersockets.join('my-topic', {
      onmessage: async (peerId, msg) => {
        const remoteKey = await firstClient.peers.getKey(peerId)
        t.true(remoteKey.equals(secondKey))
        t.same(msg, Buffer.from('hello peersockets!'))
        received = true
      }
    })
    const secondTopic = secondClient.peersockets.join('my-topic')
    const peerId = await secondClient.peers.getAlias(firstKey)
    secondTopic.send(peerId, 'hello peersockets!')

    // 100 ms delay for the message to be sent.
    await delay(100)

    firstTopic.close()
    secondTopic.close()
  } catch (err) {
    t.fail(err)
  }

  t.true(received)
  await cleanup()
  t.end()
})

test('peersockets, unidirectional send many', async t => {
  const { clients, daemons, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  const firstKey = daemons[0].noiseKeyPair.publicKey
  const secondKey = daemons[1].noiseKeyPair.publicKey
  let received = 0
  const msgs = ['first', 'second', 'third', 'fourth', 'fifth'].map(s => Buffer.from(s))

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })
    await secondClient.drive.get({ key: drive1.key })

    // 100 ms delay for replication.
    await delay(100)

    // The two peers should be swarming now.
    const firstTopic = firstClient.peersockets.join('my-topic', {
      onmessage: async (peerId, msg) => {
        const remoteKey = await firstClient.peers.getKey(peerId)
        t.true(remoteKey.equals(secondKey))
        t.true(msg.equals(msgs[received++]))
      }
    })
    const secondTopic = secondClient.peersockets.join('my-topic')
    const firstAlias = await secondClient.peers.getAlias(firstKey)
    for (const msg of msgs) {
      secondTopic.send(firstAlias, msg)
    }

    // 100 ms delay for the message to be send.
    await delay(100)

    firstTopic.close()
    secondTopic.close()
  } catch (err) {
    t.fail(err)
  }

  t.same(received, msgs.length)
  await cleanup()
  t.end()
})

test('peersockets, bidirectional send one', async t => {
  const { clients, daemons, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  const firstKey = daemons[0].noiseKeyPair.publicKey
  const secondKey = daemons[1].noiseKeyPair.publicKey
  let receivedFirst = false
  let receivedSecond = false

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })
    await secondClient.drive.get({ key: drive1.key })

    // 100 ms delay for replication.
    await delay(100)

    const msg1 = Buffer.from('hello peersockets!')
    const msg2 = Buffer.from('hello right back to ya')

    // The two peers should be swarming now.
    const firstTopic = firstClient.peersockets.join('my-topic', {
      onmessage: async (peerId, msg) => {
        const remoteKey = await firstClient.peers.getKey(peerId)
        t.true(remoteKey.equals(secondKey))
        t.true(msg.equals(msg1))
        firstTopic.send(peerId, msg2)
        receivedFirst = true
      }
    })
    const secondTopic = secondClient.peersockets.join('my-topic', {
      onmessage: async (peerId, msg) => {
        const remoteKey = await secondClient.peers.getKey(peerId)
        t.true(remoteKey.equals(firstKey))
        t.true(msg.equals(msg2))
        receivedSecond = true
      }
    })

    const firstAlias = await secondClient.peers.getAlias(firstKey)
    secondTopic.send(firstAlias, msg1)

    // 100 ms delay for the message to be send.
    await delay(100)

    firstTopic.close()
    secondTopic.close()
  } catch (err) {
    t.fail(err)
  }

  t.true(receivedFirst)
  t.true(receivedSecond)
  await cleanup()
  t.end()
})

test('peersockets, bidirectional send many', async t => {
  const { clients, daemons, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  const firstKey = daemons[0].noiseKeyPair.publicKey
  const secondKey = daemons[1].noiseKeyPair.publicKey

  let firstReceived = 0
  let secondReceived = 0
  const firstMsgs = ['first', 'second', 'third', 'fourth', 'fifth'].map(s => Buffer.from(s))
  const secondMsgs = ['first-reply', 'second-reply', 'third-reply', 'fourth-reply', 'fifth-reply'].map(s => Buffer.from(s))

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })
    await secondClient.drive.get({ key: drive1.key })

    // 100 ms delay for replication.
    await delay(100)

    // The two peers should be swarming now.
    const firstTopic = firstClient.peersockets.join('my-topic', {
      onmessage: async (peerId, msg) => {
        const remoteKey = await firstClient.peers.getKey(peerId)
        t.true(remoteKey.equals(secondKey))
        t.true(msg.equals(firstMsgs[firstReceived]))
        firstTopic.send(peerId, secondMsgs[firstReceived++])
      }
    })
    const secondTopic = secondClient.peersockets.join('my-topic', {
      onmessage: async (peerId, msg) => {
        const remoteKey = await secondClient.peers.getKey(peerId)
        t.true(remoteKey.equals(firstKey))
        t.true(msg.equals(secondMsgs[secondReceived++]))
      }
    })

    const firstAlias = await secondClient.peers.getAlias(firstKey)
    for (const msg of firstMsgs) {
      secondTopic.send(firstAlias, msg)
    }

    // 100 ms delay for the message to be send.
    await delay(100)

    firstTopic.close()
    secondTopic.close()
  } catch (err) {
    t.fail(err)
  }

  t.same(firstReceived, firstMsgs.length)
  t.same(secondReceived, secondMsgs.length)
  await cleanup()
  t.end()
})

test('peersockets, send to all peers swarming a drive, static peers', async t => {
  const NUM_PEERS = 10

  const { clients, daemons, cleanup } = await create(NUM_PEERS)
  const firstClient = clients[0]
  const firstRemoteKey = daemons[0].noiseKeyPair.publicKey

  const received = (new Array(NUM_PEERS - 1)).fill(0)
  const msgs = ['hello', 'world'].map(s => Buffer.from(s))

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })
    const receivers = []
    const receiverTopics = []

    // The first peer joins the topic immediately
    const firstTopic = firstClient.peersockets.join('my-topic')

    // Start observing all peers that swarm the drive's discovery key.
    const unwatch = firstClient.peers.watchPeers(drive1.discoveryKey, {
      onjoin: (peerId) => {
        receivers.push(peerId)
      },
      onleave: (peerId) => {
        receivers.splice(receivers.indexOf(peerId), 1)
      }
    })

    // Each receiver peers swarms the drive and joins the topic.
    for (let i = 1; i < NUM_PEERS; i++) {
      await clients[i].drive.get({ key: drive1.key })
      receiverTopics.push(clients[i].peersockets.join('my-topic', {
        onmessage: async (peerId, msg) => {
          const remoteKey = await clients[i].peers.getKey(peerId)
          t.true(remoteKey.equals(firstRemoteKey))
          t.true(msg.equals(msgs[received[i - 1]++]))
        }
      }))
    }

    // All the clients should be swarming now
    await delay(100)

    for (const msg of msgs) {
      for (const peerId of receivers) {
        firstTopic.send(peerId, msg)
      }
    }

    // 1000 ms delay for all messages to be sent.
    await delay(1000)

    unwatch()
    firstTopic.close()
    for (const topic of receiverTopics) {
      topic.close()
    }
  } catch (err) {
    t.fail(err)
  }

  for (const count of received) {
    t.same(count, msgs.length)
  }
  await cleanup()
  t.end()
})

// TODO: There's a nondeterministic failure here on slow machines. Investigate.
test('peersockets, send to all peers swarming a drive, dynamically-added peers', async t => {
  const NUM_PEERS = 10

  const { clients, daemons, cleanup } = await create(NUM_PEERS)
  const firstClient = clients[0]
  const firstRemoteKey = daemons[0].noiseKeyPair.publicKey

  const received = (new Array(NUM_PEERS - 1)).fill(0)
  const firstMessage = Buffer.from('hello world')

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })
    const receivers = []
    const receiverTopics = []

    // The first peer joins the topic immediately
    const firstTopic = firstClient.peersockets.join('my-topic')

    // Start observing all peers that swarm the drive's discovery key.
    const unwatch = firstClient.peers.watchPeers(drive1.discoveryKey, {
      onjoin: (peerId) => {
        firstTopic.send(peerId, firstMessage)
        receivers.push(peerId)
      },
      onleave: (peerId) => {
        receivers.splice(receivers.indexOf(peerId), 1)
      }
    })

    // Each receiver peers swarms the drive and joins the topic.
    // Wait between each peer creation to test dynamic joins.
    for (let i = 1; i < NUM_PEERS; i++) {
      await clients[i].drive.get({ key: drive1.key })
      receiverTopics.push(clients[i].peersockets.join('my-topic', {
        onmessage: async (peerId, msg) => {
          const remoteKey = await clients[i].peers.getKey(peerId)
          t.true(remoteKey.equals(firstRemoteKey))
          t.true(msg.equals(firstMessage))
          received[i - 1]++
        }
      }))
      await delay(50)
    }

    unwatch()
    firstTopic.close()
    for (const topic of receiverTopics) {
      topic.close()
    }
  } catch (err) {
    t.fail(err)
  }

  for (const count of received) {
    t.same(count, 1)
  }
  await cleanup()
  t.end()
})

test('closing the last topic handle closes the topic', async t => {
  const { clients, daemons, cleanup } = await create(2)
  const firstClient = clients[0]
  const secondClient = clients[1]

  const firstPeersockets = daemons[0].peersockets.peersockets
  const firstKey = daemons[0].noiseKeyPair.publicKey
  const secondKey = daemons[1].noiseKeyPair.publicKey
  let received = false

  try {
    const drive1 = await firstClient.drive.get()
    await drive1.configureNetwork({ lookup: true, announce: true })
    await secondClient.drive.get({ key: drive1.key })

    // 100 ms delay for swarming.
    await delay(100)

    // The two peers should be swarming now.
    const firstTopic = firstClient.peersockets.join('my-topic', {
      onmessage: async (peerId, msg) => {
        const remoteKey = await firstClient.peers.getKey(peerId)
        t.true(remoteKey.equals(secondKey))
        t.same(msg, Buffer.from('hello peersockets!'))
        received = true
      }
    })
    const secondTopic = secondClient.peersockets.join('my-topic')
    const peerId = await secondClient.peers.getAlias(firstKey)
    secondTopic.send(peerId, 'hello peersockets!')

    // 100 ms delay for the message to be sent.
    await delay(100)

    // The topic should still be registered on the connection.
    t.same(firstPeersockets.topicsByName.size, 1)

    firstTopic.close()
    secondTopic.close()
  } catch (err) {
    t.fail(err)
  }

  // Delay for topics to be closed
  await delay(100)

  t.true(received)
  t.same(firstPeersockets.topicsByName.size, 0)

  await cleanup()
  t.end()
})

function delay (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
