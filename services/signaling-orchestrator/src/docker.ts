import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';

export class ContainerOrchestrator {
  private docker: Docker;
  private maxContainers: number;
  private image: string;

  constructor() {
    // Connect to local Docker Engine (socket on Linux/Mac, named pipe on Windows)
    this.docker = new Docker();
    this.maxContainers = parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '3', 10);
    this.image = process.env.RUNNER_IMAGE || 'nebulastream-runner:latest';
  }

  /**
   * Spawns an isolated game container with GPU acceleration
   */
  async spawnSessionContainer(sessionId: string): Promise<string> {
    const activeCount = await this.getActiveContainerCount();
    if (activeCount >= this.maxContainers) {
      throw new Error(
        `GPU VRAM Capacity Reached (${activeCount}/${this.maxContainers} active sessions). Cannot provision session.`
      );
    }

    console.log(`[Orchestrator] Provisioning container for Session: ${sessionId}...`);

    const signalingUrl = process.env.CONTAINER_SIGNALING_URL || 'ws://host.docker.internal:8080/ws/agent';

    try {
      const container = await this.docker.createContainer({
        Image: this.image,
        name: `nebulastream-${sessionId}`,
        Env: [
          `SESSION_ID=${sessionId}`,
          `SIGNALING_URL=${signalingUrl}`,
          `DISPLAY=:99`,
          `RESOLUTION=1280x720`,
          `FPS=60`,
          `BITRATE=3000k`
        ],
        HostConfig: {
          // Pass NVIDIA GPU into container
          DeviceRequests: [
            {
              Driver: 'nvidia',
              Count: -1,
              Capabilities: [['gpu', 'graphics', 'video', 'utility']]
            }
          ],
          // Grant uinput access for kernel virtual input injection
          Devices: [
            {
              PathOnHost: '/dev/uinput',
              PathInContainer: '/dev/uinput',
              CgroupPermissions: 'rwm'
            }
          ],
          CapAdd: ['SYS_ADMIN'],
          NetworkMode: 'host', // For optimal low-latency UDP packet delivery
          AutoRemove: true
        }
      });

      await container.start();
      console.log(`[Orchestrator] Container ${container.id.substring(0, 12)} successfully started.`);
      return container.id;
    } catch (err: any) {
      // In development, if nvidia-docker or /dev/uinput device requests fail, attempt standard launch
      console.warn(`[Orchestrator] Hardware accelerated launch failed (${err.message}). Retrying in dev-fallback mode...`);
      const fallbackContainer = await this.docker.createContainer({
        Image: this.image,
        name: `nebulastream-${sessionId}`,
        Env: [
          `SESSION_ID=${sessionId}`,
          `SIGNALING_URL=${signalingUrl}`,
          `DISPLAY=:99`,
          `RESOLUTION=1280x720`,
          `FPS=60`,
          `BITRATE=2500k`
        ],
        HostConfig: {
          AutoRemove: true
        }
      });

      await fallbackContainer.start();
      console.log(`[Orchestrator] Fallback container ${fallbackContainer.id.substring(0, 12)} started.`);
      return fallbackContainer.id;
    }
  }

  /**
   * Stops and destroys a session container
   */
  async terminateSessionContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 2 });
      console.log(`[Orchestrator] Container ${containerId.substring(0, 12)} stopped.`);
    } catch (err: any) {
      // Ignore if container is already stopped/removed
      if (err.statusCode !== 404 && err.statusCode !== 304) {
        console.error(`[Orchestrator] Failed to stop container ${containerId}:`, err.message);
      }
    }
  }

  /**
   * Counts active running NebulaStream containers
   */
  async getActiveContainerCount(): Promise<number> {
    try {
      const containers = await this.docker.listContainers({
        filters: { name: ['nebulastream-'] }
      });
      return containers.length;
    } catch (err: any) {
      console.warn('[Orchestrator] Unable to query Docker engine directly:', err.message);
      return 0;
    }
  }
}

