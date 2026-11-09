import { InputManager } from './input.js';

export class NebulaPlayer {
  constructor() {
    this.videoElement = document.getElementById('remoteVideo');
    this.hudElement = document.getElementById('metricsHud');
    this.statusText = document.getElementById('statusText');
    this.startButton = document.getElementById('startBtn');
    this.stopButton = document.getElementById('stopBtn');

    this.ws = null;
    this.pc = null;
    this.dataChannel = null;
    this.inputManager = null;
    this.sessionId = null;
    this.statsInterval = null;
    this.heartbeatInterval = null;

    this.prevBytesReceived = 0;
    this.prevTimestamp = 0;

    this.init();
  }

  init() {
    this.inputManager = new InputManager(this.videoElement, null);

    this.startButton.addEventListener('click', () => this.startSession());
    this.stopButton.addEventListener('click', () => this.stopSession());

    document.getElementById('lockMouseBtn')?.addEventListener('click', () => {
      this.inputManager.requestPointerLock();
    });

    document.getElementById('fullscreenBtn')?.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.getElementById('playerContainer').requestFullscreen();
      } else {
        document.exitFullscreen();
      }
    });
  }

  setStatus(text, color = '#ffffff') {
    if (this.statusText) {
      this.statusText.textContent = text;
      this.statusText.style.color = color;
    }
  }

  startSession() {
    this.setStatus('Connecting to Signaling Server...', '#facc15');
    this.startButton.disabled = true;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/client`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.setStatus('Requesting GPU Container Instance...', '#38bdf8');
      this.ws.send(JSON.stringify({ type: 'session:request' }));
      this.startHeartbeat();
    };

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      await this.handleSignalingMessage(msg);
    };

    this.ws.onclose = () => {
      this.setStatus('Disconnected', '#94a3b8');
      this.cleanup();
    };

    this.ws.onerror = (err) => {
      console.error('[Signaling] WebSocket error:', err);
      this.setStatus('Signaling Connection Error', '#ef4444');
      this.cleanup();
    };
  }

  async handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'session:provisioning':
        this.sessionId = msg.sessionId;
        this.setStatus(`Spawning GPU Sandbox (${this.sessionId})...`, '#facc15');
        break;

      case 'session:ready':
        this.setStatus('Container Ready. Negotiating WebRTC...', '#38bdf8');
        await this.setupWebRTC();
        break;

      case 'session:failed':
        this.setStatus(`Provisioning Failed: ${msg.error}`, '#ef4444');
        this.cleanup();
        break;

      case 'signal:answer':
        if (this.pc) {
          await this.pc.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: msg.sdp
          }));
          this.setStatus('Connected & Streaming', '#4ade80');
          this.stopButton.disabled = false;
        }
        break;

      case 'signal:candidate':
        if (this.pc && msg.candidate) {
          await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
        break;
    }
  }

  async setupWebRTC() {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // 1. Create WebRTC DataChannel for low-latency UDP-like input events
    this.dataChannel = this.pc.createDataChannel('input', {
      ordered: false,          // Out-of-order delivery for lowest latency
      maxRetransmits: 0        // Zero retransmits (pure UDP packet behavior)
    });

    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.onopen = () => {
      console.log('[WebRTC] Input DataChannel Open');
      this.inputManager.setDataChannel(this.dataChannel);
    };

    // 2. Stream candidate to Signaling
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'signal:candidate',
          sessionId: this.sessionId,
          candidate: event.candidate.toJSON()
        }));
      }
    };

    // 3. Receive Remote Video Track
    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Received remote track:', event.track.kind);
      if (event.streams && event.streams[0]) {
        this.videoElement.srcObject = event.streams[0];
      } else {
        const stream = new MediaStream([event.track]);
        this.videoElement.srcObject = stream;
      }
    };

    // 4. Create and dispatch SDP Offer
    const offer = await this.pc.createOffer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: true
    });

    await this.pc.setLocalDescription(offer);

    this.ws.send(JSON.stringify({
      type: 'signal:offer',
      sessionId: this.sessionId,
      sdp: offer.sdp
    }));

    // Start Live Stats Loop
    this.startMetricsMonitor();
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'heartbeat', sessionId: this.sessionId }));
      }
    }, 5000);
  }

  startMetricsMonitor() {
    this.statsInterval = setInterval(async () => {
      if (!this.pc) return;
      const stats = await this.pc.getStats();
      
      let fps = 0;
      let rtt = 0;
      let bitrate = 0;
      let packetsLost = 0;
      let jitter = 0;
      let width = 0;
      let height = 0;

      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          fps = report.framesPerSecond || 0;
          packetsLost = report.packetsLost || 0;
          jitter = Math.round((report.jitter || 0) * 1000);
          width = report.frameWidth || 0;
          height = report.frameHeight || 0;

          if (this.prevBytesReceived && this.prevTimestamp) {
            const bytesDelta = report.bytesReceived - this.prevBytesReceived;
            const timeDelta = report.timestamp - this.prevTimestamp;
            bitrate = Math.round(((bytesDelta * 8) / (timeDelta / 1000)) / 1000); // kbps
          }
          this.prevBytesReceived = report.bytesReceived;
          this.prevTimestamp = report.timestamp;
        }

        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rtt = Math.round((report.currentRoundTripTime || 0) * 1000);
        }
      });

      this.updateHud({ fps, rtt, bitrate, packetsLost, jitter, width, height });
    }, 1000);
  }

  updateHud({ fps, rtt, bitrate, packetsLost, jitter, width, height }) {
    if (!this.hudElement) return;
    this.hudElement.innerHTML = `
      <div class="hud-item"><span class="hud-label">RTT Latency:</span> <span class="hud-val ${rtt < 50 ? 'good' : 'warn'}">${rtt} ms</span></div>
      <div class="hud-item"><span class="hud-label">Stream FPS:</span> <span class="hud-val">${fps || 60} fps</span></div>
      <div class="hud-item"><span class="hud-label">Bitrate:</span> <span class="hud-val">${(bitrate / 1000).toFixed(2)} Mbps</span></div>
      <div class="hud-item"><span class="hud-label">Resolution:</span> <span class="hud-val">${width ? `${width}x${height}` : '1280x720'}</span></div>
      <div class="hud-item"><span class="hud-label">Jitter / Loss:</span> <span class="hud-val">${jitter}ms / ${packetsLost} pkts</span></div>
    `;
  }

  stopSession() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'session:terminate', sessionId: this.sessionId }));
    }
    this.cleanup();
  }

  cleanup() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.startButton.disabled = false;
    this.stopButton.disabled = true;
  }
}

// Instantiate player upon page load
window.addEventListener('DOMContentLoaded', () => {
  new NebulaPlayer();
});

