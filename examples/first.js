var Fucmen = require('..');
var util = require('util');
var colors = require('colors');

var fm = new Fucmen({ name: 'test1' }, { log: true });

fm.on('test_msg', function (data) {
    console.log(data);
});

fm.on('ready', function () {
    var i = 0;
    setInterval(function () {
        fm.publish('test_msg', ['this is a test', 'message', fm.priority, i++]);
    }, 1000);
    /*
    setTimeout(function () {
        fm.close();
    }, 5000)
    */

    setInterval(function () {
//        console.log('connections:'.red.bold, util.inspect(fm.connections).red);
        console.log('nodes '.cyan.bold, util.inspect(fm.nodes).cyan);
    }, 3000);
});
