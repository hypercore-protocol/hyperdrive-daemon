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

module.exports = {
  getHandlers
}
