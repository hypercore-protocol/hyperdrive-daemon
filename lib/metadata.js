const p = require('path')
const os = require('os')
const fs = require('fs-extra')

const sodium = require('sodium-universal')

const METADATA_FILE_PATH = p.join(os.homedir(), '.hyperdrive')

async function createMetadata (endpoint) {
  var token = process.env['HYPERDRIVE_TOKEN']
  if (!token) {
    const rnd = Buffer.allocUnsafe(64)
    sodium.randombytes_buf(rnd)
    token = rnd.toString('hex')
  }
  return fs.writeFile(METADATA_FILE_PATH, JSON.stringify({
    token,
    endpoint
  }))
}

async function deleteMetadata () {
  return fs.unlink(METADATA_FILE_PATH)
}

module.exports = {
  createMetadata,
  deleteMetadata
}
