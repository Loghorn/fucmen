/// <reference path="../typings/tsd.d.ts"/>
'use strict';

var Discover = require('node-discover');
var colors = require('colors');
var _ = require('lodash');

var default_log = function (log) {
    console.log.apply(console.log, log);
};

var Discovery = function (advertisement, discoveryOptions) {
    var options = discoveryOptions || {};

    _.defaults(options, {
        helloInterval: 2000,
        checkInterval: 4000,
        nodeTimeout: 5000,
        masterTimeout: 6000,
        log: false
    });

    _.defaults(advertisement, {
        type: 'service',
        monitor: false,
        name: 'UNDEFINED'
    });

    var log = typeof options.log === 'function' ? options.log : default_log;

    var disc = [];

    var dm = new Discover(options);
    dm.advertise(advertisement);
    options.log && log(helloLogger(dm));
    disc.push(dm);

    if (options.multicast) {
        delete options.multicast;
        var db = new Discover(options);
        db.advertise(advertisement);
        options.log && log(helloLogger(db));
        disc.push(db);
    }

    var discovery = {
        on: function (event, cb) {
            _.each(disc, function (d) { d.on(event, cb); });
        },
        start: function () {
            _.each(disc, function (d) { d.start(); });
        },
        stop: function () {
            _.each(disc, function (d) { d.stop(); });
        }
    };

    discovery.on('added', function (obj) {
        if (!advertisement.monitor && obj.advertisement.key !== advertisement.key) { return; }

        options.log && log(statusLogger(obj, 'online'));
    });

    discovery.on('removed', function (obj) {
        if (!advertisement.monitor && obj.advertisement.key !== advertisement.key) { return; }

        options.log && log(statusLogger(obj, 'offline'));
    });

    return discovery;
};

var helloLogger = function (d) {
    var adv = d.me,
        log = [];

    d.me.id = d.broadcast.instanceUuid;

    log.push('\nHello! I\'m'.white);
    log = log.concat(statusLogger(adv, null));
    log.push('\n========================\n'.white);

    return log;
};

var statusLogger = function (obj, config) {
    var adv = obj.advertisement,
        log = [],
        status;

    switch (config) {
        case 'online':
            status = '.online'.green;
            break;
        case 'offline':
            status = '.offline'.red;
            break;
    }

    if (status) {
        log.push(adv.type.magenta + status)
    }

    log.push(adv.name.bold.white + '#'.grey + obj.id.grey);

    if (adv.port) {
        log.push('on', adv.port.toString().yellow.bold);
    }

    return log;
};

module.exports = Discovery;
