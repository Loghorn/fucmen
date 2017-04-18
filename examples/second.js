var Fucmen = require('..').Fucmen;
var util = require('util');
var colors = require('colors');

var fm = new Fucmen({ name: 'test2' }, { key: 'test' });

fm.on('error', console.error);
fm.on('master', (node) => console.log(('NEW MASTER ' + node.id).white.inverse));

fm.joinEx('test_msg', (from, data) => {
    console.log(from.blue, util.inspect(data, { colors: true }));
    fm.sendTo(from, 'A direct message', data[2]);
});

fm.on('ready', function () {
    var i = 0;
    setInterval(function() {
        fm.publish('test_msg', ['this is a test', 'message', i++]);
    }, 1000);

    setInterval(function () {
        console.log('connections:'.red.bold, util.inspect(fm.connections, { colors: true }));
    }, 5000);
});

fm.onDirectMessageEx(console.log);
