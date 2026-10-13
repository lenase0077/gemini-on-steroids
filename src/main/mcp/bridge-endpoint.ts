import type { SurfaceId } from './surfaces.js';

/** The currently admitted local MCP endpoint, published by the connection owner. */
let urls: Partial<Record<SurfaceId, string>> | null = null;
let localBridgeToken: string | null = null;

export function publishBridgeMcpEndpoint(next: Partial<Record<SurfaceId, string>> | null): void {
  urls = next ? { ...next } : null;
}

export function bridgeMcpEndpointUrl(surface: SurfaceId): string | null {
  return urls?.[surface] ?? null;
}

export function bridgeMcpEndpointUrls(): Partial<Record<SurfaceId, string>> | null {
  return urls ? { ...urls } : null;
}

/** The server-owned credential used only between the paired bridge and local MCP server. */
export function publishLocalBridgeToken(token: string | null): void {
  localBridgeToken = token;
}

export function localBridgeHeaders(): Record<string, string> {
  return localBridgeToken ? { 'x-local-mcp-bridge': localBridgeToken } : {};
}
