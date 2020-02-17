const ArrayIndex = require('../drives/array-index')
const hyperfuse = require('hyperdrive-fuse')

// TODO: Should import from Hyperdrive.
const STDIO_CAP = 20

class VirtualFile {
  constructor (contents) {
    this.contents = Buffer.from(contents)
  }

  read (buffer, len, offset, cb) {
    const buf = this.contents.slice(offset, offset + len)
    return process.nextTick(cb, buf.copy(buffer))
  }
}

/**
 * VirtualFiles use exclusively odd file descriptors, so that they don't clash with those created by Hyperdrive.
 */
class VirtualFiles {
  constructor () {
    this.descriptors = new ArrayIndex()
  }

  get (fd) {
    return this.descriptors.get((fd - STDIO_CAP - 1) / 2)
  }

  open (contents) {
    const idx = this.descriptors.insert(new VirtualFile(contents))
    return 2 * idx + 1 + STDIO_CAP
  }

  close (path, fd, cb) {
    this.descriptors.delete((fd - STDIO_CAP - 1) / 2)
    return process.nextTick(cb, 0)
  }

  read (path, fd, buffer, len, offset, cb) {
    const virtualFile = this.get(fd)
    if (!virtualFile) return cb(hyperfuse.EBADF)
    return virtualFile.read(buffer, len, offset, cb)
  }
}

module.exports = {
  VirtualFiles
}
