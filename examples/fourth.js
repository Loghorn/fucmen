const Fucmen = require('..').Fucmen;
const crypto = require('crypto');

const fm = new Fucmen({ name: 'test4' }, { port: 22222, key: 'test', isMasterEligible: true });

fm.on('error', console.error);

fm.join('msg', (from, data) => {
    if (!from) {
        return;
    }
    const hash = crypto.createHash('sha256');
    hash.update(data);
    fm.sendTo(from.id, false, 'ack', hash.digest('hex'));
}, true);

let sentTot = 0;
let failuresTot = 0;

let msgHash = null;
let waiter = null;

const acks = new Map();

fm.onDirectMessage((from, msg, data) => {
    if (!from) {
        return;
    }
    if (msg === 'ack') {
        if (acks.has(from.id)) {
            acks.set(from.id, data);
            let wrong = 0;
            acks.forEach((v) => wrong += v !== msgHash ? 1 : 0);
            if (!wrong) {
                clearTimeout(waiter);
                const sent = acks.size;
                sentTot += sent;
                //console.log(`Sent: ${sent} failures: 0`);
                sendAndWait();
            }
        }
    }
}, true);

function sendAndWait() {
    const size = 10000;
    const message = crypto.randomBytes(size).toString('base64');
    const hash = crypto.createHash('sha256');
    hash.update(message);
    msgHash = hash.digest('hex');

    acks.clear();
    fm.connections.forEach((node) => acks.set(node.id, null));
    fm.publish('msg', message)
        .then(() => {
            const sent = acks.size;

            waiter = setTimeout(() => {
                let failures = 0;
                acks.forEach((v) => {
                    if (v !== msgHash) {
                        ++failures;
                    }
                });
                sentTot += sent;
                failuresTot += failures;
                //console.log(`Sent: ${sent} failures: ${failures} size: ${size}`);
                sendAndWait();
            }, 3000 * fm.connections.length);
        })
        .catch((e) => {
            console.log('publish failed', e);
            sendAndWait();
        });
}

fm.on('ready', () => {
    sendAndWait();

    setInterval(() => {
        console.log('connections:', fm.connections);
        console.log('nodes ', fm.nodes);
        console.log(`Total sent: ${sentTot} failures: ${failuresTot}   ${Math.round(failuresTot / sentTot * 1000)/10}%`);
    }, 30000);
});
