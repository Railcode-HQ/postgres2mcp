import { useState } from 'react'
import { highlightJson, highlightShell } from '@/components/code'
import { CodeBlock } from '@/components/parts'
import { CopyButton } from '@/components/ui/copy-button'
import { useStatusStore } from '@/stores/statusStore'
import { cn } from '@/lib/utils'

const CLIENTS = [
  { id: 'claude', label: 'Claude Code', where: 'Run this in a terminal.' },
  { id: 'cursor', label: 'Cursor', where: 'Add to ~/.cursor/mcp.json, or .cursor/mcp.json in a project.' },
  { id: 'vscode', label: 'VS Code', where: 'Add to .vscode/mcp.json in your workspace.' },
  {
    id: 'desktop',
    label: 'Claude Desktop',
    where: 'Add to claude_desktop_config.json (Settings → Developer → Edit Config). It connects through mcp-remote, which needs Node.js.',
  },
  { id: 'curl', label: 'curl', where: 'Lists the tools this key can call. Any client that speaks streamable HTTP works the same way.' },
] as const

export type ClientId = (typeof CLIENTS)[number]['id']

const RPC = {
  list: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  call: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tables","arguments":{}}}',
}

/**
 * The MCP endpoint clients should use: the public address the server was
 * told about, or else wherever this dashboard is being served from.
 */
export function useMcpEndpoint(): string {
  const publicUrl = useStatusStore((s) => s.status?.public_url)
  return `${publicUrl ?? window.location.origin}/mcp`
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

function snippet(client: ClientId, endpoint: string, token: string, curl: keyof typeof RPC): string {
  const authorization = `Bearer ${token}`
  switch (client) {
    case 'claude':
      return `claude mcp add --transport http postgres ${endpoint} \\\n  --header "Authorization: ${authorization}"`
    case 'cursor':
      return json({ mcpServers: { postgres: { url: endpoint, headers: { Authorization: authorization } } } })
    case 'vscode':
      return json({ servers: { postgres: { type: 'http', url: endpoint, headers: { Authorization: authorization } } } })
    case 'desktop': {
      // mcp-remote refuses plain http anywhere but this machine unless told otherwise.
      const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(endpoint)
      const plainHttp = endpoint.startsWith('http://') && !local
      return json({
        mcpServers: {
          postgres: {
            command: 'npx',
            args: ['-y', 'mcp-remote', endpoint, ...(plainHttp ? ['--allow-http'] : []), '--header', `Authorization: ${authorization}`],
          },
        },
      })
    }
    case 'curl':
      return `curl -s ${endpoint} \\\n  -H "Authorization: ${authorization}" \\\n  -H "Content-Type: application/json" \\\n  -d '${RPC[curl]}'`
  }
}

// How to point an MCP client at this server, ready to paste. Without a real
// token the snippets carry a placeholder. `curl="call"` makes the curl example
// call a tool rather than list them, for the guide that waits for a first call.
export function ConnectSnippet({
  token,
  curl = 'list',
  client: controlled,
  onClientChange,
}: {
  token?: string
  curl?: keyof typeof RPC
  client?: ClientId
  onClientChange?: (client: ClientId) => void
}) {
  const [own, setOwn] = useState<ClientId>('claude')
  const client = controlled ?? own
  const setClient = (next: ClientId) => {
    setOwn(next)
    onClientChange?.(next)
  }
  const endpoint = useMcpEndpoint()
  const text = snippet(client, endpoint, token ?? '<API key>', curl)
  const shell = client === 'claude' || client === 'curl'
  const where =
    client === 'curl' && curl === 'call'
      ? 'Run this in a terminal. It calls list_tables with this key.'
      : CLIENTS.find((option) => option.id === client)!.where

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="inline-flex flex-wrap rounded-md border border-border bg-card p-0.5" role="group" aria-label="Client">
          {CLIENTS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={client === option.id}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                client === option.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setClient(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <CopyButton value={text} label="Copy" />
      </div>
      <CodeBlock className="whitespace-pre overflow-x-auto break-normal">
        {shell ? highlightShell(text) : highlightJson(text)}
      </CodeBlock>
      <p className="text-xs leading-relaxed text-muted-foreground">{where}</p>
    </div>
  )
}
