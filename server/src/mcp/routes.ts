// MCP-Transport unter /api/mcp.
//
// Stateless Streamable HTTP: pro Request wird ein frischer McpServer mit
// dem aufgeloesten API-Key-Kontext erzeugt. Das vermeidet Session-State
// im Prozess und passt zu Agenten, die jeden Request unabhaengig senden.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { config } from '../config/config.js'
import { agentenRateLimit } from '../auth/rate-limit.js'
import { createMcpServer } from './server.js'
import type { NotificationGateway } from '../services/notification-gateway.js'

export async function mcpRoutes(
  app: FastifyInstance,
  gateway: NotificationGateway,
): Promise<void> {
  if (!config.MCP_ENABLED) return

  const limit = agentenRateLimit(app)

  app.post(
    config.MCP_PATH,
    { preHandler: [app.requireApiAuth, limit] },
    async (req, reply) => {
      const auth = req.apiAuth
      if (!auth) {
        return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'API-Key fehlt' })
      }

      reply.hijack()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })
      const server = createMcpServer(auth, gateway)

      const schliessen = () => {
        void transport.close().catch(() => undefined)
        void server.close().catch(() => undefined)
      }
      reply.raw.on('close', schliessen)

      try {
        await server.connect(transport)
        await transport.handleRequest(req.raw, reply.raw, req.body)
      } catch (err) {
        req.log.error({ err }, 'mcp_request_failed')
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' })
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          )
        } else {
          reply.raw.end()
        }
      }
    },
  )

  // Stateless mode has no standalone SSE stream and therefore no GET/DELETE.
  const methodeNichtErlaubt = async (
    _req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode.' },
      id: null,
    })
  }

  app.get(config.MCP_PATH, methodeNichtErlaubt)
  app.delete(config.MCP_PATH, methodeNichtErlaubt)
}
