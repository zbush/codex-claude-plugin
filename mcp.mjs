import { createInterface } from 'node:readline';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const protocolVersion = versions[0];

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export function invalidParams(message, reason = 'invalid_params') {
  return new RpcError(-32602, message, { reason });
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function serve({ serverInfo, tools, callTool }) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Map();
  let closed = false;

  function reply(id, payload) {
    if (!closed) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
  }

  async function dispatch(method, params, controller) {
    if (!isObject(params)) throw invalidParams('Expected a params object.');
    switch (method) {
      case 'initialize': {
        if (typeof params.protocolVersion !== 'string' || !isObject(params.capabilities) ||
            !isObject(params.clientInfo) || typeof params.clientInfo.name !== 'string' ||
            typeof params.clientInfo.version !== 'string') throw invalidParams('Invalid initialize parameters.');
        return {
          protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersion,
          capabilities: { tools: {} }, serverInfo,
        };
      }
      case 'ping': return {};
      case 'tools/list': return { tools };
      case 'tools/call': {
        if (typeof params.name !== 'string' || !tools.some(tool => tool.name === params.name)) {
          throw invalidParams('Unknown or missing tool name.');
        }
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isObject(args)) throw invalidParams('Expected a tool arguments object.');
        return callTool(params.name, args, controller);
      }
      default: throw new RpcError(-32601, 'Method not found: ' + method);
    }
  }

  async function receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return reply(null, { error: { code: -32700, message: 'Parse error' } }); }
    const id = message?.id;
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (id !== undefined && typeof id !== 'string' && !Number.isSafeInteger(id))) {
      return reply(null, { error: { code: -32600, message: 'Invalid Request' } });
    }
    if (id === undefined) {
      // Initialized and unrecognized notifications have no response or side effects.
      if (message.method === 'notifications/cancelled') {
        const request = pending.get(message.params?.requestId);
        if (request && request.method !== 'initialize') {
          request.cancelled = true;
          request.controller.abort();
        }
      }
      return;
    }
    if (pending.has(id)) return reply(id, { error: { code: -32600, message: 'Duplicate in-flight request ID' } });
    const request = { method: message.method, controller: new AbortController(), cancelled: false };
    pending.set(id, request);
    try {
      const result = await dispatch(message.method, message.params === undefined ? {} : message.params, request.controller);
      if (!request.cancelled) reply(id, { result });
    } catch (error) {
      if (!request.cancelled) {
        const { code, message, data } = error instanceof RpcError ? error : new RpcError(-32603, 'Internal error');
        reply(id, { error: { code, message, data } });
      }
    } finally {
      pending.delete(id);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const { controller } of pending.values()) controller.abort();
    lines.close();
    process.stdin.destroy();
  }
  lines.on('line', line => { if (!closed) void receive(line); });
  lines.once('close', close);
  process.stdout.once('error', close);
  process.stdin.once('error', close);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
