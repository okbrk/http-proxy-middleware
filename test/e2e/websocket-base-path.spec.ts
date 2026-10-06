import * as http from 'node:http';
import type { Socket } from 'node:net';

import getPort from 'get-port';
import type { Mockttp } from 'mockttp';
import { getLocal } from 'mockttp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { RequestHandler } from '../../src/types.js';
import { createAppWithPath, createProxyMiddleware } from './test-kit.js';

/**
 * https://github.com/chimurai/http-proxy-middleware/issues/978
 *
 * Express strips the mount path from `req.url` for regular requests,
 * but not for WebSocket upgrade requests.
 */
describe('E2E WebSocket proxy mounted on a base path', () => {
  const BASE_PATH = '/a/b/c';

  let proxyServer: http.Server;
  let mockTargetServer: Mockttp;
  let ws: WebSocket | undefined;
  let serverPort: number;
  let sockets: Set<Socket>;

  beforeEach(async () => {
    mockTargetServer = getLocal();
    await mockTargetServer.start();
    await mockTargetServer.forGet('/api/whatever').thenReply(200, 'ok');
    await mockTargetServer.forAnyWebSocket().thenEcho();

    serverPort = await getPort();
    sockets = new Set();
  });

  afterEach(async () => {
    ws?.terminate();
    ws = undefined;

    await Promise.all([
      new Promise<void>((resolve) => {
        if (!proxyServer?.listening) {
          resolve();
          return;
        }
        proxyServer.close(() => resolve());
        // upgrade requests which are not proxied leave their socket open
        sockets.forEach((socket) => socket.destroy());
      }),
      mockTargetServer.stop(),
    ]);
  });

  const startServer = (middleware: RequestHandler) => {
    proxyServer = createAppWithPath(BASE_PATH, middleware).listen(serverPort);
    proxyServer.on('connection', (socket) => sockets.add(socket));
  };

  // need to make a normal http request, so http-proxy-middleware can catch the upgrade request
  const httpGet = (path: string) => {
    return new Promise<void>((resolve, reject) => {
      http
        .get(`http://localhost:${serverPort}${path}`, (res) => {
          res.resume();
          res.once('end', () => resolve());
        })
        .on('error', reject);
    });
  };

  const echoOverWebSocket = (path: string, timeoutMs = 2000) => {
    return new Promise<string>((resolve, reject) => {
      ws = new WebSocket(`ws://localhost:${serverPort}${path}`);

      // an upgrade request which is not proxied is never answered; fail fast instead of hanging
      const timeout = setTimeout(
        () => reject(new Error(`Timed out connecting to ${path}`)),
        timeoutMs,
      );

      ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      ws.once('message', (data) => {
        clearTimeout(timeout);
        resolve(data.toString());
      });
      ws.once('open', () => ws?.send('foobar'));
    });
  };

  it('should call pathFilter function with the path without the base path (issue #978)', async () => {
    const pathFilter = vi.fn(
      (pathname: string) => pathname.startsWith('/api') || pathname.startsWith('/raw-ws'),
    );

    const middleware = createProxyMiddleware({
      target: mockTargetServer.url,
      ws: true,
      pathFilter,
    });
    startServer(middleware);

    await httpGet(`${BASE_PATH}/api/whatever`);
    await expect(echoOverWebSocket(`${BASE_PATH}/raw-ws`)).resolves.toBe('foobar');

    expect(pathFilter.mock.calls.map(([pathname]) => pathname)).toEqual([
      '/api/whatever', // http request
      '/raw-ws', // websocket upgrade request
    ]);
  });

  it('should match a string pathFilter against the path without the base path', async () => {
    const middleware = createProxyMiddleware({
      target: mockTargetServer.url,
      ws: true,
      pathFilter: ['/api', '/raw-ws'],
    });
    startServer(middleware);

    await httpGet(`${BASE_PATH}/api/whatever`);
    await expect(echoOverWebSocket(`${BASE_PATH}/raw-ws?foo=bar`)).resolves.toBe('foobar');
  });

  it('should not proxy upgrade requests the pathFilter does not match', async () => {
    const pathFilter = vi.fn((pathname: string) => pathname.startsWith('/api'));

    const middleware = createProxyMiddleware({
      target: mockTargetServer.url,
      ws: true,
      pathFilter,
    });
    startServer(middleware);

    await httpGet(`${BASE_PATH}/api/whatever`);
    await expect(echoOverWebSocket(`${BASE_PATH}/raw-ws`, 300)).rejects.toThrow('Timed out');

    expect(pathFilter).toHaveBeenCalledWith('/raw-ws', expect.anything());
  });
});
