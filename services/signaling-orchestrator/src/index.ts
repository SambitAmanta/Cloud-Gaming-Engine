import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { ContainerOrchestrator } from './docker';
import { SessionStateManager } from './state';
import { SignalingServer } from './signaling';

const app = express();
const server = http.createServer(app);
const port = parseInt(process.env.PORT || '8080', 10);

// Initialize core subsystems
const orchestrator = new ContainerOrchestrator();
const stateManager = new SessionStateManager(orchestrator);

// Initialize WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server });
const signaling = new SignalingServer(wss, stateManager, orchestrator);

// Serve web player frontend
const clientPath = path.resolve(__dirname, '../../client');
app.use(express.static(clientPath));

// API endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'NebulaStream Signaling & Orchestration Gateway' });
});

app.get('/api/stats', async (req, res) => {
  const activeContainers = await orchestrator.getActiveContainerCount();
  res.json({
    activeContainers,
    maxContainers: parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '3', 10)
  });
});

server.listen(port, () => {
  console.log('====================================================');
  console.log(` NebulaStream Gateway listening on http://localhost:${port}`);
  console.log(` Serving Web Player UI from: ${clientPath}`);
  console.log('====================================================');
});

// Handle graceful shutdown
const shutdown = async () => {
  console.log('\n[Gateway] Shutting down server...');
  stateManager.destroy();
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

