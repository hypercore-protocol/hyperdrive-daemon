const p = require('path')
const os = require('os')
const fs = require('fs-extra')

const sodium = require('sodium-universal')
const mkdirp = require('mkdirp')

const HYPERDRIVE_DIR = p.join(os.homedir(), '.hyperdrive')
const METADATA_FILE_PATH = p.join(HYPERDRIVE_DIR, 'config.json')

async function createMetadata (endpoint) {
  var token = process.env['HYPERDRIVE_TOKEN']
  if (!token) {
    const rnd = Buffer.allocUnsafe(64)
    sodium.randombytes_buf(rnd)
    token = rnd.toString('hex')
  }
  await new Promise((resolve, reject) => {
    mkdirp(HYPERDRIVE_DIR, err => {
      if (err) return reject(err)
      return resolve()
    })
  })
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
