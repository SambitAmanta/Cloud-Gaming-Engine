import Redis from 'ioredis';
import { SessionInfo } from './types';
import { ContainerOrchestrator } from './docker';

export class SessionStateManager {
  private redis: Redis | null = null;
  private memorySessions: Map<string, SessionInfo> = new Map();
  private orchestrator: ContainerOrchestrator;
  private reaperInterval: NodeJS.Timeout | null = null;

  constructor(orchestrator: ContainerOrchestrator) {
    this.orchestrator = orchestrator;
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    try {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1
      });

      this.redis.connect().then(() => {
        console.log('[Redis] Connected to Redis cluster for distributed session state.');
      }).catch((err) => {
        console.warn(`[Redis] Redis unreachable at ${redisUrl}. Operating in single-node In-Memory state mode.`);
        this.redis = null;
      });
    } catch {
      this.redis = null;
    }

    // Start background Reaper: scans for dead/abandoned sessions every 5s
    this.startHeartbeatReaper();
  }

  createSession(sessionId: string, clientWs: any): SessionInfo {
    const session: SessionInfo = {
      id: sessionId,
      status: 'provisioning',
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      clientWs
    };

    this.memorySessions.set(sessionId, session);
    if (this.redis) {
      this.redis.set(`session:${sessionId}:status`, 'provisioning', 'EX', 60);
    }

    return session;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.memorySessions.get(sessionId);
  }

  updateHeartbeat(sessionId: string): void {
    const session = this.memorySessions.get(sessionId);
    if (session) {
      session.lastHeartbeat = Date.now();
      if (this.redis) {
        this.redis.expire(`session:${sessionId}:status`, 60);
      }
    }
  }

  setContainerId(sessionId: string, containerId: string): void {
    const session = this.memorySessions.get(sessionId);
    if (session) {
      session.containerId = containerId;
      session.status = 'running';
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    const session = this.memorySessions.get(sessionId);
    if (!session) return;

    console.log(`[SessionManager] Cleaning up session: ${sessionId}`);
    if (session.containerId) {
      await this.orchestrator.terminateSessionContainer(session.containerId);
    }

    this.memorySessions.delete(sessionId);
    if (this.redis) {
      await this.redis.del(`session:${sessionId}:status`);
    }
  }

  private startHeartbeatReaper(): void {
    const TIMEOUT_MS = 15000; // 15 seconds without heartbeat triggers teardown

    this.reaperInterval = setInterval(async () => {
      const now = Date.now();
      for (const [sessionId, session] of this.memorySessions.entries()) {
        if (now - session.lastHeartbeat > TIMEOUT_MS) {
          console.warn(`[Reaper] Session ${sessionId} timed out (no heartbeat for ${((now - session.lastHeartbeat)/1000).toFixed(1)}s). Pruning...`);
          await this.removeSession(sessionId);
        }
      }
    }, 5000);
  }

  destroy(): void {
    if (this.reaperInterval) clearInterval(this.reaperInterval);
    if (this.redis) this.redis.disconnect();
  }
}

