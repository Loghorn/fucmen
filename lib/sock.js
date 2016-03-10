/// <reference path="../typings/tsd.d.ts"/>
'use strict';

var url = require('url');
var net = require('net');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Message = require('amp-message');
var Parser = require('amp').Stream;
var escape = require('escape-regexp');
var _ = require('lodash');

module.exports = Socket;

function Socket() {
    EventEmitter.call(this);
    this.server = null;
    this.socks = [];
    this.listeners = [];
}
util.inherits(Socket, EventEmitter);

function pack(args) {
    var msg = new Message(args);
    return msg.toBuffer();
};

Socket.prototype.send = function (msg) {
    var buf = pack(arguments);
    _.forEach(this.socks, function (sock) {
        if (sock.writable) {
            sock.write(buf);
        }
    });

    return this;
};

Socket.prototype.sendTo = function (sock, msg) {
    if (sock.writable) {
        var buf = pack(Array.prototype.slice.call(arguments, 1));
        sock.write(buf);
    }

    return this;
};

Socket.prototype.close = function () {
    _.forEach(this.socks, function (sock) {
        sock.destroy();
    });
    if (this.server) {
        this.server.close();
        this.server = null;
    }
};

Socket.prototype.removeSocket = function (sock) {
    _.pull(this.socks, sock);
};

Socket.prototype.addSocket = function (sock) {
    var parser = new Parser;
    sock.pipe(parser);
    parser.on('data', this.onmessage(sock));
    this.socks.push(sock);
};

Socket.prototype.onmessage = function (sock) {
    var listeners = this.listeners;
    var self = this;

    return function (buf) {
        var msg = new Message(buf);
        var topic = msg.shift();

        for (var i = 0; i < listeners.length; ++i) {
            var listener = listeners[i];

            var m = listener.re.exec(topic);
            if (!m) {
                continue;
            }

            listener.fn.apply(self, _.rest(m).concat(msg.args).concat(sock));
        }
    }
};

function toRegExp(str) {
    if (str instanceof RegExp) {
        return str;
    }
    str = escape(str);
    str = str.replace(/\\\*/g, '(.+)');
    return new RegExp('^' + str + '$');
};

Socket.prototype.ontopic = function (event, fn) {
    var re = toRegExp(event);
    this.listeners.push({
        event: event,
        re: re,
        fn: fn
    });
    return this;
};

Socket.prototype.offtopic = function (event) {
    _.remove(this.listeners, 'event', event);
    return this;
};

var ignore = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'EPIPE',
    'ENOENT'
];

Socket.prototype.handleErrors = function (sock) {
    var self = this;
    sock.on('error', function (err) {
        self.emit('socket error', err);
        self.removeSocket(sock);
        if (!_.includes(ignore, err.code)) {
            return self.emit('error', err);
        }
        self.emit('ignored error', err);
    });
};

Socket.prototype.connect = function (port, host, fn) {
    var self = this;
    if ('function' === typeof host) {
        fn = host;
        host = undefined;
    }

    if ('string' === typeof port) {
        port = url.parse(port);
        host = port.hostname || '0.0.0.0';
        port = parseInt(port.port, 10);
    } else {
        host = host || '0.0.0.0';
    }

    var sock = new net.Socket;
    sock.setNoDelay();
    this.handleErrors(sock);

    sock.on('close', function () {
        self.emit('socket close', sock, host, port);
        self.removeSocket(sock);
        fn && fn(false);
        fn = undefined;
    });

    sock.on('connect', function () {
        self.addSocket(sock);
        self.emit('connect', sock, 'out');
        fn && fn(true);
        fn = undefined;
    });

    sock.connect(port, host);
    return this;
};

Socket.prototype.onconnect = function (sock) {
    var self = this;
    this.addSocket(sock);
    this.handleErrors(sock);
    this.emit('connect', sock, 'in');
    sock.on('close', function () {
        self.emit('disconnect', sock);
        self.removeSocket(sock);
    });
};

Socket.prototype.bind = function (port, host, fn) {
    if ('function' === typeof host) {
        fn = host;
        host = undefined;
    }

    if ('string' === typeof port) {
        port = url.parse(port);
        host = port.hostname || '0.0.0.0';
        port = parseInt(port.port, 10);
    } else {
        host = host || '0.0.0.0';
    }

    this.server = net.createServer(this.onconnect.bind(this));

    this.server.on('listening', this.emit.bind(this, 'bind'));

    this.server.listen(port, host, fn);
    return this;
};
