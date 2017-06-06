import { BroadcastNetwork, MulticastNetwork, DynamicUnicastNetwork } from './network'
import { EventEmitter } from 'events'
import * as dgram from 'dgram'
import * as os from 'os'
import * as uuid from 'node-uuid'
import * as _ from 'lodash'

const reservedEvents = ['promotion', 'demotion', 'added', 'removed', 'master', 'hello', 'direct']

enum MulticommMode {
  Broadcast,
  Multicast,
  Unicast
}

export interface INode {
  id: string
  address: string
  unicastPort: number
  hostName: string
  isMaster: boolean
  isMasterEligible: boolean
  weight: number
  advertisement: any
}

class Node implements INode {
  id: string
  unicastPort: number
  hostName: string
  isMaster: boolean = false
  isMasterEligible: boolean
  weight: number = -Infinity
  advertisement: any = undefined

  private _address: string
  get address() {
    return this._address
  }
  set address(address: string) {
    this._address = isLocalIP(address) ? '127.0.0.1' : address
  }

  private _lastSeenBroadcast: number = 0
  private _lastSeenMulticast: number = 0
  get lastSeen() {
    return _.max([this._lastSeenBroadcast, this._lastSeenMulticast])
  }
  set lastSeenBroadcast(value: number) {
    this._lastSeenBroadcast = value
  }
  set lastSeenMulticast(value: number) {
    this._lastSeenMulticast = value
  }

  preferredMode(timeout: number) {
    if (this._address === '127.0.0.1') {
      return MulticommMode.Unicast
    } else if (+new Date() - this._lastSeenBroadcast <= timeout) {
      return MulticommMode.Broadcast
    } else {
      return MulticommMode.Multicast
    }
  }
}

class HelloData {
  isMaster: boolean = false
  isMasterEligible: boolean
  weight: number
  unicastPort: number
  advertisement: any
}

export class DiscoverOptions {
  helloInterval?: number
  checkInterval?: number
  nodeTimeout?: number
  masterTimeout?: number
  mastersRequired?: number
  address?: string
  port?: number
  key?: string
  reuseAddr?: boolean
  dictionary?: string[]
  broadcast?: string
  multicast?: string
  multicastTTL?: number
  unicastPort?: number
  weight?: number
  isMasterEligible?: boolean
}

export class Discover extends EventEmitter {
  private helloInterval = 1000
  private checkInterval = 2000
  private nodeTimeout = 2000
  private masterTimeout = 2000
  private mastersRequired = 1

  private me = new HelloData()
  private running = false
  private checkId: NodeJS.Timer
  private helloId: NodeJS.Timer
  private nodes = new Map<string, Node>()
  private channels = new Set<string>()
  private instanceUuid = uuid.v4()
  private broadcast: BroadcastNetwork
  private multicast: MulticastNetwork
  private dyunicast: DynamicUnicastNetwork

  constructor(options: DiscoverOptions, advertisement?: any) {
    super()

    this.helloInterval = options.helloInterval || 1000
    this.checkInterval = options.checkInterval || 2000
    this.nodeTimeout = options.nodeTimeout || 2000
    this.masterTimeout = options.masterTimeout || 2000
    this.mastersRequired = options.mastersRequired || 1

    if (this.nodeTimeout < this.checkInterval) {
      throw new Error('nodeTimeout must be greater than or equal to checkInterval.')
    }

    if (this.masterTimeout < this.nodeTimeout) {
      throw new Error('masterTimeout must be greater than or equal to nodeTimeout.')
    }

    const settings = {
      address: options.address || '0.0.0.0',
      port: options.port || 12345,
      key: options.key || null,
      reuseAddr: (options.reuseAddr === false) ? false : true,
      instanceUuid: this.instanceUuid,
      dictionary: (options.dictionary || []).concat(['isMaster', 'isMasterEligible', 'weight', 'address', 'advertisement']).concat(reservedEvents)
    }

    this.broadcast = new BroadcastNetwork(options.broadcast, settings)
    this.broadcast.on('error', (error: Error) => this.emit('error', error))
    this.broadcast.on('hello', (data: any[], obj: any, rinfo: dgram.RemoteInfo) => this.onHello(data[0], obj, rinfo, MulticommMode.Broadcast))

    ++settings.port

    this.multicast = new MulticastNetwork(options.multicast, options.multicastTTL, settings)
    this.multicast.on('error', (error: Error) => this.emit('error', error))
    this.multicast.on('hello', (data: any[], obj: any, rinfo: dgram.RemoteInfo) => this.onHello(data[0], obj, rinfo, MulticommMode.Multicast))

    settings.port = options.unicastPort || (settings.port + Math.ceil(Math.random() * 100))

    this.dyunicast = new DynamicUnicastNetwork(settings)
    this.dyunicast.on('error', (error: Error) => this.emit('error', error))
    this.dyunicast.on('direct', (data: any[], obj: any, rinfo: dgram.RemoteInfo) => this.emit('direct', data, obj, rinfo))

    this.me.weight = options.weight || Discover.weight()
    this.me.isMasterEligible = options.isMasterEligible || false
    this.me.unicastPort = settings.port
    this.me.advertisement = advertisement
  }

  private static weight() {
    return -(Date.now() / Math.pow(10, String(Date.now()).length))
  }

  start() {
    return new Promise<boolean>(async (resolve, reject) => {
      if (this.running) {
        resolve(false)
      }

      try {
        await this.broadcast.start()
      } catch (err) {
        this.broadcast.stop()
        reject(err)
      }

      try {
        await this.multicast.start()
      } catch (err) {
        this.broadcast.stop()
        this.multicast.stop()
        reject(err)
      }

      try {
        await this.dyunicast.start()
      } catch (err) {
        this.broadcast.stop()
        this.multicast.stop()
        this.dyunicast.stop()
        reject(err)
      }

      this.running = true

      this.checkId = setInterval(() => {
        let mastersFound = 0
        let higherWeightFound = false
        let higherMasterWeight = -Infinity

        this.nodes.forEach((node, key) => {
          if (+new Date() - node.lastSeen > this.nodeTimeout) {
            if (node.isMaster && (+new Date() - node.lastSeen) < this.masterTimeout) {
              mastersFound++
            }

            this.nodes.delete(key)
            this.emit('removed', node)
          } else if (node.isMaster) {
            mastersFound++
            higherMasterWeight = Math.max(higherMasterWeight, node.weight)
          } else if (node.isMasterEligible && node.weight > this.me.weight) {
            higherWeightFound = true
          }
        })

        if (this.me.isMasterEligible && !this.me.isMaster) {
          if (mastersFound < this.mastersRequired && !higherWeightFound) {
            this.promote()
          } else if (higherMasterWeight < 0 && this.me.weight > 0) {
            this.promote()
          }
        }
      }, this.checkInterval)

      this.helloId = setInterval(async () => await this.hello(), this.helloInterval)

      resolve(true)
    })
  }

  stop() {
    if (!this.running) {
      return false
    }

    this.broadcast.stop()
    this.multicast.stop()
    this.dyunicast.stop()

    clearInterval(this.checkId)
    clearInterval(this.helloId)

    this.running = false
  }

  async promote() {
    this.me.isMasterEligible = true
    this.me.isMaster = true
    this.emit('promotion', this.me)
    await this.hello()
  }

  async demote(permanent: boolean) {
    this.me.isMasterEligible = !permanent
    this.me.isMaster = false
    this.emit('demotion', this.me)
    await this.hello()
  }

  get isMaster() {
    return this.me.isMaster
  }

  get id() {
    return this.instanceUuid
  }

  async hello() {
    await this.broadcast.send('hello', this.me)
    await this.multicast.send('hello', this.me)
    this.emit('helloEmitted')
  }

  eachNode(fn: (node: INode) => void) {
    this.nodes.forEach((node) => fn(node))
  }

  join(channel: string, fn?: (data: any[], obj: any, rinfo: dgram.RemoteInfo) => void) {
    if (_.includes(reservedEvents, channel)) {
      return false
    }

    if (this.channels.has(channel)) {
      return false
    }

    if (fn) {
      this.on(channel, fn)
    }

    this.broadcast.on(channel, (data: any, obj: any, rinfo: dgram.RemoteInfo) => {
      this.emit(channel, data, obj, rinfo)
    })

    this.multicast.on(channel, (data: any, obj: any, rinfo: dgram.RemoteInfo) => {
      this.emit(channel, data, obj, rinfo)
    })

    this.dyunicast.on(channel, (data: any, obj: any, rinfo: dgram.RemoteInfo) => {
      this.emit(channel, data, obj, rinfo)
    })

    this.channels.add(channel)

    return true
  }

  leave(channel: string) {
    this.broadcast.removeAllListeners(channel)
    this.multicast.removeAllListeners(channel)
    this.dyunicast.removeAllListeners(channel)
    this.channels.delete(channel)
    return true
  }

  async send(channel: string, ...obj: any[]) {
    if (_.includes(reservedEvents, channel)) {
      return false
    }

    const groups = _.groupBy([...this.nodes.values()], (node) => node.preferredMode(this.nodeTimeout))
    const preferBroadcast = groups[MulticommMode.Broadcast] || []
    const preferMulticast = groups[MulticommMode.Multicast] || []
    const preferUnicast = groups[MulticommMode.Unicast] || []

    if (preferBroadcast.length === 0 && preferMulticast.length === 0) {
      await Promise.all([
        _.map(preferUnicast, (node) => this.dyunicast.sendTo(node.address, node.unicastPort, channel, false, ...obj))
      ])
    } else if (preferBroadcast.length >= preferMulticast.length) {
      await Promise.all([
        this.broadcast.send(channel, ...obj),
        _.map(preferMulticast, (node) => this.dyunicast.sendTo(node.address, node.unicastPort, channel, false, ...obj)),
        _.map(preferUnicast, (node) => this.dyunicast.sendTo(node.address, node.unicastPort, channel, false, ...obj))
      ])
    } else {
      await Promise.all([
        this.multicast.send(channel, ...obj),
        _.map(preferBroadcast, (node) => this.dyunicast.sendTo(node.address, node.unicastPort, channel, false, ...obj)),
        _.map(preferUnicast, (node) => this.dyunicast.sendTo(node.address, node.unicastPort, channel, false, ...obj))
      ])
    }

    return true
  }

  async sendTo(id: string, reliable: boolean, ...obj: any[]) {
    const dest = _.find([...this.nodes.values()], (node) => node.id === id)
    if (!dest) {
      return false
    } else {
      await this.dyunicast.sendTo(dest.address, dest.unicastPort, 'direct', reliable, ...obj)
    }

    return true
  }

  private onHello(data: HelloData, obj: any, rinfo: dgram.RemoteInfo, mode: MulticommMode) {
    /*
     * When receiving hello messages we need things to happen in the following order:
     *  - make sure the node is in the node list
     *  - if hello is from new node, emit added
     *  - if hello is from new master and we are master, demote
     *  - if hello is from new master emit master
     *
     * need to be careful not to over-write the old node object before we have information
     * about the old instance to determine if node was previously a master.
     */
    const isNew = !this.nodes.has(obj.iid)
    const node = this.nodes.get(obj.iid) || new Node()
    const wasMaster = node.isMaster

    node.id = obj.iid
    switch (mode) {
      case MulticommMode.Broadcast:
        node.lastSeenBroadcast = +new Date()
        break
      case MulticommMode.Multicast:
        node.lastSeenMulticast = +new Date()
        break
    }
    node.address = rinfo.address
    node.unicastPort = data.unicastPort || rinfo.port
    node.hostName = obj.hostName

    node.isMaster = data.isMaster
    node.isMasterEligible = data.isMasterEligible
    node.weight = data.weight
    node.advertisement = data.advertisement

    if (isNew) {
      this.nodes.set(obj.iid, node)
      this.emit('added', node, obj, rinfo)
    }

    this.emit('helloReceived', node)

    if (node.isMaster) {
      if ((isNew || !wasMaster)) {
        let masterCount = (this.me.isMaster) ? 1 : 0
        this.nodes.forEach((node) => {
          if (node.isMaster) {
            masterCount++
          }
        })

        if (this.me.isMaster && masterCount > this.mastersRequired) {
          this.demote(false)
        }

        this.emit('master', node, obj, rinfo)
      }
    }
  }
}

function isLocalIP(ip: string) {
  return _.some(_.filter(_.flatten(_.values(os.networkInterfaces())), (iface) => iface.family === 'IPv4' && iface.internal === false), ({ address }) => address === ip)
}
