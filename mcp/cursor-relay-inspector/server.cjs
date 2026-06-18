const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const proxyModulePath = path.join(rootDir, 'js', 'utils', 'cursor-relay-proxy.js');
const reviewBridgePath = path.join(rootDir, 'js', 'utils', 'cursor-relay-review-bridge.js');
const pathsModulePath = path.join(rootDir, 'paths.js');

const knowledgeResources = {
  'relay://skill/cursor-reverse': {
    name: 'Cursor Reverse Workflow',
    description: 'How to inspect Cursor tool/UI behavior, native mutation fallback, and official review controls.',
    filePath: path.join(rootDir, 'skills', 'cursor_relay_reverse', 'references', 'workflow.md'),
  },
  'relay://skill/cursor-review-bridge': {
    name: 'Cursor Review Bridge',
    description: 'How the project restores official Cursor review UI when relay-rendered diff state needs workbench bridging.',
    filePath: path.join(rootDir, 'skills', 'cursor_relay_reverse', 'references', 'review-bridge.md'),
  },
  'relay://skill/project-proxy': {
    name: 'Project Proxy Architecture',
    description: 'Current hybrid Relay architecture and request flow for this repo.',
    filePath: path.join(rootDir, 'skills', 'project_proxy', 'references', 'architecture.md'),
  },
};

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function clip(text, maxChars = 4000) {
  const value = String(text || '');
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...` : value;
}

function searchKnowledge(query) {
  const needle = String(query || '').trim().toLowerCase();
  const matches = [];
  for (const [uri, item] of Object.entries(knowledgeResources)) {
    const text = readUtf8(item.filePath);
    const haystack = text.toLowerCase();
    if (!needle || haystack.includes(needle)) {
      const lines = text.split(/\r?\n/);
      const hitLines = [];
      lines.forEach((line, index) => {
        if (!needle || line.toLowerCase().includes(needle)) {
          hitLines.push(`${index + 1}: ${line}`);
        }
      });
      matches.push({
        uri,
        name: item.name,
        preview: clip(hitLines.slice(0, 8).join('\n'), 1200),
      });
    }
  }
  return matches;
}

function findSourceAnchor(filePath, needle, before = 2, after = 4) {
  const targetPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
  const text = readUtf8(targetPath);
  const lines = text.split(/\r?\n/);
  const out = [];
  lines.forEach((line, index) => {
    if (line.includes(needle)) {
      const start = Math.max(0, index - before);
      const end = Math.min(lines.length - 1, index + after);
      const snippet = [];
      for (let i = start; i <= end; i += 1) {
        snippet.push(`${i + 1}: ${lines[i]}`);
      }
      out.push({
        line: index + 1,
        snippet: snippet.join('\n'),
      });
    }
  });
  return {
    targetPath,
    matchCount: out.length,
    matches: out.slice(0, 20),
  };
}

function scanCursorPatchStatus(explicitMainJsPath = '') {
  const { resolveMainJsPath } = require(pathsModulePath);
  const { readRelayReviewBridgePatchStatus } = require(reviewBridgePath);
  const mainJsPath = resolveMainJsPath(explicitMainJsPath);
  const status = {
    mainJsPath: mainJsPath || '',
    mainJsExists: false,
    proxyWhitelistPatched: false,
    reviewBridge: {
      exists: false,
      workbenchPath: '',
      reviewBridgePatched: false,
    },
  };
  if (!mainJsPath || !fs.existsSync(mainJsPath)) {
    return status;
  }
  const mainText = readUtf8(mainJsPath);
  status.mainJsExists = true;
  status.proxyWhitelistPatched = ['"proxy-server"', '"proxy-pac-url"', '"no-proxy-server"'].every((needle) => mainText.includes(needle));
  status.reviewBridge = readRelayReviewBridgePatchStatus(mainJsPath);
  return status;
}

function success(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function failure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  process.stdout.write(Buffer.concat([header, body]));
}

function handleRequest(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return success(id, {
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: 'cursor-relay-inspector',
        version: '0.1.0',
      },
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    });
  }

  if (method === 'resources/list') {
    return success(id, {
      resources: Object.entries(knowledgeResources).map(([uri, item]) => ({
        uri,
        name: item.name,
        description: item.description,
        mimeType: 'text/markdown',
      })),
    });
  }

  if (method === 'resources/read') {
    const uri = params?.uri;
    const item = knowledgeResources[uri];
    if (!item) return failure(id, -32602, `Unknown resource: ${uri}`);
    return success(id, {
      contents: [{
        uri,
        mimeType: 'text/markdown',
        text: readUtf8(item.filePath),
      }],
    });
  }

  if (method === 'tools/list') {
    return success(id, {
      tools: [
        {
          name: 'search_project_knowledge',
          description: 'Search the local project skill knowledge files.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
        },
        {
          name: 'read_project_knowledge',
          description: 'Read one of the named project knowledge resources.',
          inputSchema: {
            type: 'object',
            properties: {
              resource: { type: 'string' },
            },
            required: ['resource'],
          },
        },
        {
          name: 'find_source_anchor',
          description: 'Find a text anchor in a repo or installed Cursor source file and return a small snippet.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              needle: { type: 'string' },
              before: { type: 'number' },
              after: { type: 'number' },
            },
            required: ['filePath', 'needle'],
          },
        },
        {
          name: 'scan_cursor_patch_status',
          description: 'Report whether the installed Cursor main.js and workbench files have the proxy and review-bridge patches.',
          inputSchema: {
            type: 'object',
            properties: {
              cursorMainJsPath: { type: 'string' },
            },
          },
        },
      ],
    });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === 'search_project_knowledge') {
      const result = searchKnowledge(args.query);
      return success(id, {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      });
    }

    if (name === 'read_project_knowledge') {
      const uri = String(args.resource || '').trim();
      const item = knowledgeResources[uri];
      if (!item) return failure(id, -32602, `Unknown resource: ${uri}`);
      return success(id, {
        content: [{
          type: 'text',
          text: readUtf8(item.filePath),
        }],
      });
    }

    if (name === 'find_source_anchor') {
      const result = findSourceAnchor(
        String(args.filePath || ''),
        String(args.needle || ''),
        Number(args.before || 2),
        Number(args.after || 4),
      );
      return success(id, {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      });
    }

    if (name === 'scan_cursor_patch_status') {
      const result = scanCursorPatchStatus(String(args.cursorMainJsPath || '').trim());
      return success(id, {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      });
    }

    return failure(id, -32601, `Unknown tool: ${name}`);
  }

  if (method === 'prompts/list') {
    return success(id, {
      prompts: [
        {
          name: 'investigate_review_ui',
          description: 'Guide an agent through debugging why official Cursor Undo / Keep / Review UI is missing.',
        },
        {
          name: 'explain_project_proxy',
          description: 'Summarize the current hybrid Relay architecture and critical files.',
        },
      ],
    });
  }

  if (method === 'prompts/get') {
    const name = params?.name;
    if (name === 'investigate_review_ui') {
      return success(id, {
        description: 'Review UI debugging prompt',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Read the local knowledge resources for Cursor reverse workflow and review bridge.',
              'First determine whether the request should have stayed in Relay or intentionally fallen back to Cursor native mutation execution.',
              'Then inspect the installed Cursor workbench bundle for inlineDiffService, addDecorationsOnlyDiff, and updatePromptBar anchors.',
              'Finally compare that with js/utils/cursor-relay-review-bridge.js and report the smallest missing link.',
            ].join(' '),
          },
        }],
      });
    }
    if (name === 'explain_project_proxy') {
      return success(id, {
        description: 'Project proxy architecture prompt',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Read the local project proxy architecture resource.',
              'Explain the current hybrid Relay path, where Cursor traffic is intercepted, which requests stay in Relay, which mutation requests fall back to Cursor native execution, and which files control transport, settings patching, diagnostics, and review UI bridging.',
            ].join(' '),
          },
        }],
      });
    }
    return failure(id, -32602, `Unknown prompt: ${name}`);
  }

  if (method === 'ping') {
    return success(id, {});
  }

  return failure(id, -32601, `Unknown method: ${method}`);
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const headerText = buffer.subarray(0, headerEnd).toString('utf8');
    const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      buffer = Buffer.alloc(0);
      return;
    }
    const contentLength = Number(lengthMatch[1]);
    const frameLength = headerEnd + 4 + contentLength;
    if (buffer.length < frameLength) return;
    const body = buffer.subarray(headerEnd + 4, frameLength).toString('utf8');
    buffer = buffer.subarray(frameLength);
    let message = null;
    try {
      message = JSON.parse(body);
    } catch (error) {
      writeMessage(failure(null, -32700, error.message || 'Invalid JSON'));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      writeMessage(handleRequest(message));
    }
  }
});
