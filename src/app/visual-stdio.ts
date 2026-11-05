/**
 * A real stdio MCP capture transport: the host starts one local MCP server process and calls its
 * fixed tool over stdin/stdout. Used where no editor endpoint is reachable and by the test suite,
 * which points it at a real MCP screenshot server; it never invents content for a failed call.
 */
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { UnavailableCapture, type CaptureSession } from '../visual-host.ts'

export type StdioCaptureTool = { readonly command: string; readonly args: readonly string[]; readonly cwd?: string }

/** A real MCP server of its own, started by this host and reached over stdio. */
export class McpStdioCaptureSession implements CaptureSession {
  private client: Client | undefined
  private transport: StdioClientTransport | undefined
  constructor(private readonly tool: StdioCaptureTool) {}
  async prepare(): Promise<void> {
    if (this.client) return
    // The capture server is a program of its own: this host's Node loader arguments must not reach it.
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'NODE_OPTIONS') env[name] = value
    const transport = new StdioClientTransport({ command: this.tool.command, args: [...this.tool.args], ...(this.tool.cwd ? { cwd: this.tool.cwd } : {}), env, execArgv: [], stderr: 'ignore' } as never)
    const client = new Client({ name: 'dsh-superagent-visual', version: '0.1.0' })
    try { await client.connect(transport) }
    catch (error) { throw new UnavailableCapture(`Trusted stdio capture tool did not start: ${error instanceof Error ? error.message : String(error)}`) }
    this.client = client
    this.transport = transport
  }
  async call(server: string, tool: string, args: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    await this.prepare()
    void server
    const client = this.client!
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    const result = await client.callTool({ name: tool, arguments: args }, { signal: combined })
    if ((result as CallToolResult & { isError?: unknown }).isError === true) {
      // The tool's own message stays visible, but no content it returned is ever treated as a frame.
      const text = (result as { content?: { type?: string; text?: string }[] }).content?.filter(block => block.type === 'text').map(block => block.text).join(' ')
      throw new Error(`Capture tool reported an error${text ? `: ${text.slice(0, 2000)}` : ''}`)
    }
    return result
  }
  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    if (client) await client.close().catch(() => undefined)
    await this.transport?.close().catch(() => undefined)
    this.transport = undefined
  }
}
