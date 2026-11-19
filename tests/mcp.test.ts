import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
    ALLOWED_COMMANDS,
    createMcpServer,
    defaultMcpTools,
    installMcp,
    listMcpProviders,
    MCP_ENTRY_NAME,
    MCP_PROTOCOL_VERSION,
    MCP_SERVER_NAME,
    renderSkill,
} from '@deltabox/toolchain/mcp';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-mcp-'));
    dirs.push(dir);
    return dir;
}

function readJson(file: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('MCP installer', () => {
    it('lists every builtin provider plus the custom directory', () => {
        const ids = listMcpProviders().map(provider => provider.id);
        expect(ids).toEqual(['claude', 'codex', 'vscode', 'opencode', 'pi', 'custom']);
    });

    it('writes a Claude project config and skill idempotently', () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, '.mcp.json'), '{"mcpServers":{"other":{"command":"x"}}}');
        const result = installMcp({ provider: 'claude', cwd });
        expect(result.configPath).toBe(path.join(cwd, '.mcp.json'));
        expect(result.skillPath).toBe(path.join(cwd, '.claude', 'skills', 'deltabox', 'SKILL.md'));
        const config = readJson(result.configPath);
        expect(config.mcpServers.other).toEqual({ command: 'x' });
        expect(config.mcpServers[MCP_ENTRY_NAME]).toEqual({
            command: 'dbx',
            args: ['mcp:serve'],
        });
        expect(fs.readFileSync(result.skillPath!, 'utf8')).toContain('# deltabox toolchain');

        installMcp({ provider: 'claude', cwd, command: 'node', args: ['dbx.js'] });
        expect(readJson(result.configPath).mcpServers[MCP_ENTRY_NAME]).toEqual({
            command: 'node',
            args: ['dbx.js'],
        });
    });

    it('uses the VS Code `servers` dialect and Copilot instructions', () => {
        const cwd = tempDir();
        const result = installMcp({ provider: 'vscode', cwd });
        expect(result.configPath).toBe(path.join(cwd, '.vscode', 'mcp.json'));
        expect(readJson(result.configPath).servers[MCP_ENTRY_NAME]).toEqual({
            type: 'stdio',
            command: 'dbx',
            args: ['mcp:serve'],
        });
        expect(result.skillPath).toBe(
            path.join(cwd, '.github', 'instructions', 'deltabox.instructions.md')
        );
    });

    it('uses the OpenCode local-server dialect', () => {
        const cwd = tempDir();
        const result = installMcp({ provider: 'opencode', cwd });
        expect(readJson(result.configPath).mcp[MCP_ENTRY_NAME]).toEqual({
            type: 'local',
            command: ['dbx', 'mcp:serve'],
            enabled: true,
        });
    });

    it('writes Codex TOML without dropping unrelated sections', () => {
        const cwd = tempDir();
        fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.codex', 'config.toml'), '[other]\nkey = 1\n');
        installMcp({ provider: 'codex', cwd });
        const toml = fs.readFileSync(path.join(cwd, '.codex', 'config.toml'), 'utf8');
        expect(toml).toContain('[other]');
        expect(toml).toContain('key = 1');
        expect(toml).toContain('[mcp_servers.deltabox]');
        expect(toml).toContain('command = "dbx"');
    });

    it('requires a directory for the custom provider', () => {
        expect(() => installMcp({ provider: 'custom', cwd: tempDir() })).toThrow(/requires a `dir`/);
        const dir = tempDir();
        const result = installMcp({ provider: 'custom', cwd: tempDir(), dir });
        expect(result.configPath).toBe(path.join(dir, 'mcp.json'));
        expect(readJson(result.configPath).mcpServers[MCP_ENTRY_NAME]).toBeDefined();
        expect(fs.existsSync(path.join(dir, 'deltabox', 'SKILL.md'))).toBe(true);
    });

    it('refuses to overwrite an unreadable or non-object config', () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, '.mcp.json'), 'not json');
        expect(() => installMcp({ provider: 'claude', cwd })).toThrow(/cannot parse/);
        fs.writeFileSync(path.join(cwd, '.mcp.json'), '[]');
        expect(() => installMcp({ provider: 'claude', cwd })).toThrow(/does not contain a JSON object/);
    });

    it('keeps an edited skill when `force: false` and can skip skills', () => {
        const cwd = tempDir();
        const first = installMcp({ provider: 'claude', cwd });
        fs.writeFileSync(first.skillPath!, 'custom skill');
        installMcp({ provider: 'claude', cwd, force: false });
        expect(fs.readFileSync(first.skillPath!, 'utf8')).toBe('custom skill');

        const skipped = installMcp({ provider: 'claude', cwd: tempDir(), skills: false });
        expect(skipped.skillPath).toBeUndefined();
        expect(fs.existsSync(path.join(cwd, '.claude', 'skills'))).toBe(true);
    });

    it('renders the provider-specific skill text', () => {
        expect(renderSkill('claude')).toContain('Installed for: claude.');
        expect(renderSkill('vscode')).toContain('Installed for: vscode.');
    });
});

describe('MCP protocol server', () => {
    const server = () =>
        createMcpServer({
            cwd: process.cwd(),
            version: '9.9.9',
            tools: [
                {
                    name: 'echo',
                    description: 'Echo the input.',
                    inputSchema: {
                        type: 'object',
                        properties: { text: { type: 'string' } },
                        required: ['text'],
                    },
                    handler: async args => ({
                        content: [{ type: 'text', text: String(args.text) }],
                    }),
                },
                {
                    name: 'fail',
                    description: 'Always fails.',
                    inputSchema: { type: 'object', properties: {} },
                    handler: async () => {
                        throw new Error('boom');
                    },
                },
            ],
        });

    it('answers initialize and ping', async () => {
        const response = await server().handle({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
        });
        expect(response).toMatchObject({
            jsonrpc: '2.0',
            id: 1,
            result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: { name: MCP_SERVER_NAME, version: '9.9.9' },
            },
        });
        expect(await server().handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({
            jsonrpc: '2.0',
            id: 2,
            result: {},
        });
    });

    it('lists tools and calls them', async () => {
        const listed = await server().handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
        expect(listed).toMatchObject({
            result: { tools: [{ name: 'echo' }, { name: 'fail' }] },
        });
        const called = await server().handle({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'hi' } },
        });
        expect(called).toMatchObject({
            result: { content: [{ type: 'text', text: 'hi' }] },
        });
        expect((called as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    });

    it('turns a thrown handler into an error result', async () => {
        const response = await server().handle({
            jsonrpc: '2.0',
            id: 5,
            method: 'tools/call',
            params: { name: 'fail' },
        });
        expect(response).toMatchObject({
            result: { isError: true, content: [{ type: 'text', text: 'boom' }] },
        });
    });

    it('rejects unknown methods, tools and bad parameters', async () => {
        const unknownMethod = await server().handle({
            jsonrpc: '2.0',
            id: 6,
            method: 'nope',
        });
        expect(unknownMethod).toMatchObject({ error: { code: -32601 } });
        const unknownTool = await server().handle({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'missing' },
        });
        expect(unknownTool).toMatchObject({ error: { code: -32602 } });
        const noName = await server().handle({
            jsonrpc: '2.0',
            id: 8,
            method: 'tools/call',
            params: {},
        });
        expect(noName).toMatchObject({ error: { code: -32602 } });
    });

    it('does not answer notifications', async () => {
        expect(
            await server().handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
        ).toBeUndefined();
    });
});

describe('MCP tool catalog', () => {
    it('exposes the documented tools with JSON schemas', () => {
        const tools = defaultMcpTools();
        const names = tools.map(tool => tool.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'dbx_sync',
                'dbx_projects',
                'dbx_providers',
                'dbx_templates',
                'dbx_template_info',
                'dbx_changelog',
                'dbx_migrate',
                'dbx_project_config',
                'dbx_tsconfig',
                'dbx_workflow',
                'dbx_run',
            ])
        );
        for (const tool of tools) {
            expect(tool.inputSchema.type).toBe('object');
            expect(tool.description.length).toBeGreaterThan(10);
        }
    });

    it('keeps the run allowlist free of interactive commands', () => {
        expect(ALLOWED_COMMANDS.has('sync')).toBe(true);
        expect(ALLOWED_COMMANDS.has('template:list')).toBe(true);
        expect(ALLOWED_COMMANDS.has('mcp:serve')).toBe(false);
        expect(ALLOWED_COMMANDS.has('vite:dev')).toBe(false);
    });

    it('rejects a disallowed dbx_run command before spawning anything', async () => {
        const run = defaultMcpTools().find(tool => tool.name === 'dbx_run')!;
        const result = await run.handler({ args: ['rm', '-rf', '.'] }, { cwd: tempDir() });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('is not allowed');
    });
});
