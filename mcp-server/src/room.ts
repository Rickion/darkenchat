import { WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from './adapter/webrtc.js'

const ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]
const HEARTBEAT_MS = 3000

export interface RoomSession {
  clientId: string
  nickname: string
  roomKey: string
  members: Array<{ clientId: string; nickname: string; isBot?: boolean }>
}

export interface IncomingMessage {
  from: string
  timestamp: number
  content: string       // plain text (converted from Tiptap JSON)
  isSystem: boolean
}

type MessageListener = (msg: IncomingMessage) => void

export class RoomClient {
  private ws!: WebSocket
  private pc!: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  private session: RoomSession | null = null
  private listeners: MessageListener[] = []
  private hbTimer: NodeJS.Timeout | null = null
  private centerId = ''

  async join(serverUrl: string, roomKey: string, nickname = 'AI'): Promise<RoomSession> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(serverUrl)

      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({
          type: 'join',
          roomKey: roomKey.toUpperCase(),
          nickname,
          isBot: true,
        }))
      })

      this.ws.on('message', async (raw) => {
        const msg = JSON.parse(raw.toString())

        switch (msg.type) {
          case 'joined': {
            this.session = {
              clientId: msg.clientId,
              nickname,
              roomKey: roomKey.toUpperCase(),
              members: msg.members,
            }
            this.centerId = msg.centerId

            if (msg.clientId !== msg.centerId) {
              await this.initPeer(msg.centerId, true)
            }

            this.startHeartbeat()
            resolve(this.session)
            break
          }

          case 'signal': {
            await this.handleSignal(msg.from, msg.payload)
            break
          }

          case 'member_join': {
            this.session?.members.push(msg.member)
            break
          }

          case 'member_left': {
            if (this.session) {
              this.session.members = this.session.members.filter(
                m => m.clientId !== msg.clientId,
              )
            }
            break
          }
        }
      })

      this.ws.on('error', reject)
    })
  }

  private async initPeer(centerId: string, polite: boolean) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    this.pc.onicecandidate = ({ candidate }: any) => {
      if (candidate) {
        this.ws.send(JSON.stringify({
          type: 'signal',
          roomKey: this.session!.roomKey,
          to: centerId,
          payload: { candidate: candidate.toJSON() },
        }))
      }
    }

    this.pc.ondatachannel = ({ channel }: any) => {
      this.setupChannel(channel)
    }

    if (!polite) {
      const ch = this.pc.createDataChannel('chat')
      this.setupChannel(ch)
    }

    this.pc.onnegotiationneeded = async () => {
      if (!polite) return
      await this.pc.setLocalDescription()
      this.ws.send(JSON.stringify({
        type: 'signal',
        roomKey: this.session!.roomKey,
        to: centerId,
        payload: { sdp: this.pc.localDescription },
      }))
    }
  }

  private setupChannel(ch: RTCDataChannel) {
    this.channel = ch
    ch.onmessage = ({ data }: any) => {
      if (data === '__hb__') { ch.send('__ack__'); return }
      if (data === '__ack__') return
      try {
        const msg = JSON.parse(data)
        if (msg.type === 'chat' || msg.type === 'system') {
          const plain = msg.content.replace(/<[^>]*>/g, '')
          this.listeners.forEach(fn => fn({
            from: msg.from,
            timestamp: msg.timestamp,
            content: plain,
            isSystem: !!msg.isSystem,
          }))
        }
      } catch { /* ignore */ }
    }
  }

  private async handleSignal(fromId: string, payload: any) {
    if (!this.pc) await this.initPeer(fromId, false)

    if (payload.sdp) {
      await this.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp))
      if (payload.sdp.type === 'offer') {
        await this.pc.setLocalDescription()
        this.ws.send(JSON.stringify({
          type: 'signal',
          roomKey: this.session!.roomKey,
          to: fromId,
          payload: { sdp: this.pc.localDescription },
        }))
      }
    }

    if (payload.candidate) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
      } catch { /* stale */ }
    }
  }

  private startHeartbeat() {
    this.hbTimer = setInterval(() => {
      this.ws.send(JSON.stringify({ type: 'heartbeat' }))
    }, HEARTBEAT_MS)
  }

  sendMessage(content: string) {
    if (!this.channel || this.channel.readyState !== 'open') return false
    const msg = {
      id: nanoid(),
      type: 'chat',
      from: this.session!.nickname,
      fromId: this.session!.clientId,
      content: `<p>${content.replace(/\n/g, '</p><p>')}</p>`,
      timestamp: Date.now(),
      roomKey: this.session!.roomKey,
      isBot: true,
    }
    this.channel.send(JSON.stringify(msg))
    return { messageId: msg.id, timestamp: msg.timestamp }
  }

  getMessages(store: IncomingMessage[], limit = 20, since?: number): IncomingMessage[] {
    const filtered = since ? store.filter(m => m.timestamp > since) : store
    return filtered.slice(-limit)
  }

  onMessage(fn: MessageListener) {
    this.listeners.push(fn)
  }

  leave() {
    if (this.hbTimer) clearInterval(this.hbTimer)
    this.channel?.close()
    this.pc?.close()
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'leave', roomKey: this.session?.roomKey }))
      this.ws.close()
    }
    this.session = null
  }

  getSession() { return this.session }
}
