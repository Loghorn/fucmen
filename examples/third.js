const Fucmen = require('..').Fucmen;
const crypto = require('crypto');

const fm = new Fucmen({ name: 'test3' }, { port: 11111, key: 'test', isMasterEligible: true });

fm.on('error', console.error);

let sentTot = 0;
let failuresTot = 0;

function sendAndWait() {
    const size = 10000 /*Math.floor(50000 + Math.random() * 100000)*/ /*Math.floor(Math.random() * 60) ? 3000 : 100000*/;
    const message = crypto.randomBytes(size).toString('base64');

    Promise.all(fm.connections.map((node) => {
        ++sentTot;
        return fm.sendTo(node.id, true, 'msg', message)
            .catch((e) => {
                ++failuresTot;
                // console.log('send failed', e);
            });
    }))
        .then(() => {
            setTimeout(() => sendAndWait(), 10);
        });
}

fm.on('ready', () => {
    console.log('READY');

    setTimeout(sendAndWait, 500);

    setInterval(() => {
        console.log(`Total sent: ${sentTot} failures: ${failuresTot}   ${Math.round(failuresTot / sentTot * 1000) / 10}%`);
    }, 30000);
/*
    setInterval(function () {
        console.log('connections:', fm.connections);
        console.log('nodes ', fm.nodes);
    }, 3000);
*/
});
