import { generateEphemeralNodeId } from './crypto.js';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

export class P2PMesh {
  constructor({ onMessage, onPeerState }) {
    this.nodeId = generateEphemeralNodeId();
    this.onMessage = onMessage;
    this.onPeerState = onPeerState;
    this.peers = new Map();
  }

  getPeerIds() {
    return [...this.peers.keys()];
  }

  async createInvite() {
    const peerId = generateEphemeralNodeId();
    const conn = this.#createConnection(peerId, true);
    const offer = await conn.pc.createOffer();
    await conn.pc.setLocalDescription(offer);
    await this.#waitIceGathering(conn.pc);
    return JSON.stringify({
      type: 'offer',
      from: this.nodeId,
      to: peerId,
      sdp: conn.pc.localDescription
    });
  }

  async acceptPayload(rawPayload) {
    const payload = JSON.parse(rawPayload);

    if (payload.type === 'offer') {
      const conn = this.#createConnection(payload.from, false);
      await conn.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer = await conn.pc.createAnswer();
      await conn.pc.setLocalDescription(answer);
      await this.#waitIceGathering(conn.pc);
      return JSON.stringify({
        type: 'answer',
        from: this.nodeId,
        to: payload.from,
        sdp: conn.pc.localDescription
      });
    }

    if (payload.type === 'answer') {
      const conn = this.peers.get(payload.from) || this.peers.get(payload.to);
      if (!conn) throw new Error('Unknown peer for answer payload');
      await conn.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      return null;
    }

    throw new Error('Unsupported payload type');
  }

  broadcast(data, selectPeerIds = null) {
    const targets = selectPeerIds || this.getPeerIds();
    for (const id of targets) {
      const conn = this.peers.get(id);
      if (conn?.dc?.readyState === 'open') {
        conn.dc.send(JSON.stringify(data));
      }
    }
  }

  #createConnection(peerId, initiator) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const conn = { pc, dc: null, peerId };

    const bindChannel = (channel) => {
      conn.dc = channel;
      channel.onopen = () => this.onPeerState(this.getPeerIds());
      channel.onclose = () => this.onPeerState(this.getPeerIds());
      channel.onmessage = (evt) => {
        try {
          this.onMessage(JSON.parse(evt.data), peerId);
        } catch {
          // Drop malformed packet
        }
      };
    };

    if (initiator) {
      bindChannel(pc.createDataChannel('meshforum'));
    } else {
      pc.ondatachannel = (evt) => bindChannel(evt.channel);
    }

    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this.peers.delete(peerId);
      }
      this.onPeerState(this.getPeerIds());
    };

    this.peers.set(peerId, conn);
    this.onPeerState(this.getPeerIds());
    return conn;
  }

  async #waitIceGathering(pc) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve) => {
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', onChange);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }
}
