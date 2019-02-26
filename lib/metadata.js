const p = require('path')
const os = require('os')
const fs = require('fs-extra')

const sodium = require('sodium-universal')

const METADATA_FILE_PATH = p.join(os.homedir(), '.hypermount')

async function loadMetadata () {
  try {
    let contents = await fs.readFile(METADATA_FILE_PATH)
    if (contents) contents = JSON.parse(contents)
    return contents
  } catch (err) {
    return null
  }
}

async function createMetadata (endpoint) {
  const rnd = Buffer.allocUnsafe(64)
  sodium.randombytes_buf(rnd)
  return fs.writeFile(METADATA_FILE_PATH, JSON.stringify({
    token: rnd.toString('hex'),
    endpoint
  }))
}

async function deleteMetadata () {
  return fs.unlink(METADATA_FILE_PATH)
}

module.exports = {
  createMetadata,
  loadMetadata,
  deleteMetadata
}
