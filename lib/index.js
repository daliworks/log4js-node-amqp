'use strict'
var log4js = require('log4js')
var amqp = require('amqp')

var options
var connection
var sendTimer
var exchange
var logEventBuffer = []

function publish () {
  if (!exchange) {
    return
  }

  var toLog
  while (logEventBuffer.length > 0) {
    toLog = logEventBuffer.shift()
    exchange.publish(
      options.publish.routingKey,
      options.logEventInterceptor(toLog, options.additionalInfo),
      options.publish
    )
  }
}

function schedulePublish () {
  if (sendTimer) {
    return
  }

  sendTimer = setTimeout(function () {
    clearTimeout(sendTimer)
    sendTimer = null
    publish()
  }, options.sendInterval)
}

function setObjectDefaults (obj, defaults) {
  obj = obj || {}

  Object.keys(defaults).forEach(function (key) {
    if (!obj.hasOwnProperty(key)) {
      obj[ key ] = defaults[ key ]
      return
    }
    if (Object.prototype.toString.call(obj[ key ]) === '[object Object]') {
      return setObjectDefaults(obj[ key ], defaults[ key ])
    } else {
      obj[ key ] = obj[ key ]
    }
  })
  return obj
}

function amqpAppender (opts) {
  if (opts && opts.skip) {
    console.log('[log4js-node-amqp] skip adding appender with empty appender');

    if (connection && typeof connection.disconnect === 'function') {
      console.log('[log4js-node-amqp] disconnect previous connection', connection.options);
      connection.disconnect();
    }    

    return function emptyAppender() {
    }
  } else {
    console.log('[log4js-node-amqp] adding appender', opts);
  }

  options = setObjectDefaults(opts, {
    connection: {
      url: 'amqp://guest:guest@localhost:5672',
      clientProperties: {
        product: 'log4js'
      }
    },
    exchange: {
      name: 'logExchange',
      type: 'fanout',
      durable: true,
      autoDelete: false
    },
    publish: {
      mandatory: true,
      deliveryMode: 2, // persistent
      routingKey: 'msg'
    },
    sendInterval: 0,
    layout: log4js.layouts.messagePassThroughLayout,
    additionalInfo: {},
    logEventInterceptor: function (logEvent, additionalInfo) {
      return setObjectDefaults({
        timestamp: logEvent.startTime,
        data: logEvent.data,
        level: logEvent.level,
        category: logEvent.logger.category
      }, additionalInfo)
    }
  })

  options.sendInterval *= 1000

  process.once('exit', shutdown)

  if (connection && typeof connection.disconnect === 'function') {
    console.log('[log4js-node-amqp] disconnect previous connection', connection.options);
    connection.disconnect();
  }

  connection = amqp.createConnection(options.connection)

  connection.once('ready', function () {
    // create exchange and queue (if they don't exist) and bind the queue to the exchange
    connection.exchange(options.exchange.name, options.exchange, function (ex) {
      exchange = ex

      if (!options.queue) {
        return publish()
      }

      connection.queue(options.queue.name, options.queue, function (queue) {
        queue.bind(exchange, options.publish.routingKey)
        publish() // in case messages are waiting to be written
      })
    })
  })

  return function log4jsNodeAmqp (loggingEvent) {
    if (Object.prototype.toString.call(loggingEvent.data[ 0 ]) === '[object String]') {
      loggingEvent.data = options.layout(loggingEvent)
    } else if (loggingEvent.data.length === 1) {
      loggingEvent.data = loggingEvent.data.shift()
    }

    logEventBuffer.push(loggingEvent)

    if (options.sendInterval > 0) {
      return schedulePublish()
    }

    publish()
  }
}

function configure (config) {
  if (config.layout) {
    config.layout = log4js.layouts.layout(config.layout.type, config.layout)
  }

  return amqpAppender(config)
}

function shutdown (cb) {
  console.log('[log4js-node-amqp/shutdown]', connection, arguments);

  if (!connection) {
    if (typeof cb === 'function') {
      cb()
    }

    return
  }

  publish()

  if (typeof connection.disconnect === 'function') {
    console.log('[log4js-node-amqp/shutdown] disconnect');
    connection.disconnect()
  }

  if (typeof cb === 'function') {
    console.log('[log4js-node-amqp/shutdown] callback')
    cb()
  }
}

exports.name = 'amqp'
exports.appender = amqpAppender
exports.configure = configure
exports.shutdown = shutdown
