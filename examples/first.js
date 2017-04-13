var Fucmen = require('..').Fucmen;
var util = require('util');
var colors = require('colors');

var fm = new Fucmen({ name: 'test1' }, { key: 'test', isMasterEligible: true });

fm.on('error', console.error);
fm.on('promoted', () => console.log('I AM MASTER!!!'.red.inverse));
fm.on('demoted', () => console.log('i am not master :('.grey.inverse));

fm.join('test_msg', console.log);

fm.on('ready', function () {
    var i = 0;
    setInterval(function () {
        fm.publish('test_msg', 'this is a test', 'message', i++);
    }, 1000);

    setInterval(function () {
        console.log('connections:'.red.underline, util.inspect(fm.connections).red);
        console.log('nodes '.cyan.underline, util.inspect(fm.nodes).cyan);
    }, 3000);
});
