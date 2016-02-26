/// <reference path="../typings/tsd.d.ts"/>
'use strict';

var crypto = require('crypto');
var url = require('url');
var util = require('util');
var EventEmitter = require('eventemitter2').EventEmitter2;
var portfinder = require('portfinder');
var uuid = require('node-uuid');
var _ = require('lodash');
var Discovery = require('./Discovery');
var Socket = require('./sock');

var ip_regex = /(\d+\.\d+\.\d+\.\d+)(?::(\d+))?/;

var Fucmen = function (advertisement, discoveryOptions) {
    EventEmitter.call(this, {
        wildcard: true, // should the event emitter use wildcards.
        delimiter: '::', // the delimiter used to segment namespaces, defaults to `.`.
        newListener: false, // if you want to emit the newListener event set to true.
        maxListeners: 100 // the max number of listeners that can be assigned to an event, defaults to 10.
    });

    this.priority = crypto.randomBytes(4).readUInt32LE(0);
    this.uuid = uuid.v4();

    this.nodes = [];
    this.connections = [];
    this.manualConnections = [];
    this.outgoingConnections = {};

    this.advertisement = advertisement || {};

    var host = discoveryOptions && discoveryOptions.address || '0.0.0.0';

    var self = this;

    var create = function (err, port) {
        self.advertisement.port = +port;

        self.sock = new Socket();

        self.sock.on('connect', function (netsock, direction) {
            var host = netsock.remoteAddress + ":" + netsock.remotePort;
            if (direction === 'out') {
                if (_.some(self.connections, { host: host, direction: 'in' })) {
                    netsock.end();
                } else {
                    _.remove(self.connections, { host: host, direction: 'out' });
                    self.connections.push({
                        host: host,
                        socket: netsock,
                        direction: 'out'
                    });

                    self.sock.sendTo(netsock, 'connection::connected', netsock.address().address, port, self.priority, self.uuid);
                }
            }
        });

        self.sock.ontopic('connection::connected', function (address, port, priority, uuid, sock) {
            var host = address + ":" + port;
            if (priority < self.priority && _.find(self.connections, { host: host, direction: 'out' })) {
                self.sock.sendTo(sock, 'connection::drop', self.priority);
            } else {
                _.remove(self.connections, { host: host, direction: 'in' });
                self.connections.push({
                    host: host,
                    socket: sock,
                    direction: 'in'
                });
                _.remove(self.nodes, { host: host });
                self.nodes.push({
                    host: host,
                    uuid: uuid,
                    when: _.some(self.manualConnections, 'host', host) ? Infinity : process.uptime()
                });
                self.sock.sendTo(sock, 'connection::keep', self.priority);
                self.sock.sendTo(sock, 'connection::uuid', self.uuid);
            }
        });

        self.sock.ontopic('connection::drop', function (priority, sock) {
            sock.end();
        });

        self.sock.ontopic('connection::keep', function (priority, sock) {
        });

        self.sock.ontopic('connection::uuid', function (uuid, sock) {
            var host = sock.remoteAddress + ":" + sock.remotePort;
            var node = _.find(self.nodes, 'host', host);
            if (node) {
                node.uuid = uuid;
            }
        });

        self.sock.ontopic('connection::nodes::list', function (nodes, sock) {
            _.remove(nodes, 'uuid', self.uuid);
            _.remove(nodes, function (node) {
                return _.startsWith(node.host, '127.0.0.1') || isLocalIP(node.host.match(ip_regex)[1]);
            });
            _.forEach(_.pluck(self.nodes, 'host'), _.partial(_.remove, nodes, 'host'));
            _.forEach(nodes, function (node) {
                var forced = false;
                if (!node.when) {
                    self.manualConnections.push({ host: node.host });
                    forced = true;
                }
                self.nodes.push({
                    host: node.host,
                    uuid: node.uuid,
                    when: forced ? Infinity : process.uptime()
                });
            });
        });

        self.sock.ontopic('connection::nodes::remove', function (nodes, sock) {
            _.forEach(nodes, function (node) {
                self.disconnectFrom(node.host);
            });
        });

        self.sock.on('socket close', function (netsock, host, port) {
            host = host + ":" + port;
            _.remove(self.connections, { host: host, direction: 'out' });
            delete self.outgoingConnections[host];
        });

        self.sock.on('disconnect', function (netsock) {
            _.remove(self.connections, { socket: netsock, direction: 'in' });
        });

        self.advertisement.subscribesTo = self.advertisement.subscribesTo || ['*'];

        var namespace = '';
        if (self.advertisement.namespace) {
            namespace = self.advertisement.namespace + '::';
        }

        self.sock.bind(port, host);

        self.sock.on('bind', function () {
            self.emit(namespace + 'ready');
        });

        self.advertisement.subscribesTo.forEach(function (topic) {
            topic = 'message::' + namespace + topic;
            self.sock.ontopic(topic, function () {
                var args = Array.prototype.slice.call(arguments);

                if (args.length === 2) {
                    args.unshift(topic.substr(9));
                } else {
                    args[0] = namespace + args[0];
                }

                self.emit.apply(self, args);
            });
        });

        if (typeof discoveryOptions !== 'boolean' || discoveryOptions) {
            self.discovery = Discovery(self.advertisement, discoveryOptions);

            self.discovery.on('added', function (obj) {
                if (obj.advertisement.monitor || obj.advertisement.key !== self.advertisement.key) { return; }

                var host = (isLocalIP(obj.address) ? '127.0.0.1' : obj.address);
                var port = obj.advertisement.port;

                onadded.call(self, host + ":" + port, false);
            });

            self.discovery.on('error', function (err) {
                setTimeout(function () {
                    self.discovery.stop();
                    self.discovery.start();
                }, 5000);
            });
        }

        self.nodesInterval = setInterval(function () {
            self.sock.send('connection::nodes::list', _.reject(self.nodes, function (node) { return _.startsWith(_.get(node, 'host'), '127.0.0.1'); }));
        }, 10000);

        self.checkInterval = setInterval(function () {
            _.forEach(self.connections, function (c) { var node = _.find(self.nodes, 'host', c.host); if (node && node.when !== Infinity) { node.when = process.uptime(); } });
            _.remove(self.nodes, function (n) { return (process.uptime() - n.when) > 300; });
            var disconnected = _.reject(_.pluck(self.nodes, 'host'), function (k) { return _.some(self.connections, 'host', k); });
            _.forEach(disconnected, function (v) {
                connect.call(self, v);
            });
        }, 1000);
    };

    if (advertisement.port) {
        process.nextTick(create.bind(null, null, advertisement.port));
    } else {
        portfinder.getPort({ host: host }, create);
    }
};
util.inherits(Fucmen, EventEmitter);


Fucmen.prototype.close = function () {
    this.discovery && this.discovery.stop();
    this.manualConnections = [];
    this.nodes = [];
    this.connections = [];
    this.sock && this.sock.close();
    clearInterval(this.checkInterval);
    clearInterval(this.nodesInterval);
};


Fucmen.prototype.publish = function (topic, data) {
    var namespace = '';
    if (this.advertisement.namespace) {
        namespace = this.advertisement.namespace + '::';
    }

    topic = 'message::' + namespace + topic;

    this.sock && this.sock.send(topic, data);
};


Fucmen.prototype.on = function (type, listener) {
    var namespace = '';
    if (this.advertisement.namespace) {
        namespace = this.advertisement.namespace + '::';
    }

    return EventEmitter.prototype.on.call(this, namespace + type, listener);
};


Fucmen.prototype.connectTo = function (address, port) {
    var host = port === undefined ? address : address + ":" + port;
    if (!_.some(this.manualConnections, 'host', host)) {
        onadded.call(this, host, true);
        this.manualConnections.push({ host: host });
    }
};


Fucmen.prototype.disconnectFrom = function (address, port) {
    var host = port === undefined ? address : address + ":" + port;
    if (_.remove(this.manualConnections, { host: host })) {
        this.sock.send('connection::nodes::remove', _.remove(this.nodes, { host: host }));
        var sock = _.result(_.find(this.connections, { host: host }), 'socket');
        sock && sock.end();
    }
};


function onadded(host, forced) {
    var uuid = _.first(_.pluck(_.remove(this.nodes, { host: host }), 'uuid'));
    this.nodes.push({
        host: host,
        uuid: uuid,
        when: forced ? Infinity : process.uptime()
    });
    connect.call(this, host);
};


function connect(host) {
    if (!this.outgoingConnections[host]) {
        this.outgoingConnections[host] = true;
        this.sock.connect('tcp://' + host);
    }
};

function isLocalIP(ip) {
    return _(require('os').networkInterfaces())
        .values()
        .flatten()
        .filter(function (iface) { return iface.family === 'IPv4' && iface.internal === false; })
        .pluck('address')
        .some(function (addr) { return addr === ip; });
}

module.exports = Fucmen;
