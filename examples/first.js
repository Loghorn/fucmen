var Fucmen = require('..').Fucmen;
var util = require('util');
var colors = require('colors');

function createFM(weight) {
    var p = new Promise((resolve) => {
        setTimeout(() => {
            var fm = new Fucmen({ name: 'test1', weight }, { key: 'test', isMasterEligible: false, weight, checkInterval: 1000 });
            console.log('Created'.white.inverse, weight);

            fm.on('error', console.error);
            fm.on('promoted', () => console.log('I AM MASTER!!!'.red.inverse, weight));
            fm.on('demoted', () => console.log('i am not master :('.grey.inverse, weight));

            fm.join('test_msg', console.log);

            fm.on('ready', function() {
                var i = 0;
                setInterval(function() {
                    //fm.publish('test_msg', 'this is a test', 'message', i++);
                }, Math.abs(weight * 60000));

                setTimeout(function() {
                    console.log('I want to be MASTER!'.blue.inverse, weight);
                    fm.promote();
                }, Math.random() * 100000);

                setTimeout(function() {
                    console.log('RESTART!!!!!!!!!!!!!!!!!!!'.red, weight);
                    fm.restart();
                }, Math.random() * 100000);

                resolve(fm);
            });
        }, Math.abs(weight * 5));
    });
    return p;
}

var weights = [-1, 2, 3, -4, 3];

Promise.all(weights.map((weight) => createFM(weight)))
    .then((fms) => {
        const fm = fms[0];
        setInterval(function() {
            console.log('connections:'.red.underline, util.inspect(fm.connections, false, 2, true));
        }, 3000);
    });
