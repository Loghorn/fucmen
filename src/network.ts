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
      const [contents] = await this.prepareMessage(event, false, ...data)
      await Promise.all(_.map([...this.destinations.values()], (destination) => this.sendToDest(destination, contents)))
    }
  }

  protected abstract bonded(): void

  protected async sendToDest(destination: string, messages: Buffer[], port?: number) {
    if (!this.socket) {
      return
    }
    const socket = this.socket
    const destPort = port || this.port
    for (let contents of messages) {
      await new Promise<number>((resolve, reject) => {
        socket.send(contents, 0, contents.length, destPort, destination, (err, bytes) => err ? reject(err) : resolve(bytes))
      })
    }
  }

  // tslint:disable-next-line:member-ordering
  private msgWaitingAckBuffers = new Map<string, AckBuffers>()

  protected async prepareMessage(event: string, requireAck: false | ((buffers: Buffer[]) => void), ...data: any[]): Promise<[Buffer[], null | Promise<void>]> {
    const obj = {
      event: event,
      pid: uuid.parse(processUuid),
      iid: uuid.parse(this.instanceUuid),
      hostName: hostName,
      data: data
    }
    const msg = await this.encode(obj)
    if (msg.length > 1008) {
      const chunks = _.map(_.chunk(msg, 980), c => new Buffer(c))
      const num = chunks.length
      if (num > 255) {
        throw new Error('Message ' + event + ' too long')
      }
      const msgId = uuid.v4({}, new Buffer(19), 3)
      msgId.writeUInt8(num, 0)
      msgId.writeUInt8(requireAck ? 1 : 0, 2)
      const msgs = _.map(chunks, c => Buffer.concat([msgId, c], 19 + c.length))
      _.forEach(msgs, (m, idx) => {
        m.writeUInt8(idx, 1)
      })
      if (requireAck) {
        const ackBuffers = new AckBuffers(msgs, requireAck)
        this.msgWaitingAckBuffers.set(uuid.unparse(msgId, 3), ackBuffers)
        return [msgs, ackBuffers.promise]
      } else {
        return [msgs, null]
      }
    } else {
      return [[Buffer.concat([new Buffer([0]), msg], msg.length + 1)], null]
    }
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
  private msgBuffers = new Map<string, MsgBuffer>()

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
        const numPackets = data.readUInt8(0)
        if (!numPackets) {
          resolve(decodeBuffer(data.slice(1)))
        } else if (numPackets === 1) {
          // ACK packet
          const msgId = uuid.unparse(data, 1)
          const ackBuffers = this.msgWaitingAckBuffers.get(msgId)
          if (ackBuffers) {
            if (ackBuffers.processAckPacket(data, 16 + 1)) {
              this.msgWaitingAckBuffers.delete(msgId)
            }
          }
        } else {
          const idx = data.readUInt8(1)
          const requireAck = data.readUInt8(2) ? true : false
          const msgId = uuid.unparse(data, 3)

          let buffer = this.msgBuffers.get(msgId)
          if (!buffer) {
            buffer = new MsgBuffer(numPackets)
          }
          buffer.buffers.set(idx, data.slice(19))
          if (this.msgBuffers.size > 10) {
            const oldBuffers = _.filter([...this.msgBuffers.entries()], (e) => e[1].isOld)
            _.forEach(oldBuffers, (e) => {
              // console.log('Removing buffer => ' + e[1].buffers.size + '/' + e[1].numBuffers)
              this.msgBuffers.delete(e[0])
            })
          }
          this.msgBuffers.set(msgId, buffer)

          if (requireAck && this.socket) {
            const ackBuf = new Buffer(1 + 16 + 256 / 8)
            ackBuf.writeUInt8(1, 0)
            uuid.parse(msgId, ackBuf, 1)
            ackBuf.fill(0, 17)
            const okPackets = new Set([...buffer.buffers.keys()])
            for (let i = 0; i < numPackets; ++i) {
              if (okPackets.has(i)) {
                const oldVal = ackBuf.readUInt8(1 + 16 + i / 8)
                ackBuf.writeUInt8(oldVal | (1 << (i % 8)), 1 + 16 + i / 8)
              }
            }
            this.socket.send(ackBuf, 0, ackBuf.length, rinfo.port, rinfo.address)
          }

          if (buffer.buffers.size === numPackets) {
            this.msgBuffers.delete(msgId)

            const fullMsg = Buffer.concat(_.map(_.sortBy([...buffer.buffers.entries()], (e) => e[0]), (e) => e[1]))
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

class AckBuffers {
  buffers = new Map<number, Buffer>()
  readonly promise: Promise<void>
  private resolve: (value?: any) => void
  private reject: (reason?: any) => void
  private timer: NodeJS.Timer
  private retries = 0
  constructor(buffers: Buffer[], cbk: (buffers: Buffer[]) => void) {
    _.forEach(buffers, (buf, idx) => this.buffers.set(idx, buf))
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })

    this.startTimer(cbk)
  }

  processAckPacket(data: Buffer, offset: number) {
    _.forEach([...this.buffers.keys()], (k) => {
      const ackVal = data.readUInt8(offset + k / 8)
      if (ackVal & (1 << (k % 8))) {
        this.buffers.delete(k)
      }
    })
    const completed = (this.buffers.size === 0)
    if (completed) {
      clearTimeout(this.timer)
      this.resolve()
    }
    return completed
  }

  private startTimer(cbk: (buffers: Buffer[]) => void) {
    this.timer = setTimeout(() => {
      if (++this.retries === 3) {
        this.reject(new Error('Too many retries'))
      } else {
        cbk([...this.buffers.values()])
        this.startTimer(cbk)
      }
    }, 800)
  }
}

class MsgBuffer {
  readonly arrivedAt: [number, number]
  readonly numBuffers: number
  buffers = new Map<number, Buffer>()
  constructor(numBuffers: number) {
    this.arrivedAt = process.hrtime() as [number, number]
    this.numBuffers = numBuffers
  }
  compare(other: MsgBuffer) {
    if (this.arrivedAt[0] === other.arrivedAt[0]) {
      return this.arrivedAt[1] - other.arrivedAt[1]
    } else {
      return this.arrivedAt[0] - other.arrivedAt[0]
    }
  }
  get isOld() {
    const age = process.hrtime(this.arrivedAt)
    // If older than 1 second
    return age[0] >= 1
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

  async sendTo(destination: string, port: number, event: string, reliable: boolean, ...data: any[]) {
    if (this.socket) {
      const [contents, completed] = await this.prepareMessage(event, reliable ? async (buffers) => {
        await this.sendToDest(destination, buffers, port)
      } : false, ...data)
      await this.sendToDest(destination, contents, port)
      return completed as Promise<void>
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
