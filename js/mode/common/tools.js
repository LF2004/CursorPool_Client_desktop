const fs = require('fs');
const { getCursorModeFilePath, normalizeAgentModeName } = require('../registry');

const SUPPORTED_MODE_TOOL_NAMES = new Set([
  'Read',
  'Grep',
  'Write',
  'StrReplace',
  'Delete',
  'Glob',
  'LS',
  'Shell',
  'ReadLints',
  'TodoWrite',
  'WebSearch',
  'WebFetch',
  'SemanticSearch',
  'AskQuestion',
  'CreatePlan',
  'Task',
  'SwitchMode',
]);

function loadAgentModeToolDefinitionsForChat(modeName = 'AGENT_MODE_AGENT') {
  try {
    const parsed = JSON.parse(fs.readFileSync(getCursorModeFilePath(modeName, 'tools.json'), 'utf8').replace(/^\uFEFF/, ''));
    return (Array.isArray(parsed) ? parsed : [])
      .filter((tool) => tool?.type === 'function' && SUPPORTED_MODE_TOOL_NAMES.has(String(tool.function?.name || '')))
      .map((tool) => ({
        type: 'function',
        function: {
          name: String(tool.function.name),
          description: String(tool.function.description || ''),
          parameters: tool.function.parameters && typeof tool.function.parameters === 'object'
            ? tool.function.parameters
            : { type: 'object', properties: {} },
        },
      }));
  } catch {
    return [];
  }
}

function enhanceRelayToolDefinition(tool) {
  const name = String(tool?.function?.name || '');
  const clone = {
    type: 'function',
    function: {
      name,
      description: String(tool?.function?.description || ''),
      parameters: tool?.function?.parameters && typeof tool.function.parameters === 'object'
        ? tool.function.parameters
        : { type: 'object', properties: {} },
    },
  };
  if (name === 'Write') {
    clone.function.description = `${clone.function.description}\n\nUse mainly for new files or true full-file rewrites. For modifying existing files, prefer PatchEdit or StrReplace with exact old_string/new_string.`;
  } else if (name === 'StrReplace') {
    clone.function.description = `${clone.function.description}\n\nPrefer this over full-file Write when an exact old_string can be identified. Set new_string to an empty string to delete the exact old_string.`;
  } else if (name === 'PatchEdit') {
    clone.function.description = `${clone.function.description}\n\nSet new_string to an empty string to delete the exact old_string.`;
  }
  return clone;
}

function mergeAgentModeToolDefinitions(fallbackTools = [], modeName = 'AGENT_MODE_AGENT') {
  const normalizedMode = normalizeAgentModeName(modeName);
  const merged = new Map();
  fallbackTools.forEach((tool) => {
    const name = String(tool?.function?.name || '');
    if (name) merged.set(name, enhanceRelayToolDefinition(tool));
  });
  loadAgentModeToolDefinitionsForChat(normalizedMode).forEach((tool) => {
    const name = String(tool?.function?.name || '');
    if (name) merged.set(name, enhanceRelayToolDefinition(tool));
  });
  return Array.from(merged.values());
}

function filterToolDefinitionsByName(tools = [], allowedNames = []) {
  const allow = new Set((Array.isArray(allowedNames) ? allowedNames : []).map((name) => String(name || '').trim()).filter(Boolean));
  if (!allow.size) return Array.isArray(tools) ? tools : [];
  return (Array.isArray(tools) ? tools : []).filter((tool) => allow.has(String(tool?.function?.name || tool?.name || '')));
}

function buildToolDefinitionsForResponses(chatTools = []) {
  return (Array.isArray(chatTools) ? chatTools : []).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function buildFallbackRelayToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a local file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            limit: { type: 'integer' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Grep',
        description: 'Search file contents under a path using ripgrep.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
            glob: { type: 'string' },
            output_mode: { type: 'string', enum: ['content', 'files_with_matches'] },
            head_limit: { type: 'integer' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Write',
        description: 'Write the full contents of a local file. Use this mainly for new files or full-file rewrites. For modifying an existing file, prefer PatchEdit or StrReplace with exact old_string/new_string.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            contents: { type: 'string' },
          },
          required: ['path', 'contents'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'PatchEdit',
        description: 'Edit an existing local file by replacing exact old_string with new_string. Set new_string to an empty string to delete the exact old_string. Prefer this for page beautification and normal edits because it is faster and produces smaller native review diffs than full-file Write.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Edit',
        description: 'Replace a local file with the full updated contents. Prefer PatchEdit when you can identify an exact old_string.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            contents: { type: 'string' },
          },
          required: ['path', 'contents'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'StrReplace',
        description: 'Replace exact text in an existing local file. Set new_string to an empty string to delete the exact old_string. Prefer this over full-file Write when an exact old_string can be identified.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Delete',
        description: 'Delete a local file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Glob',
        description: 'Find files by glob pattern.',
        parameters: {
          type: 'object',
          properties: {
            target_directory: { type: 'string' },
            glob_pattern: { type: 'string' },
            path: { type: 'string' },
            pattern: { type: 'string' },
          },
          required: ['glob_pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'LS',
        description: 'List files and directories under a local path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            ignore: { type: 'array', items: { type: 'string' } },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ReadLints',
        description: 'Read diagnostics or lint results for one or more local files after edits.',
        parameters: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' } },
          },
          required: ['paths'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Shell',
        description: 'Run a PowerShell command for verification, package scripts, git, dev servers, and other terminal operations. Use block_until_ms: 0 for background processes and read the returned terminal log path to monitor output.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            working_directory: { type: 'string' },
            timeout_ms: { type: 'integer' },
            block_until_ms: { type: 'integer' },
            description: { type: 'string' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'TodoWrite',
        description: 'Create or update a structured todo list for complex multi-step coding tasks. Use one in_progress item at a time and mark items completed as soon as they are finished.',
        parameters: {
          type: 'object',
          properties: {
            merge: { type: 'boolean' },
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  content: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
                },
                required: ['id', 'content', 'status'],
              },
              minItems: 1,
            },
          },
          required: ['todos', 'merge'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'WebFetch',
        description: 'Fetch content from a specified URL and return its contents in a readable markdown format. Use this for public webpages, not binary files or private/local URLs.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The fully-qualified URL to fetch.' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'WebSearch',
        description: 'Search the web for real-time information. Returns summarized search results and relevant URLs.',
        parameters: {
          type: 'object',
          properties: {
            search_term: { type: 'string', description: 'The search query.' },
            explanation: { type: 'string', description: 'Why this search is useful.' },
          },
          required: ['search_term'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'SemanticSearch',
        description: 'Search the local codebase by meaning and return likely relevant files and snippets.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            target_directories: { type: 'array', items: { type: 'string' } },
          },
          required: ['query', 'target_directories'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'AskQuestion',
        description: 'Ask the user one or more structured multiple-choice clarification questions.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            questions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  prompt: { type: 'string' },
                  allow_multiple: { type: 'boolean' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        label: { type: 'string' },
                      },
                      required: ['id', 'label'],
                    },
                  },
                },
                required: ['id', 'prompt', 'options'],
              },
            },
          },
          required: ['questions'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'CreatePlan',
        description: 'Create a concise markdown plan with overview and todos for the user to confirm before execution.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            overview: { type: 'string' },
            plan: { type: 'string' },
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  content: { type: 'string' },
                },
                required: ['id', 'content'],
              },
            },
          },
          required: ['plan'],
        },
      },
    },
  ];
}

module.exports = {
  SUPPORTED_MODE_TOOL_NAMES,
  buildFallbackRelayToolDefinitions,
  filterToolDefinitionsByName,
  buildToolDefinitionsForResponses,
  loadAgentModeToolDefinitionsForChat,
  enhanceRelayToolDefinition,
  mergeAgentModeToolDefinitions,
};
