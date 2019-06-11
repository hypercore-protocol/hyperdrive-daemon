const grpc = require('grpc')

function serverError (err) {
  return {
    code: grpc.status.UNKNOWN,
    msg: err.toString()
  }
}

function requestError (msg) {
  return {
    // TODO: better error code for malformed requests?
    code: grpc.status.UNIMPLEMENTED,
    msg
  }
}

function catchErrors (methods) {
  const checked = {}
  for (const methodName of Object.keys(methods)) {
    const method = methods[methodName]
    checked[methodName] = function (call, ...args) {
      // TODO: Support better middleware so that this can be extracted.
      const cb = args[args.length - 1]
      method(call)
        .then(rsp => {
          if (cb) return cb(null, rsp)
          return call.end(rsp)
        })
        .catch(err => {
          const error = serverError(err)
          if (cb) return cb(error)
          return call.destroy(error)
        })
    }
  }
  return checked
}

module.exports = {
  serverError,
  requestError,
  catchErrors
}
