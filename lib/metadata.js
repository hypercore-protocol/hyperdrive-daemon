const p = require('path')
const os = require('os')
const fs = require('fs-extra')

const sodium = require('sodium-universal')
const mkdirp = require('mkdirp')

const constants = require('hyperdrive-daemon-client/lib/constants')

async function createMetadata (endpoint) {
  var token = constants.env.token
  if (!token) {
    const rnd = Buffer.allocUnsafe(64)
    sodium.randombytes_buf(rnd)
    token = rnd.toString('hex')
  }
  await new Promise((resolve, reject) => {
    mkdirp(constants.root, err => {
      if (err) return reject(err)
      return resolve()
    })
  })
  return fs.writeFile(constants.metadata, JSON.stringify({
    token,
    endpoint
  }))
}

async function deleteMetadata () {
  return fs.unlink(constants.metadata)
}

module.exports = {
  createMetadata,
  deleteMetadata
}
