import 'babel-polyfill'

import { EventEmitter } from 'events'
import * as dgram from 'dgram'

import { Discover, INode } from './discover'

export interface IFucmenNode {
  id: string
  host: string
  master: boolean
  adv: any
}

export class Fucmen extends EventEmitter {
  private allNodes: IFucmenNode[] = []

  private discover: Discover

  constructor(advertisement: any, discoveryOptions: any) {
    super()

    this.discover = new Discover(discoveryOptions, advertisement)

    this.discover.on('added', (node: INode) => this.allNodes.push({ id: node.id, host: node.address + ':' + node.unicastPort, master: node.isMaster, adv: node.advertisement }))
    this.discover.on('promotion', () => this.emit('promoted'))
    this.discover.on('demotion', () => this.emit('demoted'))
    this.discover.on('master', (node: INode) => this.emit('master', { id: node.id, host: node.address + ':' + node.unicastPort, master: true, adv: node.advertisement }))
    this.discover.on('error', (error: Error) => this.emit('error', error))
    this.discover.on('direct', (data: any[], obj: any, rinfo: dgram.RemoteInfo) => this.emit('direct', data, obj, rinfo))

    this.discover.start().then((started) => started && this.emit('ready'))
  }

  get id() {
    return this.discover.id
  }

  get nodes() {
    return this.allNodes
  }

  get connections() {
    const nodes: IFucmenNode[] = []
    this.discover.eachNode((node) => nodes.push({ id: node.id, host: node.address + ':' + node.unicastPort, master: node.isMaster, adv: node.advertisement }))
    return nodes
  }

  publish(channel: string, ...data: any[]) {
    return this.discover.send(channel, ...data)
  }

  join(channel: string, listener: (...data: any[]) => void) {
    return this.discover.join(channel, (data, obj, rinfo) => listener(...data))
  }

  joinEx(channel: string, listener: (from: string, ...data: any[]) => void) {
    return this.discover.join(channel, (data, obj, rinfo) => listener(obj.iid, ...data))
  }

  leave(channel: string) {
    return this.discover.leave(channel)
  }

  sendTo(id: string, ...data: any[]) {
    return this.discover.sendTo(id, ...data)
  }

  onDirectMessage(listener: (...data: any[]) => void) {
    this.discover.on('direct', (data: any[], obj: any, rinfo: dgram.RemoteInfo) => listener(...data))
  }

  onDirectMessageEx(listener: (from: string, ...data: any[]) => void) {
    this.discover.on('direct', (data: any[], obj: any, rinfo: dgram.RemoteInfo) => listener(obj.iid, ...data))
  }
}