const collectStream = require('stream-collector')

function getHandlers (manager) {
  const handlers = {}
  const rpcMethods = Object.getOwnPropertyNames(manager.__proto__).filter(methodName => methodName.startsWith('_rpc'))
  for (let methodName of rpcMethods) {
    let rpcMethodName = methodName.slice(4)
    rpcMethodName = rpcMethodName.charCodeAt(0).toLowerCase() + rpcMethodName.slice(1)
    handlers[rpcMethodName] = manager[methodName].bind(manager)
  }
  return handlers
}

function dbCollect (index, opts) {
  return new Promise((resolve, reject) => {
    collectStream(index.createReadStream(opts), (err, list) => {
      if (err) return reject(err)
      return resolve(list)
    })
  })
}

async function dbGet (db, idx) {
  try {
    return await db.get(idx)
  } catch (err) {
    if (err && !err.notFound) throw err
    return null
  }
}

module.exports = {
  getHandlers,
  dbCollect,
  dbGet
}
