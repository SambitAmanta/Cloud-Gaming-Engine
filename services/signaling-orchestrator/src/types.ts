export interface SignalMessage {
  type: 
    | 'session:request'
    | 'session:provisioning'
    | 'session:ready'
    | 'session:failed'
    | 'session:terminate'
    | 'signal:offer'
    | 'signal:answer'
    | 'signal:candidate'
    | 'heartbeat';
  sessionId?: string;
  role?: 'client' | 'agent';
  sdp?: string;
  candidate?: any;
  error?: string;
  timestamp?: number;
}

export interface SessionInfo {
  id: string;
  containerId?: string;
  status: 'provisioning' | 'running' | 'terminated';
  createdAt: number;
  lastHeartbeat: number;
  clientWs?: any;
  agentWs?: any;
}

