import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { parse } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { SignalMessage, SessionInfo } from './types';
import { SessionStateManager } from './state';
import { ContainerOrchestrator } from './docker';

export class SignalingServer {
  private wss: WebSocketServer;
  private stateManager: SessionStateManager;
  private orchestrator: ContainerOrchestrator;

  constructor(wss: WebSocketServer, stateManager: SessionStateManager, orchestrator: ContainerOrchestrator) {
    this.wss = wss;
    this.stateManager = stateManager;
    this.orchestrator = orchestrator;
    this.init();
  }

  private init(): void {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const { pathname, query } = parse(req.url || '', true);

      if (pathname === '/ws/agent') {
        const sessionId = query.sessionId as string;
        this.handleAgentConnection(ws, sessionId);
      } else {
        this.handleClientConnection(ws);
      }
    });
  }

  /**
   * Handles In-Container Pion WebRTC Agent WebSocket connection
   */
  private handleAgentConnection(agentWs: WebSocket, sessionId: string): void {
    if (!sessionId) {
      agentWs.close(1008, 'Missing sessionId');
      return;
    }

    console.log(`[Signaling] Container Agent connected for Session: ${sessionId}`);
    const session = this.stateManager.getSession(sessionId);

    if (session) {
      session.agentWs = agentWs;
      // Notify client that container is ready to begin SDP handshake
      if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
        this.send(session.clientWs, { type: 'session:ready', sessionId });
      }
    }

    agentWs.on('message', (data: string) => {
      try {
        const msg: SignalMessage = JSON.parse(data.toString());
        this.routeAgentMessage(sessionId, msg);
      } catch (err: any) {
        console.error('[Signaling] Failed to parse agent message:', err.message);
      }
    });

    agentWs.on('close', () => {
      console.log(`[Signaling] Agent disconnected for Session: ${sessionId}`);
      const s = this.stateManager.getSession(sessionId);
      if (s) s.agentWs = undefined;
    });
  }

  /**
   * Handles Browser Client WebSocket connection
   */
  private handleClientConnection(clientWs: WebSocket): void {
    let currentSessionId: string | null = null;
    console.log('[Signaling] New Client browser connected');

    clientWs.on('message', async (data: string) => {
      try {
        const msg: SignalMessage = JSON.parse(data.toString());

        switch (msg.type) {
          case 'session:request': {
            const sessionId = `sess-${uuidv4().substring(0, 8)}`;
            currentSessionId = sessionId;

            const session = this.stateManager.createSession(sessionId, clientWs);
            this.send(clientWs, { type: 'session:provisioning', sessionId });

            try {
              const containerId = await this.orchestrator.spawnSessionContainer(sessionId);
              this.stateManager.setContainerId(sessionId, containerId);
            } catch (err: any) {
              console.error(`[Signaling] Provisioning failed for ${sessionId}:`, err.message);
              this.send(clientWs, { type: 'session:failed', sessionId, error: err.message });
              await this.stateManager.removeSession(sessionId);
            }
            break;
          }

          case 'heartbeat':
            if (currentSessionId) {
              this.stateManager.updateHeartbeat(currentSessionId);
            }
            break;

          case 'signal:offer':
          case 'signal:candidate': {
            const sId = msg.sessionId || currentSessionId;
            if (!sId) return;
            const session = this.stateManager.getSession(sId);
            if (session?.agentWs && session.agentWs.readyState === WebSocket.OPEN) {
              this.send(session.agentWs, msg);
            }
            break;
          }

          case 'session:terminate':
            if (currentSessionId) {
              await this.stateManager.removeSession(currentSessionId);
              currentSessionId = null;
            }
            break;
        }
      } catch (err: any) {
        console.error('[Signaling] Failed to parse client message:', err.message);
      }
    });

    clientWs.on('close', async () => {
      if (currentSessionId) {
        console.log(`[Signaling] Client disconnected. Triggering teardown for session: ${currentSessionId}`);
        await this.stateManager.removeSession(currentSessionId);
      }
    });
  }

  /**
   * Routes messages received from Container Agent -> Client
   */
  private routeAgentMessage(sessionId: string, msg: SignalMessage): void {
    const session = this.stateManager.getSession(sessionId);
    if (!session?.clientWs || session.clientWs.readyState !== WebSocket.OPEN) {
      return;
    }

    switch (msg.type) {
      case 'signal:answer':
      case 'signal:candidate':
        this.send(session.clientWs, msg);
        break;
    }
  }

  private send(ws: WebSocket, msg: SignalMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

