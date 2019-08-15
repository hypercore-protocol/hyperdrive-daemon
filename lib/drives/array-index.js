class ArrayIndex {
  constructor () {
    this._arr = []
  }

  _getFreeIndex () {
    var idx = this._arr.indexOf(null)
    if (idx === -1) idx = this._arr.length
    if (!idx) idx = 1
    return idx
  }

  get (idx) {
    return this._arr[idx]
  }

  insert (value) {
    const idx = this._getFreeIndex()
    this._arr[idx] = value
    return idx
  }

  delete (idx) {
    this._arr[idx] = null
  }
}

module.exports = ArrayIndex
