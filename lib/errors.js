const grpc = require('@grpc/grpc-js')

function serverError (err) {
  return {
    code: grpc.status.UNKNOWN,
    message: err.toString()
  }
}

function requestError (message) {
  return {
    // TODO: better error code for malformed requests?
    code: grpc.status.UNIMPLEMENTED,
    message
  }
}

module.exports = {
  serverError,
  requestError
}
