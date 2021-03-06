/*
 * Copyright (c) 2013-2015 node-coap contributors.
 *
 * node-coap is licensed under an MIT +no-false-attribs license.
 * All rights not explicitly granted in the MIT license are reserved.
 * See the included LICENSE file for more details.
 */

require('./polyfill')

var dgram           = require('dgram')
  , net             = require('net')
  , util            = require('util')
  , series          = require('fastseries')
  , crypto          = require('crypto')
  , events          = require('events')
  , LRU             = require('lru-cache')
  , parse           = require('coap-packet').parse
  , generate        = require('coap-packet').generate
  , IncomingMessage = require('./incoming_message')
  , OutgoingMessage = require('./outgoing_message')
  , ObserveStream   = require('./observe_write_stream')
  , parameters      = require('./parameters')
  , RetrySend       = require('./retry_send')
  , parseBlock2     = require('./helpers').parseBlock2
  , createBlock2    = require('./helpers').createBlock2
  , getOption       = require('./helpers').getOption
  , middlewares     = require('./middlewares')

function handleEnding(err) {
  var request = this
  if (err) {
    request.server._sendError(new Buffer(err.message), request.rsinfo, request.packet)
  }
}

function CoAPServer(options, listener) {
  if (!(this instanceof CoAPServer)) {
    return new CoAPServer(options, listener)
  }

  if (typeof options === 'function') {
    listener = options
    options = null
  }

  if (!options)
    options = {}

  this._options = options
  this._proxiedRequests = {}

  this._middlewares = [
    middlewares.parseRequest
  ]

  if (options.proxy) {
    this._middlewares.push(middlewares.proxyRequest)
    this._middlewares.push(middlewares.handleProxyResponse)
  }

  this._middlewares.push(middlewares.handleServerRequest)

  // We use an LRU cache for the responses to avoid
  // DDOS problems.
  // max packet size is 1280
  // 32 MB / 1280 = 26214
  // The max lifetime is roughly 200s per packet.
  // Which gave us 131 packets/second guarantee
  this._lru = LRU({
      max: options.cacheSize || (32768 * 1024)
    , length: function(n) { return n.length }
    , maxAge: parameters.exchangeLifetime
    , dispose:  function(key, value) {
                  if (value.sender)
                    value.sender.reset()
                }
  })

  this._series = series()

  if (listener)
    this.on('request', listener)
}

util.inherits(CoAPServer, events.EventEmitter)

CoAPServer.prototype._sendError = function(payload, rsinfo, packet) {
  var message = generate({
    code: '5.00',
    payload: payload,
    messageId: (packet)?packet.messageId:undefined,
    token: (packet)?packet.token:undefined
  })

  this._sock.send(message, 0, message.length, rsinfo.port)
}

function removeProxyOptions(packet) {
  var cleanOptions = []

  for (var i = 0; i < packet.options.length; i++) {
    if (packet.options[i].name.toLowerCase() !== 'proxy-uri' && packet.options[i].name.toLowerCase() !== 'proxy-scheme') {
      cleanOptions.push(packet.options[i])
    }
  }

  packet.options = cleanOptions

  return packet;
}

CoAPServer.prototype._sendProxied = function(packet, proxyUri, callback) {
  var url = require('url').parse(proxyUri)
    , host = url.hostname
    , port = url.port
    , message = generate(removeProxyOptions(packet))

  this._sock.send(message, 0, message.length, port, host, callback)
}

CoAPServer.prototype._sendReverseProxied = function(packet, rsinfo, callback) {
  var host = rsinfo.address
    , port = rsinfo.port
    , message = generate(packet)

  this._sock.send(message, 0, message.length, port, host, callback)
}

function handleRequest(server) {
  return function (msg, rsinfo) {
    var request = {
        raw: msg,
        rsinfo: rsinfo,
        server: server
      }
      , activeMiddlewares = []

    for (var i = 0; i < server._middlewares.length; i++) {
      activeMiddlewares.push(server._middlewares[i])
    }

    server._series(request, activeMiddlewares, request, handleEnding)
  }
}

CoAPServer.prototype.listen = function(port, address, done) {
  var that = this

  if (port == undefined) {
    port = parameters.coapPort
  }

  if (typeof port === 'function') {
    done = port
    port = parameters.coapPort
  }

  if (typeof address === 'function') {
    done = address
    address = null
  }

  if (this._sock) {
    if (done)
      done(new Error('Already listening'))
    else
      throw new Error('Already listening')

    return this
  }

  if (address && net.isIPv6(address))
    this._options.type = 'udp6'

  if (!this._options.type)
    this._options.type = 'udp4'

  this._sock = dgram.createSocket(this._options.type, handleRequest(this))
  this._sock.on('error', function(error) {
    that.emit('error', error)
  })

  this._sock.bind(port, address || null, done || null)
  this._port = port
  this._address = address

  return this
}

CoAPServer.prototype.close = function(done) {
  if (done) {
    setImmediate(done)
  }

  if (this._sock) {
    this._sock.close()
    this._lru.reset()
    this._sock = null
  }

  return this
}

CoAPServer.prototype._handle = function(packet, rsinfo) {

  var sock      = this._sock
    , lru       = this._lru
    , acks      = this._acks
    , cached    = lru.peek(toKey(rsinfo.address, rsinfo.port, packet, true))
    , Message   = OutMessage
    , that = this
    , request
    , response

  if (cached && !packet.ack && !packet.reset)
    return sock.send(cached, 0, cached.length, rsinfo.port, rsinfo.address)
  else if (cached && (packet.ack || packet.reset)) {
    if (cached.response && packet.reset)
      cached.response.end()
    return lru.del(toKey(rsinfo.address, rsinfo.port, packet, false))
  }
  else if (packet.ack || packet.reset)
    return // nothing to do, ignoring silently

  request = new IncomingMessage(packet, rsinfo)

  if (request.headers['Observe'] === 0) {
    Message = ObserveStream
    if (packet.code !== '0.01')
      // it is not a GET
      return this._sendError(new Buffer('Observe can only be present with a GET'), rsinfo)
  }

  response = new Message(packet, function(response, packet) {
    var buf
      , sender = new RetrySend(sock, rsinfo.port,
                               rsinfo.address)

    try {
      buf = generate(packet)
    } catch(err) {
      return response.emit('error', err)
    }

    if (Message === OutMessage) {
      sender.on('error', response.emit.bind(response, 'error'))
    } else {
      buf.response = response
      sender.on('error', function() {
        response.end()
      })
    }

    lru.set(toKey(rsinfo.address, rsinfo.port,
                  packet, packet.ack || !packet.confirmable), buf)

    buf.sender = sender

    sender.send(buf, packet.ack || packet.reset || packet.confirmable === false)
  })

  request.rsinfo = rsinfo
  response.statusCode = '2.05'

  // if (response instanceof OutMessage) {
    response._request = request._packet
  // }

  // todo:
  // should use mem cache to buffer responses
  // dont alway bother uper layer, especially when the return is in blockwise (2)
  // if (cachedPayload)
  //   response.end(cachedPayload);
  // else
  //   this.emit('request', request, response)
  this.emit('request', request, response)
}

function toKey(address, port, packet, appendToken) {
  var result = address + port + packet.messageId

  if (appendToken)
    result += packet.token.toString('hex')

  return result
}

/*
new out message
inherit from OutgoingMessage
to handle cached answer and blockwise (2)
*/
function OutMessage() {
  OutgoingMessage.apply(this, Array.prototype.slice.call(arguments));
}
util.inherits(OutMessage, OutgoingMessage)

// maxBlock2 is in formular 2**(i+4), and must <= 2**(6+4)
var maxBlock2 = Math.pow(2, Math.floor(Math.log(parameters.maxPacketSize)/Math.log(2)))
if (maxBlock2 > Math.pow(2, (6+4)))
  maxBlock2 = Math.pow(2, (6+4))

OutMessage.prototype.end= function(payload) {
  var that = this

  var block2Buff = getOption(this._request.options, 'Block2')
  var requestedBlockOption
  // if we got blockwise (2) resquest
  if (block2Buff) {
    requestedBlockOption = parseBlock2(block2Buff)
    // bad option
    if (!requestedBlockOption) {
      that.statusCode = '4.02'
      return OutgoingMessage.prototype.end.call(that)
    }
  }

  // if payload is suitable for ONE message, shoot it out
  if (!payload || 
    ((!requestedBlockOption) && (payload.length < parameters.maxPacketSize)))
    return OutgoingMessage.prototype.end.call(this, payload)

  // for the first request, block2 option may be missed
  if (!requestedBlockOption) 
    requestedBlockOption = {
      size: maxBlock2,
      num: 0
    }

  // block2 size should not bigger than maxBlock2
  if (requestedBlockOption.size > maxBlock2) 
    requestedBlockOption.size = maxBlock2

  // block number should have limit 
  // 0 base counter for totalBlock, hence use floor (vs ceil)
  var totalBlock = Math.floor(payload.length/requestedBlockOption.size)
  var isLastBlock
  if (requestedBlockOption.num < totalBlock)
    isLastBlock = false
  else if (requestedBlockOption.num == totalBlock) 
    isLastBlock = true
  else {
    // precondition fail, may request for out of range block
    that.statusCode = '4.02'
    return OutgoingMessage.prototype.end.call(that)
  }

  var block2 = createBlock2({
    moreBlock2: isLastBlock,
    num: requestedBlockOption.num,
    size: requestedBlockOption.size
  })
  if (!block2) {
    // this catch never be match,
    // since we're gentleman, just handle it 
    that.statusCode = '4.02'
    return OutgoingMessage.prototype.end.call(that)
  }
  this.setOption('Block2', block2)
  this.setOption('ETag', _toETag(payload))

  OutgoingMessage.prototype.end.call(this, payload.slice((requestedBlockOption.num)*requestedBlockOption.size, (requestedBlockOption.num+1)*requestedBlockOption.size))
};

/*
calculate id of a payload by xor each 2-byte-block from it
use to generate etag
  payload         an input buffer, represent payload need to generate id (hash)
  id              return var, is a buffer(2)
*/
function _toETag(payload) {
  var id = new Buffer([0,0])
  var i = 0
  do {
    id[0] ^= payload[i]
    id[1] ^= payload[i+1]
    i += 2
  } while (i<payload.length)
  return id
}

module.exports = CoAPServer
