/// <reference path="../typings/tsd.d.ts"/>
'use strict';

var Discover = require('node-discover');
var colors = require('colors');
var _ = require('lodash');

var default_log = function(log) {
    console.log.apply(console.log, log);
};

var Discovery = function(advertisement, discoveryOptions) {
    var options = discoveryOptions || {};

    _.defaults(options, {
        helloInterval: 5000,
        checkInterval: 10000,
        nodeTimeout: 10000,
        masterTimeout: 10000,
        log: false
    });

    _.defaults(advertisement, {
        type: 'service',
        monitor: false,
        name: 'UNDEFINED'
    });

    var d = new Discover(options);

    d.advertise(advertisement);

    var log = typeof options.log === 'function' ? options.log : default_log;

    options.log && log(helloLogger(d));

    d.on('added', function(obj) {
        if (!advertisement.monitor && obj.advertisement.key !== advertisement.key) { return; }

        options.log && log(statusLogger(obj, 'online'));
    });

    d.on('removed', function(obj) {
        if (!advertisement.monitor && obj.advertisement.key !== advertisement.key) { return; }

        options.log && log(statusLogger(obj, 'offline'));
    });

    return d;
};

var helloLogger = function(d) {
    var adv = d.me,
        log = [];

    d.me.id = d.broadcast.instanceUuid;

    log.push('\nHello! I\'m'.white);
    log = log.concat(statusLogger(adv, null));
    log.push('\n========================\n'.white);

    return log;
};

var statusLogger = function(obj, config) {
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
