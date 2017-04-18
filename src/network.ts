import * as dgram from 'dgram'
import * as crypto from 'crypto'
import * as os from 'os'
import { EventEmitter } from 'events'
import * as uuid from 'node-uuid'
import * as Pack from 'node-pack'
import * as _ from 'lodash'

declare module 'dgram' {
  export function createSocket(options: { type: string, reuseAddr?: boolean }, callback?: (msg: Buffer, rinfo: RemoteInfo) => void): Socket
}

const processUuid = uuid.v4()
const hostName = os.hostname()

export type NetworkOptions = {
  instanceUuid: string,
  address: string
  port: number
  key: string | null
  reuseAddr: boolean
  ignoreProcess: boolean
  dictionary?: string[]
}

export abstract class Network extends EventEmitter {
  protected socket: dgram.Socket | null = null
  protected destinations = new Set<string>()
  private address: string
  private port: number
  private key: string | null
  private reuseAddr: boolean
  private ignoreProcess: boolean
  private instanceUuid: string
  private dictionary: any[]

  constructor(options: NetworkOptions) {
    super()

    this.address = options.address
    this.port = options.port
    this.key = options.key
    this.reuseAddr = options.reuseAddr
    this.ignoreProcess = options.ignoreProcess
    this.instanceUuid = options.instanceUuid
    this.dictionary = _.uniq((options.dictionary || []).concat(['event', 'pid', 'iid', 'hostName', 'data']))
  }

  start() {
    return new Promise<void>((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: this.reuseAddr }, async (data, rinfo) => {
        try {
          const obj = await this.decode(data, rinfo)
          if (!obj) {
            return false
          } else if (obj.iid === this.instanceUuid) {
            return false
          } else if (obj.pid === processUuid && this.ignoreProcess) {
            return false
          } else if (obj.event && obj.data) {
            this.emit(obj.event, obj.data, obj, rinfo)
          } else {
            this.emit('message', obj, rinfo)
          }
        } catch (err) {
          this.emit('error', err)
        }
      })

      this.socket.bind(this.port, this.address, () => {
        try {
          this.bonded()
          resolve()
        } catch (e) {
          this.emit('error', e)
          reject(e)
        }
      })
    })
  }

  stop() {
    this.socket && this.socket.close()
    this.socket = null
  }

  async send(event: string, ...data: any[]) {
    if (this.socket) {
      const contents = await this.prepareMessage(event, ...data)
      await Promise.all(_.map([...this.destinations.values()], (destination) => this.sendToDest(destination, contents)))
    }
  }

  protected abstract bonded(): void

  protected async sendToDest(destination: string, messages: Buffer[], port?: number) {
    if (!this.socket) {
      return Promise.resolve([])
    }
    const socket = this.socket
    for (let contents of messages) {
      await new Promise<number>((resolve, reject) => {
        socket.send(contents, 0, contents.length, port || this.port, destination, (err, bytes) => err ? reject(err) : resolve(bytes))
      })
    }
  }

  protected async prepareMessage(event: string, ...data: any[]) {
    const obj = {
      event: event,
      pid: uuid.parse(processUuid),
      iid: uuid.parse(this.instanceUuid),
      hostName: hostName,
      data: data
    }
    const msg = await this.encode(obj)
    if (msg.length > 1008) {
      const msgId = uuid.v4({}, new Buffer(18), 2)
      const chunks = _.map(_.chunk(msg, 950), c => new Buffer(c))
      const num = chunks.length
      if (num > 255) {
        throw new Error('Message ' + event + ' too long')
      }
      const msgs = _.map(chunks, c => Buffer.concat([msgId, c], 18 + c.length))
      _.forEach(msgs, (m, idx) => {
        m.writeUInt8(num, 0)
        m.writeUInt8(idx, 1)
      })
      return msgs
    }
    return [Buffer.concat([new Buffer([0]), msg], msg.length + 1)]
  }

  private encode(data: any) {
    return new Promise<Buffer>((resolve, reject) => {
      try {
        const tmp = this.key ? encrypt(Pack.encode(data, this.dictionary), this.key) : Pack.encode(data, this.dictionary)
        resolve(tmp)
      } catch (e) {
        reject(e)
      }
    })
  }

  // tslint:disable-next-line:member-ordering
  private msgBuffers = new Map<string, Map<number, Buffer>>()

  private decode(data: Buffer, rinfo: dgram.RemoteInfo) {
    const decodeBuffer = (buf: Buffer) => {
      try {
        const tmp = Pack.decode(this.key ? decrypt(buf, this.key) : buf, this.dictionary)
        tmp.iid = uuid.unparse(tmp.iid)
        tmp.pid = uuid.unparse(tmp.pid)
        return tmp
      } catch (e) {
        return undefined
      }
    }
    return new Promise<any>((resolve, reject) => {
      try {
        const num = data.readUInt8(0)
        if (!num) {
          resolve(decodeBuffer(data.slice(1)))
        } else {
          const idx = data.readUInt8(1)
          const msgId = uuid.unparse(data, 2)

          let buffers = this.msgBuffers.get(msgId)
          if (!buffers) {
            buffers = new Map<number, Buffer>()
          }
          buffers.set(idx, data.slice(18))
          if (this.msgBuffers.size > 10) {
            this.msgBuffers.clear()
          }
          this.msgBuffers.set(msgId, buffers)

          if (buffers.size === num) {
            this.msgBuffers.delete(msgId)

            const fullMsg = Buffer.concat(_.map(_.sortBy([...buffers.entries()], (e) => e[0]), (e) => e[1]))
            resolve(decodeBuffer(fullMsg))
          }

          resolve(undefined)
        }
      } catch (e) {
        reject(e)
      }
    })
  }
}

export class MulticastNetwork extends Network {
  private multicast: string
  private multicastTTL = 1
  constructor(multicastAddress: string = '224.0.2.1', ttl: number = 1, options: NetworkOptions) {
    super(options)

    this.multicast = multicastAddress
    this.multicastTTL = ttl
  }

  protected bonded() {
    // addMembership can throw if there are no interfaces available
    this.socket && this.socket.addMembership(this.multicast)
    this.socket && this.socket.setMulticastTTL(this.multicastTTL)
    this.destinations.add(this.multicast)
  }
}

export class BroadcastNetwork extends Network {
  private broadcast: string
  constructor(broadcastAddress: string = '255.255.255.255', options: NetworkOptions) {
    super(options)
    this.broadcast = broadcastAddress
  }

  protected bonded() {
    this.socket && this.socket.setBroadcast(true)
    this.destinations.add(this.broadcast)
  }
}

export class DynamicUnicastNetwork extends Network {
  private unicast: string[]
  constructor(options: NetworkOptions, unicastAddresses?: string | string[]) {
    super(options)

    if (typeof unicastAddresses === 'string') {
      if (~unicastAddresses.indexOf(',')) {
        this.unicast = unicastAddresses.split(',')
      } else {
        this.unicast = [unicastAddresses]
      }
    } else {
      this.unicast = unicastAddresses || []
    }
  }

  add(address: string) {
    this.destinations.add(address)
  }

  remove(address: string) {
    this.destinations.delete(address)
  }

  async sendTo(destination: string, port: number, event: string, ...data: any[]) {
    if (this.socket) {
      const contents = await this.prepareMessage(event, ...data)
      await this.sendToDest(destination, contents, port)
    }
  }

  protected bonded() {
    this.destinations = new Set(this.unicast)
  }
}

function encrypt(data: Buffer, key: string) {
  const cipher = crypto.createCipher('aes256', key)
  const buf = []
  buf.push(cipher.update(data))
  buf.push(cipher.final())
  return Buffer.concat(buf)
}

function decrypt(data: Buffer, key: string) {
  const decipher = crypto.createDecipher('aes256', key)
  const buf = []
  buf.push(decipher.update(data))
  buf.push(decipher.final())
  return Buffer.concat(buf)
}
