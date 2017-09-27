import 'babel-polyfill'

import { EventEmitter } from 'events'
import * as dgram from 'dgram'

import { Discover, INode, DiscoverOptions } from './discover'

export interface IFucmenNode {
  id: string
  host: string
  master: boolean
  adv: any
}

export class Fucmen extends EventEmitter {
  private allNodes = new Map<string, IFucmenNode>()

  private discover: Discover

  constructor(advertisement: any, discoveryOptions: DiscoverOptions) {
    super()

    this.discover = new Discover(discoveryOptions, advertisement)

    this.discover.on('added', (node: INode) => this.allNodes.set(node.id, { id: node.id, host: node.address + ':' + node.unicastPort, master: node.isMaster, adv: node.advertisement }))
    this.discover.on('promotion', () => this.emit('promoted'))
    this.discover.on('demotion', () => this.emit('demoted'))
    this.discover.on('master', (node: INode) => this.emit('master', { id: node.id, host: node.address + ':' + node.unicastPort, master: true, adv: node.advertisement }))
    this.discover.on('error', (error: Error) => this.emit('error', error))
    this.discover.on('direct', (data: any[], obj: any, rinfo: dgram.RemoteInfo) => this.emit('direct', data, obj, rinfo))

    this.restart().then((started) => started && this.emit('ready'))
  }

  get id() {
    return this.discover.id
  }

  get isMaster() {
    return this.discover.isMaster
  }

  get nodes() {
    const nodes: IFucmenNode[] = []
    this.allNodes.forEach((node) => nodes.push(node))
    return nodes
  }

  get connections() {
    const nodes: IFucmenNode[] = []
    this.discover.eachNode((node) => nodes.push({ id: node.id, host: node.address + ':' + node.unicastPort, master: node.isMaster, adv: node.advertisement }))
    return nodes
  }

  setAdvertisement(advertisement?: any) {
    return this.discover.setAdvertisement(advertisement)
  }

  setMasterEligible() {
    return this.discover.setMasterEligible()
  }

  promote() {
    return this.discover.promote()
  }

  demote(permanent: boolean) {
    return this.discover.demote(permanent)
  }

  publish(channel: string, ...data: any[]) {
    return this.discover.send(channel, ...data)
  }

  join(channel: string, listener: (...data: any[]) => void, withFrom?: false): boolean
  join(channel: string, listener: (from: IFucmenNode | undefined, ...data: any[]) => void, withFrom: true): boolean
  join(channel: string, listener: any, withFrom?: boolean) {
    if (withFrom) {
      return this.discover.join(channel, (data, obj, rinfo) => listener(this.getNodeFromId(obj.iid), ...data))
    } else {
      return this.discover.join(channel, (data, obj, rinfo) => listener(...data))
    }
  }

  leave(channel: string) {
    return this.discover.leave(channel)
  }

  sendTo(id: string, reliableMaxRetries: boolean | number, ...data: any[]) {
    return this.discover.sendTo(id, reliableMaxRetries === true ? 3 : (reliableMaxRetries || 0), ...data)
  }

  onDirectMessage(listener: (...data: any[]) => void, withFrom?: false): void
  onDirectMessage(listener: (from: IFucmenNode | undefined, ...data: any[]) => void, withFrom: true): void
  onDirectMessage(listener: any, withFrom?: boolean) {
    if (withFrom) {
      this.discover.on('direct', (data: any[], obj: any, rinfo: dgram.RemoteInfo) => listener(this.getNodeFromId(obj.iid), ...data))
    } else {
      this.discover.on('direct', (data: any[], obj: any, rinfo: dgram.RemoteInfo) => listener(...data))
    }
  }

  restart() {
    this.discover.stop()
    return this.discover.start()
  }

  private getNodeFromId(id: string) {
    return this.connections.find((node) => node.id === id)
  }
}
