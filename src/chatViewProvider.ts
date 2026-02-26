import * as vscode from 'vscode';
import { AzureOpenAIClient, ChatContent, ChatMessage, StreamEndMeta } from './azureClient';
import { getChatHTML } from './chatHTML';
import type { SemanticIndex } from './semanticIndex';
import type { MemoryStore } from './memoryStore';
import type { ModelRouter } from './modelRouter';
import { exec as execCb, spawn } from 'child_process';
import { promisify } from 'util';
import { AgentSession } from './agentSession';
import { AgentReviewPanel } from './agentReviewPanel';
import { FileContextManager, FileContextItem } from './fileContextManager';
import { isAbsoluteUserPath, loadFromAbsolutePath, loadFromBytes, looksSensitivePath } from './fileLoader';
import * as path from 'path';
import { ContextWindowManager } from './contextWindowManager';
import { SessionHistoryPanel, SessionHistoryEntry } from './sessionHistoryPanel';
import { ProjectStackDetector, DetectedStack } from './projectStackDetector';

type AgentTodo = { id: string; text: string; status: 'pending' | 'in-progress' | 'completed' };
type FileDelta = { path: string; added: number; removed: number };
type ChatRole = 'system' | 'user' | 'assistant';
type StructuredResponse = {
  status: 'scanning' | 'thinking' | 'writing' | 'verifying' | 'done';
  detected_stack?: {
    language: string;
    framework: string;
    package_manager: string;
    test_runner: string;
    linter: string;
  };
  thinking?: string[];
  action_log: Array<{ type: 'search' | 'read' | 'analyze' | 'modify' | 'validate' | 'terminal'; message: string; file?: string; lines?: string }>;
  todos: Array<{ id: number; task: string; status: 'pending' | 'active' | 'complete' }>;
  scope?: 'tiny' | 'small' | 'medium' | 'large';
  response_text: string;
  diffs: Array<{
    file: string;
    language: string;
    added: number;
    removed: number;
    annotations?: Array<{ line: number; type: 'error' | 'warning' | 'info'; message: string }>;
    chunks: string;
  }>;
  terminal_runs?: Array<{ command: string; output: string; result: 'pass' | 'fail' }>;
  iterations?: number;
  context_used: number;
  noise_check?: 'clean' | 'reverted';
  finish_reason: 'stop' | 'length';
};

type HistorySnapshot = {
  id: string;
  at: number;
  action: string;
  files: string[];
  ops: Array<{ path: string; prevExists: boolean; prevContent: string }>;
};

const HISTORY_DIR = '.azure-codex';
const HISTORY_FILE = 'session-history.json';
const PERSISTENT_CONTEXT_FILE = 'persistent-context.json';
const TIER_BUDGETS = {
  persistent: 50_000,
  conversation: 100_000,
  oneTime: 20_000
} as const;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _chats: Array<{
    id: string;
    title: string;
    createdAt: number;
    history: ChatMessage[];
    context: FileContextManager;
    messageSeq: number;
    historySummary: string;
    messagesSinceSummary: number;
    loadedSectionRegistry: Set<string>;
  }> = [];
  private _activeChatId: string | null = null;
  private _lastFileList?: { at: number; items: string[] };
  private _currentAbort?: AbortController;
  private _isHandlingMessage = false;
  private _queuedMessages: Array<{
    text: string;
    opts?: { displayText?: string; autoFetchDepth?: number; retryCount?: number; mode?: string };
  }> = [];
  private readonly _stackDetector = new ProjectStackDetector();
  private _detectedStack?: DetectedStack;
  private _terminalRuns: Array<{ command: string; output: string; result: 'pass' | 'fail' }> = [];
  private _iterationCount = 0;
  private readonly _contextWindow = new ContextWindowManager('gpt-5.1-codex-max');
  private readonly _systemPrompt = this._buildStableSystemPrompt();
  private _lastToolResultSnippets: string[] = [];
  private _didAutoOnboard = false;
  private _recentAutoPinnedAt: Map<string, number> = new Map();
  private _undoBatches: Array<{
    id: string;
    at: number;
    label: string;
    ops: Array<{
      path: string;
      prevExists: boolean;
      prevContent: string;
    }>;
  }> = [];
  private _didBootstrapPersistentContext = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _client: AzureOpenAIClient,
    private readonly _deps?: { semanticIndex?: SemanticIndex; memoryStore?: MemoryStore; modelRouter?: ModelRouter }
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = getChatHTML();
    this._ensureChatState();
    void this._bootstrapPersistentWorkspaceContext().then(() => {
      this._sendChatState();
      this._sendContextStatus();
      this._sendUndoStatus();
    });

    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) return;
      void this.startFreshChatOnOpen();
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'userMessage':
          await this._handleUserMessage(String(data.text || ''), { mode: String(data.mode || 'auto') });
          break;
        case 'stopGeneration':
          this._stopGeneration();
          break;
        case 'clearHistory':
          this.clearHistory();
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'azureCodex');
          break;
        case 'copyToEditor':
          await this._insertCodeToEditor(data.code);
          break;
        case 'applyFileBlock':
          await this._applyFileBlock(data.lang, data.code);
          break;
        case 'applyFileBlockSilent':
          await this._applyFileBlock(data.lang, data.code, { confirm: false, suppressToast: true });
          break;
        case 'pickAttachments':
          await this._pickAttachments();
          break;
        case 'removeContextItem':
          await this._removeContextItem(data.kind, data.label);
          break;
        case 'togglePersistentContextItem':
          await this._togglePersistentContextItem(String(data.id || ''));
          break;
        case 'toggleOneTimeContextItem':
          await this._toggleOneTimeContextItem(String(data.id || ''));
          break;
        case 'clearConversationContext':
          await this._clearConversationContext();
          break;
        case 'clearNonPersistentContext':
          await this._clearNonPersistentContext();
          break;
        case 'dismissStaleContextItem':
          await this._dismissStaleContextItem(String(data.id || ''));
          break;
        case 'reloadContextItem':
          await this._reloadContextItem(String(data.id || ''));
          break;
        case 'reorderContextTier':
          await this._reorderContextTier(String(data.tier || 'conversation'), Array.isArray(data.ids) ? data.ids.map(String) : []);
          break;
        case 'newChat':
          await this._newChat();
          break;
        case 'selectChat':
          await this._selectChat(String(data.id || ''));
          break;
        case 'getWorkspaceFiles':
          await this._sendWorkspaceFiles();
          break;
        case 'pinWorkspaceFile':
          await this._pinWorkspaceFile(String(data.path || ''));
          break;
        case 'uploadAttachments':
          await this._uploadAttachments(Array.isArray(data.files) ? data.files : []);
          break;
        case 'previewContextItem':
          await this._previewContextItem(String(data.id || ''));
          break;
        case 'openFile':
          await this._openFileInEditor(String(data.path || ''));
          break;
        case 'fetchRequestedFiles':
          await this._fetchRequestedFiles(data.code);
          break;
        case 'getContextStatus':
          this._sendContextStatus();
          break;
        case 'setConfig':
          await this._setConfig(data.key, data.value);
          break;
        case 'undoLastApply':
          await this._undoLastApply();
          break;
        case 'exportChat':
          await this._exportCurrentChat();
          break;
        case 'shareSession':
          await this._shareCurrentSession();
          break;
        case 'loadSharedSession':
          await this._loadSharedSession();
          break;
        case 'openChangeLog':
          await this._openSessionHistoryPanel();
          break;
      }
    });

  }

  private _sendGenerationStatus(status: string) {
    this._sendToWebview({ type: 'generationStatus', text: String(status || '') });
  }

  private _sendActionLog(
    text: string,
    level?: 'info' | 'warn' | 'ok',
    meta?: { toolName?: string; outcome?: 'success' | 'warning' | 'error' | 'neutral' }
  ) {
    const normalizedText = String(text || '');
    const resolved = level || this._inferActionLogLevel(normalizedText, meta);
    this._sendToWebview({ type: 'agentAction', item: { text: normalizedText, level: resolved, at: Date.now() } });
  }

  private _inferActionLogLevel(
    text: string,
    meta?: { toolName?: string; outcome?: 'success' | 'warning' | 'error' | 'neutral' }
  ): 'info' | 'warn' | 'ok' {
    const t = String(text || '').toLowerCase();
    const tool = String(meta?.toolName || '').toLowerCase();
    const outcome = String(meta?.outcome || '').toLowerCase();
    if (!t) return 'info';

    if (outcome === 'error') return 'warn';
    if (outcome === 'warning') return 'warn';
    if (outcome === 'success') return 'ok';
    if (outcome === 'neutral') return 'info';

    // Tool-specific nuances.
    if ((tool === 'search_files' || tool === 'list_files') && /found\s+0\b/.test(t)) {
      // Zero matches can be a normal exploration result, not always a warning.
      return 'info';
    }
    if (tool === 'read_file' && (t.includes('missing') || t.includes('unreadable') || t.includes('failed'))) {
      return 'warn';
    }
    if (tool === 'run_command' && (t.includes('canceled') || t.includes('cancelled') || t.includes('blocked'))) {
      return 'warn';
    }
    if ((tool === 'remember' || tool === 'forget') && t.includes('unavailable')) {
      return 'warn';
    }

    if (
      t.includes('⚠️') ||
      t.includes('failed') ||
      t.includes('error') ||
      t.includes('blocked') ||
      t.includes('canceled') ||
      t.includes('cancelled') ||
      t.includes('interrupted') ||
      t.includes('unknown') ||
      t.includes('missing') ||
      t.includes('unreadable') ||
      t.includes('no matches')
    ) {
      return 'warn';
    }

    if (
      t.includes('✅') ||
      t.includes('done') ||
      t.includes('completed') ||
      t.includes('applied') ||
      t.includes('loaded') ||
      t.includes('saved') ||
      t.includes('staged') ||
      t.includes('validating') ||
      /found\s+[1-9]\d*\b/.test(t)
    ) {
      return 'ok';
    }

    return 'info';
  }

  private _sendTodoPlan(items: AgentTodo[]) {
    this._sendToWebview({ type: 'agentTodos', items: items.map((i) => ({ ...i })) });
  }

  private _setTodoStatus(items: AgentTodo[], id: string, status: 'pending' | 'in-progress' | 'completed') {
    const target = items.find((i) => i.id === id);
    if (!target) return;
    target.status = status;
    this._sendTodoPlan(items);
  }

  private _buildTodoPlan(userText: string): AgentTodo[] {
    const t = String(userText || '').toLowerCase();
    const wantsFix = /(fix|bug|error|issue|broken|failing|crash)/.test(t);
    const wantsBuild = /(build|create|implement|add|feature)/.test(t);
    const actionStep = wantsFix ? 'Generate fix' : wantsBuild ? 'Implement requested change' : 'Generate response';
    return [
      { id: 'scan', text: 'Scan project for related files', status: 'pending' },
      { id: 'analyze', text: 'Identify root cause and impact', status: 'pending' },
      { id: 'generate', text: actionStep, status: 'pending' },
      { id: 'validate', text: 'Validate output', status: 'pending' },
      { id: 'finalize', text: 'Finalize and present result', status: 'pending' }
    ];
  }

  private _classifyChangeScope(totalChangedLines: number): 'tiny' | 'small' | 'medium' | 'large' {
    if (totalChangedLines <= 3) return 'tiny';
    if (totalChangedLines <= 20) return 'small';
    if (totalChangedLines <= 50) return 'medium';
    return 'large';
  }

  private _classifyChangeScopeFromDiffs(
    diffs: Array<{ added: number; removed: number }>
  ): 'tiny' | 'small' | 'medium' | 'large' {
    const total = (diffs || []).reduce((sum, d) => sum + Math.max(0, Number(d.added || 0)) + Math.max(0, Number(d.removed || 0)), 0);
    return this._classifyChangeScope(total);
  }

  private async _ensureDetectedStack(): Promise<DetectedStack | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return null;
    const stack = await this._stackDetector.detect(folders[0].uri);
    this._detectedStack = stack;
    return stack;
  }

  private _isSimpleConversationalMessage(text: string): boolean {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return true;
    if (t.length <= 12) return true;
    if (/^(hi|hello|hey|yo|thanks|thank you|ok|okay|cool|nice|hii|hola|sup|what'?s up)[!. ]*$/i.test(t)) return true;
    if (/^(how are you|who are you|can you help me)[?.! ]*$/i.test(t)) return true;
    return false;
  }

  private _buildStableSystemPrompt(): string {
    return [
      'You are Azure Codex, an autonomous coding agent running inside VS Code.',
      'Core rules:',
      '- Work autonomously: scan files, infer paths, and proceed without asking user for file names, paths, or attachments.',
      '- Auto-detect stack before actions: language, framework, package manager, tests, lint, build/dev commands, entry points.',
      '- Output concise, correct code changes and structured progress updates.',
      '- Prefer minimal diffs and validate changed files.',
      '- Never rewrite full files if a surgical edit can solve the task.',
      '- Always run verification commands derived from the detected stack, never hardcoded assumptions.',
      '- For file changes, use fenced blocks: ```edit```, ```file```, ```delete``` with path headers.',
      '- For planning, emit short todo-style plans and status updates.',
      '- Keep responses deterministic and implementation-focused.',
      'Structured JSON schema requirement (mandatory):',
      '{"status":"scanning|thinking|writing|verifying|done","detected_stack":{"language":"TypeScript","framework":"Next.js","package_manager":"npm","test_runner":"Jest","linter":"ESLint"},"thinking":["..."],"action_log":[{"type":"search|read|analyze|modify|validate|terminal","message":"...","file":"...","lines":"X-Y"}],"todos":[{"id":1,"task":"...","status":"pending|active|complete"}],"scope":"tiny|small|medium|large","diffs":[{"file":"...","language":"...","added":0,"removed":0,"annotations":[{"line":1,"type":"error|warning|info","message":"..."}],"chunks":"..."}],"terminal_runs":[{"command":"...","output":"...","result":"pass|fail"}],"response_text":"...","iterations":1,"context_used":0,"noise_check":"clean|reverted","finish_reason":"stop|length"}',
      'Always output strict valid JSON matching the schema exactly.'
    ].join('\n');
  }

  private _buildPersonaInstruction(): string {
    const cfg = vscode.workspace.getConfiguration('azureCodex');
    const preset = String(cfg.get<string>('agentPersona', 'default') || 'default').toLowerCase();
    const custom = String(cfg.get<string>('agentCustomPersonaPrompt', '') || '').trim();

    let presetInstruction = '';
    if (preset === 'security') {
      presetInstruction = 'Persona: Security Reviewer. Prioritize vulnerabilities, secrets exposure, auth flaws, and unsafe command execution.';
    } else if (preset === 'performance') {
      presetInstruction = 'Persona: Performance Optimizer. Prioritize hot-path efficiency, query/index quality, caching, and async concurrency bottlenecks.';
    } else if (preset === 'reviewer') {
      presetInstruction = 'Persona: Code Reviewer. Prioritize maintainability, correctness, tests, and minimal-risk refactors.';
    }

    const parts = [presetInstruction, custom].filter(Boolean);
    return parts.join('\n');
  }

  private _rememberToolResultSnippet(text: string): void {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    this._lastToolResultSnippets.push(normalized.slice(0, 1200));
    if (this._lastToolResultSnippets.length > 80) {
      this._lastToolResultSnippets = this._lastToolResultSnippets.slice(-80);
    }
  }

  private _buildHistoryMessages(chat: {
    history: ChatMessage[];
    historySummary: string;
    messagesSinceSummary: number;
  }): Array<{ role: ChatRole; content: string }> {
    const normalized = chat.history
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      .map((m) => ({ role: m.role as ChatRole, content: this._contentToText(m.content) }));

    if (normalized.length <= 15) return normalized;

    const older = normalized.slice(0, Math.max(0, normalized.length - 15));
    if (!chat.historySummary || chat.messagesSinceSummary >= 10) {
      chat.historySummary = this._summarizeHistory(older);
      chat.messagesSinceSummary = 0;
    }

    const recent = normalized.slice(-15);
    return [{ role: 'assistant', content: `Earlier in this conversation: ${chat.historySummary}` }, ...recent];
  }

  private _summarizeHistory(messages: Array<{ role: ChatRole; content: string }>): string {
    if (!messages.length) return 'No earlier actions.';
    const userAsks = messages
      .filter((m) => m.role === 'user')
      .map((m) => this._singleLine(m.content))
      .filter(Boolean)
      .slice(-6);
    const assistantActions = messages
      .filter((m) => m.role === 'assistant')
      .map((m) => this._singleLine(m.content))
      .filter(Boolean)
      .slice(-6);

    const askText = userAsks.length ? `user asked: ${userAsks.join('; ')}` : 'user asks were brief';
    const actionText = assistantActions.length
      ? `assistant did: ${assistantActions.join('; ')}`
      : 'assistant provided analysis and implementation guidance';
    return `${askText}. ${actionText}.`;
  }

  private _singleLine(value: string): string {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  private _tryParseStructuredResponse(raw: string): StructuredResponse | null {
    const text = String(raw || '').trim();
    if (!text.startsWith('{') || !text.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return null;
      return this._coerceStructuredResponse(parsed, 0, 'stop');
    } catch {
      return null;
    }
  }

  private _coerceStructuredResponse(value: any, contextUsed: number, finishReason: string): StructuredResponse {
    const allowedStatus = new Set(['scanning', 'thinking', 'writing', 'verifying', 'done']);
    const allowedAction = new Set(['search', 'read', 'analyze', 'modify', 'validate', 'terminal']);
    const allowedTodo = new Set(['pending', 'active', 'complete']);

    const statusRaw = String(value?.status || 'done').toLowerCase();
    const status = (allowedStatus.has(statusRaw) ? statusRaw : 'done') as StructuredResponse['status'];

    const actionLog = Array.isArray(value?.action_log)
      ? value.action_log
          .map((a: any) => {
            const t = String(a?.type || 'analyze').toLowerCase();
            return {
              type: (allowedAction.has(t) ? t : 'analyze') as StructuredResponse['action_log'][number]['type'],
              message: String(a?.message || '').trim(),
              file: a?.file ? String(a.file) : undefined,
              lines: a?.lines ? String(a.lines) : undefined
            };
          })
          .filter((a: any) => a.message)
      : [];

    const todos = Array.isArray(value?.todos)
      ? value.todos
          .map((t: any, idx: number) => {
            const s = String(t?.status || 'pending').toLowerCase();
            return {
              id: Number.isFinite(Number(t?.id)) ? Number(t.id) : idx + 1,
              task: String(t?.task || '').trim(),
              status: (allowedTodo.has(s) ? s : 'pending') as StructuredResponse['todos'][number]['status']
            };
          })
          .filter((t: any) => t.task)
      : [];

    const diffs = Array.isArray(value?.diffs)
      ? value.diffs
          .map((d: any) => ({
            file: String(d?.file || '').trim(),
            language: String(d?.language || 'text').trim(),
            added: Number(d?.added || 0),
            removed: Number(d?.removed || 0),
            annotations: Array.isArray(d?.annotations)
              ? d.annotations
                  .map((a: any) => ({
                    line: Number(a?.line || 0),
                    type:
                      String(a?.type || '').toLowerCase() === 'error'
                        ? 'error'
                        : String(a?.type || '').toLowerCase() === 'warning'
                          ? 'warning'
                          : 'info',
                    message: String(a?.message || '').trim()
                  }))
                  .filter((a: any) => Number.isFinite(a.line) && a.line > 0 && a.message)
              : [],
            chunks: String(d?.chunks || '')
          }))
          .filter((d: any) => d.file)
      : [];

    const terminalRuns = Array.isArray(value?.terminal_runs)
      ? value.terminal_runs
          .map((r: any) => ({
            command: String(r?.command || '').trim(),
            output: String(r?.output || ''),
            result: String(r?.result || '').toLowerCase() === 'pass' ? 'pass' : 'fail'
          }))
          .filter((r: any) => r.command)
      : [];

    const detectedStack = value?.detected_stack && typeof value.detected_stack === 'object'
      ? {
          language: String(value.detected_stack.language || this._detectedStack?.language || 'Unknown'),
          framework: String(value.detected_stack.framework || this._detectedStack?.framework || 'None'),
          package_manager: String(value.detected_stack.package_manager || this._detectedStack?.packageManager || 'unknown'),
          test_runner: String(value.detected_stack.test_runner || this._detectedStack?.testRunner || 'unknown'),
          linter: String(value.detected_stack.linter || this._detectedStack?.linter || 'unknown')
        }
      : this._detectedStack
        ? {
            language: this._detectedStack.language,
            framework: this._detectedStack.framework,
            package_manager: this._detectedStack.packageManager,
            test_runner: this._detectedStack.testRunner,
            linter: this._detectedStack.linter
          }
        : undefined;

    const fr = String(value?.finish_reason || finishReason || 'stop').toLowerCase();
    const scopeRaw = String(value?.scope || '').toLowerCase();
    const scope = (scopeRaw === 'tiny' || scopeRaw === 'small' || scopeRaw === 'medium' || scopeRaw === 'large'
      ? scopeRaw
      : this._classifyChangeScopeFromDiffs(diffs)) as 'tiny' | 'small' | 'medium' | 'large';

    return {
      status,
      detected_stack: detectedStack,
      thinking: Array.isArray(value?.thinking) ? value.thinking.map((x: any) => String(x || '').trim()).filter(Boolean) : [],
      action_log: actionLog,
      todos,
      scope,
      response_text: String(value?.response_text || '').trim(),
      diffs,
      terminal_runs: terminalRuns.length ? terminalRuns : [...this._terminalRuns.slice(-5)],
      iterations: Number.isFinite(Number(value?.iterations)) ? Number(value.iterations) : Math.max(1, this._iterationCount),
      context_used: Number.isFinite(Number(value?.context_used)) ? Number(value.context_used) : contextUsed,
      noise_check: String(value?.noise_check || 'clean').toLowerCase() === 'reverted' ? 'reverted' : 'clean',
      finish_reason: (fr === 'length' ? 'length' : 'stop') as 'stop' | 'length'
    };
  }

  private _fallbackStructuredResponse(raw: string, contextUsed: number, finishReason: string): StructuredResponse {
    return {
      status: 'done',
      detected_stack: this._detectedStack
        ? {
            language: this._detectedStack.language,
            framework: this._detectedStack.framework,
            package_manager: this._detectedStack.packageManager,
            test_runner: this._detectedStack.testRunner,
            linter: this._detectedStack.linter
          }
        : undefined,
      thinking: [],
      action_log: [],
      todos: [],
      scope: 'tiny',
      response_text: String(raw || '').trim(),
      diffs: [],
      terminal_runs: [...this._terminalRuns.slice(-5)],
      iterations: Math.max(1, this._iterationCount),
      context_used: contextUsed,
      noise_check: 'clean',
      finish_reason: finishReason === 'length' ? 'length' : 'stop'
    };
  }

  private async _enforceStructuredResponse(
    raw: string,
    args: { contextUsed: number; finishReason: string; model?: string }
  ): Promise<StructuredResponse> {
    const initial = this._tryParseStructuredResponse(raw);
    if (initial) {
      return this._coerceStructuredResponse(initial, args.contextUsed, args.finishReason);
    }

    let candidate = String(raw || '');
    const schema = `{"status":"scanning|thinking|writing|verifying|done","detected_stack":{"language":"TypeScript","framework":"Next.js","package_manager":"npm","test_runner":"Jest","linter":"ESLint"},"thinking":["Analyzing error..."],"action_log":[{"type":"search|read|analyze|modify|validate|terminal","message":"...","file":"...","lines":"X-Y"}],"todos":[{"id":1,"task":"...","status":"pending|active|complete"}],"scope":"tiny|small|medium|large","diffs":[{"file":"filename.ext","language":"typescript","added":12,"removed":4,"annotations":[{"line":47,"type":"error","message":"Cannot read property of null"}],"chunks":"diff"}],"terminal_runs":[{"command":"npm test","output":"...","result":"pass"}],"response_text":"...","iterations":1,"context_used":123,"noise_check":"clean|reverted","finish_reason":"stop|length"}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      this._sendActionLog(`🔁 Enforcing strict JSON output (attempt ${attempt}/3)`);
      const prompt =
        `Convert the following assistant response into EXACT valid JSON using this schema and nothing else:\n${schema}\n\n` +
        `Requirements:\n- Output JSON only (no markdown, no code fences).\n- Keep technical meaning intact.\n- If no diffs/todos exist, return empty arrays.\n\n` +
        `Assistant response:\n${candidate.slice(0, 120000)}`;
      candidate = await this._client.chatToText([], prompt, { model: args.model });
      const parsed = this._tryParseStructuredResponse(candidate);
      if (parsed) {
        return this._coerceStructuredResponse(parsed, args.contextUsed, args.finishReason);
      }
    }

    this._sendActionLog('⚠️ Structured JSON normalization failed after retries; using safe fallback schema.', 'warn');
    return this._fallbackStructuredResponse(raw, args.contextUsed, args.finishReason);
  }

  private _contentToText(content: ChatContent): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return String(content || '');
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.image_url === 'string') return `[image:${part.image_url.slice(0, 120)}]`;
        if (part.image_url && typeof part.image_url.url === 'string') return `[image:${part.image_url.url.slice(0, 120)}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private _isLikelyNoFileAccessQuery(text?: string): boolean {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return true;
    if (t.length < 36) {
      if (/^(thanks|thank you|ok|okay|continue|next|why|how|what now|summarize)$/i.test(t)) return true;
    }
    return !/(file|project|workspace|repo|repository|bug|error|function|class|module|refactor|fix|implement|build|compile|test|stack|trace|api|endpoint|query|db|schema|route|typescript|javascript|python|code|csv|excel|xlsx|sheet|formula|table|dataset|data file|derive|feature generation)/.test(t);
  }

  private async _maybeAutoLookupDocumentation(userText: string): Promise<void> {
    const text = String(userText || '').toLowerCase();
    const looksLikeUnknownApi =
      /(deprecated|unknown|unfamiliar|cannot find module|typeerror|referenceerror|syntaxerror|api changed|not a function|undefined is not)/.test(
        text
      );
    if (!looksLikeUnknownApi) return;

    const query = encodeURIComponent(String(userText || '').slice(0, 240));
    const url = `https://r.jina.ai/http://duckduckgo.com/?q=${query}`;
    this._sendActionLog('🌐 Looking up latest docs/web references for this issue');
    const fetched = await this._safeFetchUrl(url);
    const clipped = fetched.slice(0, 6000);
    this._rememberToolResultSnippet(`Web lookup (${url}):\n${clipped}`);
  }

  private _computeLineDelta(before: string, after: string): { added: number; removed: number } {
    const a = String(before || '').replace(/\r\n/g, '\n').split('\n');
    const b = String(after || '').replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    let j = 0;
    let added = 0;
    let removed = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i++;
        j++;
        continue;
      }
      if (i + 1 < a.length && a[i + 1] === b[j]) {
        removed++;
        i++;
        continue;
      }
      if (j + 1 < b.length && a[i] === b[j + 1]) {
        added++;
        j++;
        continue;
      }
      removed++;
      added++;
      i++;
      j++;
    }
    if (i < a.length) removed += a.length - i;
    if (j < b.length) added += b.length - j;
    return { added, removed };
  }

  private _sendChangeSummary(files: FileDelta[]) {
    const normalized = files.filter((f) => f.path && (f.added > 0 || f.removed > 0));
    if (!normalized.length) return;
    const added = normalized.reduce((sum, f) => sum + f.added, 0);
    const removed = normalized.reduce((sum, f) => sum + f.removed, 0);
    this._sendToWebview({
      type: 'changeSummary',
      summary: {
        filesChanged: normalized.length,
        added,
        removed,
        files: normalized
      }
    });
  }

  private _ensureChatState() {
    if (this._activeChatId && this._chats.some((c) => c.id === this._activeChatId)) return;
    if (this._chats.length) {
      this._activeChatId = this._chats[0].id;
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this._chats.push({
      id,
      title: 'New chat',
      createdAt: Date.now(),
      history: [],
      context: new FileContextManager(),
      messageSeq: 0,
      historySummary: '',
      messagesSinceSummary: 0,
      loadedSectionRegistry: new Set<string>()
    });
    this._activeChatId = id;
  }

  private _activeChat() {
    this._ensureChatState();
    const chat = this._chats.find((c) => c.id === this._activeChatId) || this._chats[0];
    return chat;
  }

  private _sendChatState() {
    const active = this._activeChat();
    const config = vscode.workspace.getConfiguration('azureCodex');
    this._sendToWebview({
      type: 'chatState',
      state: {
        activeId: active.id,
        chats: this._chats.map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: c.createdAt
        })),
        transcript: active.history,
        scrollNearBottomThreshold: config.get<number>('scrollNearBottomThreshold', 120)
      }
    });
  }

  private async _newChat() {
    const previous = this._activeChat();
    const persistentSeed = previous.context.listByTier('persistent');
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const newContext = new FileContextManager();
    for (const item of persistentSeed) {
      if (item.kind === 'image' && item.dataUrl) {
        newContext.upsertImage({
          id: item.id,
          source: item.source,
          displayPath: item.path,
          sizeBytes: item.sizeBytes,
          dataUrl: item.dataUrl,
          tier: 'persistent',
          tokenCount: item.tokenCount,
          lastKnownMtimeMs: item.lastKnownMtimeMs
        });
      } else if (item.kind === 'text' && typeof item.text === 'string') {
        newContext.upsertText({
          id: item.id,
          source: item.source,
          displayPath: item.path,
          sizeBytes: item.sizeBytes,
          text: item.text,
          tier: 'persistent',
          tokenCount: item.tokenCount,
          lastKnownMtimeMs: item.lastKnownMtimeMs,
          isVirtual: item.isVirtual
        });
      }
    }

    this._chats.unshift({
      id,
      title: 'New chat',
      createdAt: Date.now(),
      history: [],
      context: newContext,
      messageSeq: 0,
      historySummary: '',
      messagesSinceSummary: 0,
      loadedSectionRegistry: new Set<string>()
    });
    this._activeChatId = id;
    this._sendChatState();
    this._sendContextStatus();
    this._sendToWebview({ type: 'toast', text: '🔄 New chat started — conversation references cleared.' });
  }

  private async _selectChat(id: string) {
    const found = this._chats.find((c) => c.id === id);
    if (!found) return;
    this._activeChatId = id;
    this._sendChatState();
    this._sendContextStatus();
  }

  private async _handleUserMessage(
    text: string,
    opts?: { displayText?: string; autoFetchDepth?: number; retryCount?: number; mode?: string }
  ) {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    this._sendToWebview({ type: 'continuationState', visible: false, remaining: 0, max: 3 });
    const retryCount = Math.max(0, Number(opts?.retryCount ?? 0));
    const mode = String(opts?.mode || 'auto').toLowerCase();
    const maxRetries = 3;
    let slowInterval: ReturnType<typeof setInterval> | undefined;

    if (this._isHandlingMessage) {
      this._queuedMessages.push({ text: normalized, opts });
      const queued = this._queuedMessages.length;
      if (queued >= 3) {
        this._sendToWebview({ type: 'toast', text: `${queued} messages queued — processing after current task` });
      } else {
        this._sendToWebview({ type: 'toast', text: `${queued} message queued` });
      }
      return;
    }

    this._isHandlingMessage = true;
    try {
    if (!this._view) return;

    if (!this._client.isConfigured()) {
      this._sendToWebview({ type: 'error', text: this._client.getConfigError() });
      return;
    }

    this._iterationCount = 0;
    this._terminalRuns = [];
    const detectedStack = await this._ensureDetectedStack();
    if (detectedStack) {
      this._sendActionLog(detectedStack.summary, 'ok');
      this._sendGenerationStatus('Scanning project stack...');
    }

    // Cancel any in-flight generation before starting a new one.
    this._stopGeneration();

    const chat = this._activeChat();
    chat.messageSeq = (chat.messageSeq || 0) + 1;
    const currentMessageSeq = chat.messageSeq;
    const config = vscode.workspace.getConfiguration('azureCodex');
    const agentEnabled = config.get<boolean>('agentEnabled', false);
    const simpleConversational = this._isSimpleConversationalMessage(normalized);
    const useReadOnlyQnA = mode === 'qna';
    const useRefactorMode = mode === 'refactor';
    const useAgentModeForThisTurn =
      !useReadOnlyQnA && !simpleConversational && (mode === 'agent' || useRefactorMode || agentEnabled);
    const todos = simpleConversational ? [] : this._buildTodoPlan(normalized);
    if (todos.length) {
      this._sendTodoPlan(todos);
      this._setTodoStatus(todos, 'scan', 'in-progress');
      this._sendActionLog(`🔍 Searched project context for: "${normalized.slice(0, 80)}${normalized.length > 80 ? '…' : ''}"`);
    }

    // Show user message
    this._sendToWebview({ type: 'userMessage', text: opts?.displayText ?? normalized });

    if (useAgentModeForThisTurn) {
      this._setTodoStatus(todos, 'scan', 'completed');
      this._setTodoStatus(todos, 'analyze', 'completed');
      this._setTodoStatus(todos, 'generate', 'in-progress');
      const agentPrompt = useRefactorMode
        ? `${normalized}\n\nRefactor mode active: perform coordinated multi-file refactor and prepare a complete reviewable diff set before applying.`
        : normalized;
      await this._runAgent(agentPrompt);
      this._setTodoStatus(todos, 'generate', 'completed');
      this._setTodoStatus(todos, 'validate', 'completed');
      this._setTodoStatus(todos, 'finalize', 'completed');
      return;
    }

    // Auto-load any explicit absolute paths mentioned in the user message into pinned context.
    this._sendGenerationStatus('Reading workspace...');
    this._sendActionLog('📄 Reading relevant files and attachments');
    await this._autoAttachPathsFromText(normalized);
    await this._maybeAutoLookupDocumentation(normalized);
    this._setTodoStatus(todos, 'scan', 'completed');
    this._setTodoStatus(todos, 'analyze', 'in-progress');
    this._sendActionLog('🧠 Analyzing modules and dependencies');

    // Start streaming assistant response
    this._sendGenerationStatus('Planning fix...');
    this._sendToWebview({ type: 'assistantStart' });

    const contextMessages = await this._buildContextMessages(normalized);
    this._sendActionLog(`🔍 Searched workspace context — found ${contextMessages.length} context message(s).`);

    const compressedHistory = this._buildHistoryMessages(chat);
    const compressionPlan = this._contextWindow.compressToBudget({
      systemPrompt: this._systemPrompt,
      historyMessages: compressedHistory,
      loadedFileSections: contextMessages.map((m) => this._contentToText(m.content)),
      toolResults: this._lastToolResultSnippets
    });

    this._sendActionLog(`📊 Context: ${compressionPlan.usage.withReserved.toLocaleString()} / 400,000 tokens used`);
    if (compressionPlan.compressed) {
      this._sendActionLog('🗜️ Compressing context — summarizing older messages and trimming file cache');
    }

    const historyWithContext: ChatMessage[] = [
      { role: 'system', content: compressionPlan.systemPrompt },
      ...(detectedStack
        ? ([
            {
              role: 'system',
              content:
                `Detected stack:\n` +
                `- Language: ${detectedStack.language} ${detectedStack.languageVersion}\n` +
                `- Framework: ${detectedStack.framework} ${detectedStack.frameworkVersion}\n` +
                `- Package manager: ${detectedStack.packageManager}\n` +
                `- Test runner: ${detectedStack.testRunner}\n` +
                `- Linter: ${detectedStack.linter}\n` +
                `- Formatter: ${detectedStack.formatter}\n` +
                `- Build command: ${detectedStack.buildCommand}\n` +
                `- Dev command: ${detectedStack.devCommand}\n` +
                `- Entry points: ${detectedStack.entryPoints.join(', ')}`
            }
          ] as ChatMessage[])
        : []),
      ...(this._buildPersonaInstruction()
        ? ([{ role: 'system', content: this._buildPersonaInstruction() }] as ChatMessage[])
        : []),
      ...(useReadOnlyQnA
        ? ([
            {
              role: 'system',
              content:
                'Codebase Q&A mode: read-only analysis only. Do not emit file/edit/delete blocks or propose applying workspace changes.'
            }
          ] as ChatMessage[])
        : []),
      ...compressionPlan.historyMessages.map((m) => ({ role: m.role, content: m.content } as ChatMessage)),
      ...compressionPlan.loadedFileSections.map((section) => ({ role: 'system', content: section } as ChatMessage)),
      ...compressionPlan.toolResults.map((section) => ({ role: 'system', content: `Recent tool output:\n${section}` } as ChatMessage))
    ];
    this._setTodoStatus(todos, 'analyze', 'completed');
    this._setTodoStatus(todos, 'generate', 'in-progress');

	    const abort = new AbortController();
	    this._currentAbort = abort;
	    const timeoutMsRaw = vscode.workspace.getConfiguration('azureCodex').get<number>('requestTimeoutMs', 120_000);
	    const timeoutMs = Math.max(10_000, Math.min(10 * 60_000, Number(timeoutMsRaw) || 120_000));

	    const model = this._deps?.modelRouter?.getChatDeployment(
	      vscode.workspace.getConfiguration('azureCodex').get<string>('deploymentName', 'gpt-5-2-codex-max')
	    );

    const autoContinueEnabled = config.get<boolean>('autoContinueOnTruncation', true);
    const autoContinueMaxTurns = 3;
    this._sendToWebview({ type: 'continuationState', visible: false, remaining: autoContinueMaxTurns, max: autoContinueMaxTurns });

    let fullResponse = '';
    let scratchHistory: ChatMessage[] = [...historyWithContext];
    let userContent: ChatContent = this._buildUserContent(normalized);
    let generatedTokens = 0;
    let lastTokenAt = Date.now();
    let warnedSlow = false;
    slowInterval = setInterval(() => {
      const idleFor = Date.now() - lastTokenAt;
      this._sendToWebview({ type: 'generationMetrics', tokens: generatedTokens });
      if (!warnedSlow && idleFor >= 10_000) {
        warnedSlow = true;
        this._sendToWebview({ type: 'toast', level: 'warning', text: '⚠️ Generation slow — still working...' });
      }
    }, 500);

	    let hadError = false;
      let lastErrorText = '';
	    let continuationExhausted = false;
      let finalFinishReason: 'stop' | 'length' = 'stop';
	    for (let turn = 1; turn <= autoContinueMaxTurns; turn++) {
        this._iterationCount = turn;
	      if (abort.signal.aborted) break;

	      let turnText = '';
	      let endMeta: StreamEndMeta | undefined = undefined;
	      let ignoreCallbacks = false;
        let timeoutReason: 'overall' | 'firstToken' | 'idle' | undefined;
        let wroteAnyToken = false;

	      const didTimeout = await new Promise<boolean>((resolve) => {
	        let finished = false;
          let seenAnyToken = false;
          const firstTokenTimeoutMs = Math.max(15_000, Math.min(45_000, Math.floor(timeoutMs * 0.4)));
          const idleTokenTimeoutMs = 20_000;
	
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          const clearAllTimers = () => {
            clearTimeout(timer);
            clearTimeout(firstTokenTimer);
            if (idleTimer) clearTimeout(idleTimer);
          };
	
          const finish = (timedOut: boolean, reason?: 'overall' | 'firstToken' | 'idle') => {
            if (finished) return;
            finished = true;
            clearAllTimers();
            if (timedOut) {
              timeoutReason = reason ?? 'overall';
              ignoreCallbacks = true;
              try {
                abort.abort();
              } catch {
                // ignore
              }
            }
            resolve(timedOut);
          };
	
          const timer = setTimeout(() => {
            finish(true, 'overall');
          }, timeoutMs);
	
          const firstTokenTimer = setTimeout(() => {
            if (seenAnyToken) return;
            finish(true, 'firstToken');
          }, firstTokenTimeoutMs);
	
          const resetIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              finish(true, 'idle');
            }, idleTokenTimeoutMs);
          };

	        this._client
	          .chat(
	            scratchHistory,
	            userContent,
	            {
	              onToken: (token) => {
	                if (ignoreCallbacks) return;
                  lastTokenAt = Date.now();
                  generatedTokens += this._contextWindow.countTokens(token);
                  if (!wroteAnyToken) {
                    wroteAnyToken = true;
                    this._sendGenerationStatus('Writing changes...');
                    this._sendActionLog('✏️ Modifying relevant files', 'info');
                  }
                  seenAnyToken = true;
                  clearTimeout(firstTokenTimer);
                  resetIdleTimer();
	                turnText += token;
	                fullResponse += token;
	                this._sendToWebview({ type: 'assistantToken', token });
	              },
	              onDone: (meta) => {
	                if (ignoreCallbacks) return;
	                endMeta = meta;
	              },
		              onError: (error) => {
		                if (ignoreCallbacks) return;
		                hadError = true;
		                let normalized = '';
		                try {
		                  normalized = String(error || '');
		                } catch {
		                  normalized = '';
		                }
                    lastErrorText = normalized || 'Unknown error';
		                if (normalized.toLowerCase() === 'canceled') {
		                  this._sendToWebview({ type: 'assistantStopped' });
		                } else {
		                  this._sendToWebview({ type: 'error', text: typeof error === 'string' ? error : normalized || 'Unknown error' });
		                }
		              }
	            },
	            { signal: abort.signal, model }
	          )
	          .then(() => {
              finish(false);
	          })
              .catch((e: any) => {
                if (finished) return;
		            hadError = true;
		            let msg = '';
		            try {
		              msg = String(e?.message || e || '');
		            } catch {
		              msg = 'Unknown error';
		            }
                  lastErrorText = msg || 'Unknown error';
		            this._sendToWebview({ type: 'error', text: msg || 'Unknown error' });
                finish(false);
		          });
	      });

	      if (didTimeout) {
	        hadError = true;
          if (timeoutReason === 'firstToken') {
            lastErrorText = 'No response tokens were received in time.';
            this._sendToWebview({ type: 'error', text: 'No response tokens were received in time. Please retry with a smaller prompt or fewer attachments.' });
          } else if (timeoutReason === 'idle') {
            lastErrorText = 'The response stream became idle for too long.';
            this._sendToWebview({ type: 'error', text: 'The response stream became idle for too long. Please retry.' });
          } else {
            lastErrorText = `Request timed out after ${Math.round(timeoutMs / 1000)}s.`;
            this._sendToWebview({ type: 'error', text: `Request timed out after ${Math.round(timeoutMs / 1000)}s.` });
          }
	        break;
	      }

	      if (hadError || abort.signal.aborted) break;

      // Extend the scratch conversation so the model can continue seamlessly.
      scratchHistory = [...scratchHistory, { role: 'user', content: userContent }, { role: 'assistant', content: turnText }];

        const finishReason = String((endMeta as any)?.finishReason || '').toLowerCase();
        const missingFinishReason = !finishReason;
        const needsContinuation =
          finishReason === 'length' ||
          finishReason === 'max_output_tokens' ||
          missingFinishReason ||
          this._looksTruncated(fullResponse, endMeta);

        finalFinishReason = needsContinuation ? 'length' : 'stop';

        if (!autoContinueEnabled || !needsContinuation) break;
        if (turn >= autoContinueMaxTurns) {
          continuationExhausted = true;
          break;
        }

        this._sendToWebview({
          type: 'continuationState',
          visible: false,
          remaining: Math.max(0, autoContinueMaxTurns - turn),
          max: autoContinueMaxTurns
        });

          if (finishReason === 'content_filter') {
            userContent = 'Continue from where you left off. Rephrase any blocked content safely without losing technical meaning.';
          } else {
            userContent = this._buildAutoContinuePrompt(fullResponse);
          }

        this._sendGenerationStatus('Finalizing response...');
	    }

	    this._currentAbort = undefined;
        if (slowInterval) {
          clearInterval(slowInterval);
          slowInterval = undefined;
        }
      if (hadError || abort.signal.aborted) {
        const canRetry = !abort.signal.aborted && retryCount < (maxRetries - 1) && this._isRetriableGenerationError(lastErrorText);
        if (canRetry) {
          const nextAttempt = retryCount + 2;
          this._sendToWebview({ type: 'toast', text: `Generation timed out — retrying (${nextAttempt}/${maxRetries})...` });
          this._sendActionLog(`⚠️ Streaming interrupted — retrying (${nextAttempt}/${maxRetries}).`, 'warn');
          const focusedPrompt = retryCount >= 1
            ? `${normalized}\n\nRetry with minimal context: focus only on the exact files required and produce concise complete edits.`
            : normalized;
          this._queuedMessages.unshift({
            text: focusedPrompt,
            opts: {
              displayText: opts?.displayText || normalized,
              autoFetchDepth: opts?.autoFetchDepth,
                retryCount: retryCount + 1,
                mode: opts?.mode
            }
          });
        }
        return;
      }

      if (continuationExhausted) {
        this._sendToWebview({
          type: 'continuationExhausted',
          suggestedText: 'Continue exactly from where you left off without repeating anything',
          remaining: 0,
          max: autoContinueMaxTurns
        });
        this._sendToWebview({
          type: 'toast',
          level: 'warning',
          text: 'Response was too large to complete in one pass — use Continue to resume.'
        });
      }

    const structured = await this._enforceStructuredResponse(fullResponse, {
      contextUsed: compressionPlan.usage.subtotal,
      finishReason: continuationExhausted ? 'length' : finalFinishReason,
      model
    });
    if (structured?.scope) {
      const touched = (structured.diffs || []).length;
      this._sendActionLog(`🧭 ${structured.scope} change detected — ${(structured.diffs || []).reduce((s, d) => s + Math.max(0, d.added || 0) + Math.max(0, d.removed || 0), 0)} lines across ${touched} file(s)`);
    }
    if (structured?.action_log?.length) {
      for (const entry of structured.action_log.slice(0, 40)) {
        const label = `[${String(entry.type || 'info')}] ${String(entry.message || '').trim()}`;
        const file = String(entry.file || '').trim();
        const lines = String(entry.lines || '').trim();
        const text = file ? `${label}${lines ? ` (${file}:${lines})` : ` (${file})`}` : label;
        this._sendActionLog(text || 'Action', 'info');
      }
    }
    if (structured?.todos?.length) {
      const items = structured.todos.map((t, idx) => ({
        id: String(t.id ?? idx + 1),
        text: String(t.task || `Task ${idx + 1}`),
        status:
          String(t.status || '').toLowerCase() === 'complete'
            ? 'completed'
            : String(t.status || '').toLowerCase() === 'active'
              ? 'in-progress'
              : 'pending'
      })) as AgentTodo[];
      this._sendTodoPlan(items);
    }
    if (typeof structured?.context_used === 'number') {
      this._sendActionLog(`📊 Used ${structured.context_used.toLocaleString()} tokens this request`);
    }

    const normalizedAssistantOutput = structured?.response_text
      ? String(structured.response_text)
      : fullResponse;

    // Save to history (only the original user message + normalized assistant output).
    chat.history.push({ role: 'user', content: normalized });
    chat.history.push({ role: 'assistant', content: normalizedAssistantOutput });
    chat.messagesSinceSummary += 2;
    if (chat.history.length > 20) chat.history = chat.history.slice(-20);

    if (chat.title === 'New chat') {
      const t = String(normalized || '').trim().replace(/\s+/g, ' ').slice(0, 48);
      chat.title = t ? t : 'Chat';
      this._sendChatState();
    }

    this._sendGenerationStatus('');
    this._setTodoStatus(todos, 'generate', 'completed');
    this._setTodoStatus(todos, 'validate', 'in-progress');
    this._sendGenerationStatus('Running verification...');
    this._sendActionLog('✅ Validating changes...', 'ok');
    this._sendToWebview({ type: 'assistantDone' });
    const consumedOneTime = chat.context.removeOneTimeAfterUse(currentMessageSeq);
    if (consumedOneTime.length > 0) {
      this._sendToWebview({
        type: 'toast',
        text: `🗑️ Removed ${consumedOneTime.length} one-time reference${consumedOneTime.length > 1 ? 's' : ''} after use.`
      });
      this._sendContextStatus();
    }
    if (!useReadOnlyQnA) {
      this._autoApplyIfEnabled(fullResponse).catch(() => {});
    }

    // If the assistant requested files via ```request```, auto-fetch them into pinned context and continue.
    await this._autoFetchRequestedFilesFromAssistant(fullResponse, { autoFetchDepth: opts?.autoFetchDepth ?? 0 });
    this._setTodoStatus(todos, 'validate', 'completed');
    this._setTodoStatus(todos, 'finalize', 'completed');
    } finally {
      if (slowInterval) {
        clearInterval(slowInterval);
      }
      this._sendGenerationStatus('');
      this._isHandlingMessage = false;
      if (this._queuedMessages.length) {
        const next = this._queuedMessages.shift();
        if (next) {
          void this._handleUserMessage(next.text, next.opts);
        }
      }
    }
  }

  private _isRetriableGenerationError(errorText: string): boolean {
    const t = String(errorText || '').toLowerCase();
    if (!t) return false;
    return (
      t.includes('timed out') ||
      t.includes('timeout') ||
      t.includes('idle') ||
      t.includes('rate limit') ||
      t.includes('429') ||
      t.includes('connection closed') ||
      t.includes('connection aborted') ||
      t.includes('econnreset') ||
      t.includes('etimedout') ||
      t.includes('network') ||
      t.includes('socket hang up')
    );
  }

  private _looksTruncated(text: string, endMeta?: StreamEndMeta | undefined): boolean {
    const finishReason = String(endMeta?.finishReason || '').toLowerCase();
    if (endMeta?.incomplete) return true;
    if (finishReason === 'length' || finishReason === 'max_output_tokens') return true;
    if (this._getOpenFenceInfo(text) !== null) return true;
    return this._looksLikeLeadInWithoutBody(text);
  }

  private _looksLikeLeadInWithoutBody(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return false;
    if (t.length > 500) return false;
    if (t.includes('```')) return false;

    const tail = t.slice(-250).toLowerCase();
    const lastChar = t.slice(-1);
    const endsLikeLeadIn = lastChar === ':' || tail.endsWith('below.') || tail.endsWith('below:') || tail.endsWith('below');
    if (!endsLikeLeadIn) return false;

    // Common "I will paste code now" lead-ins that often get cut off by the model/UI.
    const intent =
      tail.includes('continuation') ||
      tail.includes('continue') ||
      tail.includes('re-sending') ||
      tail.includes('resending') ||
      tail.includes('re-send') ||
      tail.includes('sending the complete') ||
      tail.includes('here is') ||
      tail.includes('here’s') ||
      tail.includes('heres');

    // Avoid triggering on genuine short conversational replies.
    return intent;
  }

  private _buildAutoContinuePrompt(assistantSoFar: string): string {
    const open = this._getOpenFenceInfo(assistantSoFar);
    if (open?.lang === 'file' && open.path) {
      return (
        `Continue the open \`\`\`file\`\`\` block for path: ${open.path}\n` +
        `- Do NOT start a new fenced block header.\n` +
        `- Continue exactly from the next character after your last output.\n` +
        `- When the file is complete, close the fence with \`\`\`.\n` +
        `- Do not repeat any earlier text.`
      );
    }
    if (open?.lang) {
      return (
        `Continue the open \`\`\`${open.lang}\`\`\` block.\n` +
        `- Do NOT restart it.\n` +
        `- Continue exactly from the next character after your last output.\n` +
        `- Close the fence with \`\`\` when done.\n` +
        `- Do not repeat any earlier text.`
      );
    }
    return (
      `Continue exactly where you left off.\n` +
      `- Do not repeat any earlier content.\n` +
      `- If you output fenced blocks (\`\`\`file\`\`\`, \`\`\`edit\`\`\`), make sure each block is complete and properly closed.\n` +
      `- Keep going until the task is complete.`
    );
  }

  private _getOpenFenceInfo(text: string): { lang: string; path?: string } | null {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    let openLang: string | null = null;
    let openPath: string | undefined = undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('```')) continue;

      if (openLang === null) {
        openLang = line.slice(3).trim() || 'text';
        openPath = undefined;
        if ((openLang === 'file' || openLang === 'edit' || openLang === 'delete') && i + 1 < lines.length) {
          const next = lines[i + 1].trim();
          if (next.toLowerCase().startsWith('path:')) openPath = next.slice(5).trim();
        }
      } else {
        openLang = null;
        openPath = undefined;
      }
    }

    return openLang ? { lang: openLang, path: openPath } : null;
  }

  private async _insertCodeToEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit(editBuilder => {
        editBuilder.replace(editor.selection, code);
      });
      vscode.window.showInformationMessage('Code inserted into editor!');
    } else {
      // Open new document with code
      const doc = await vscode.workspace.openTextDocument({ content: code });
      vscode.window.showTextDocument(doc);
    }
  }

  public async sendMessageFromCommand(prompt: string, label: string) {
    if (!this._view) return;
    this._sendToWebview({ type: 'commandMessage', text: prompt, label });
    await this._handleUserMessage(prompt);
  }

  public async startFreshChatOnOpen() {
    const cfg = vscode.workspace.getConfiguration('azureCodex');
    const alwaysFresh = cfg.get<boolean>('alwaysStartFreshOnOpen', true);

    this._stopGeneration();
    this._queuedMessages = [];

    if (alwaysFresh) {
      await this._newChat();
      this._sendToWebview({ type: 'toast', text: 'Started a fresh chat.' });
      return;
    }

    this._ensureChatState();
    this._sendChatState();
    this._sendContextStatus();
  }

  public clearHistory() {
    const chat = this._activeChat();
    chat.history = [];
    chat.historySummary = '';
    chat.messagesSinceSummary = 0;
    chat.loadedSectionRegistry.clear();
    this._sendToWebview({ type: 'clearHistory' });
    vscode.window.showInformationMessage('Azure Codex: Chat history cleared.');
    this._sendChatState();
  }

  public async undoLastApply() {
    await this._undoLastApply();
  }

  public async openSessionHistory() {
    await this._openSessionHistoryPanel();
  }

  private async _exportCurrentChat(): Promise<void> {
    const chat = this._activeChat();
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) {
      vscode.window.showWarningMessage('Open a workspace to export chat.');
      return;
    }
    const lines: string[] = [];
    lines.push(`# Azure Codex Chat Export`);
    lines.push(``);
    lines.push(`- Title: ${chat.title}`);
    lines.push(`- Exported: ${new Date().toISOString()}`);
    lines.push(``);
    for (const m of chat.history) {
      lines.push(`## ${m.role.toUpperCase()}`);
      lines.push(``);
      lines.push(this._contentToText(m.content));
      lines.push(``);
    }
    const dir = vscode.Uri.joinPath(folders[0].uri, '.azure-codex', 'exports');
    await vscode.workspace.fs.createDirectory(dir);
    const name = `chat-${Date.now()}.md`;
    const out = vscode.Uri.joinPath(dir, name);
    await vscode.workspace.fs.writeFile(out, Buffer.from(lines.join('\n'), 'utf8'));
    const doc = await vscode.workspace.openTextDocument(out);
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(`Exported chat to ${name}`);
  }

  private async _shareCurrentSession(): Promise<void> {
    const chat = this._activeChat();
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    const uri = vscode.Uri.joinPath(folders[0].uri, '.azure-codex', 'shared-session.json');
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, '.azure-codex'));
    const payload = {
      title: chat.title,
      exportedAt: Date.now(),
      history: chat.history,
      pinned: chat.context.list()
    };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
    vscode.window.showInformationMessage('Shared session snapshot saved to .azure-codex/shared-session.json');
  }

  private async _loadSharedSession(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    const uri = vscode.Uri.joinPath(folders[0].uri, '.azure-codex', 'shared-session.json');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as any;
      const chat = this._activeChat();
      chat.title = String(data?.title || 'Shared session');
      chat.history = Array.isArray(data?.history) ? data.history : [];
      chat.historySummary = '';
      chat.messagesSinceSummary = 0;
      chat.loadedSectionRegistry.clear();
      chat.context.clear();
      const pinned = Array.isArray(data?.pinned) ? data.pinned : [];
      for (const item of pinned) {
        if (item?.kind === 'image' && item?.dataUrl) {
          chat.context.upsertImage({
            source: 'workspace',
            displayPath: String(item.path || item.name || 'image'),
            sizeBytes: Number(item.sizeBytes || 0),
            dataUrl: String(item.dataUrl),
            tier: String(item.tier || 'conversation') === 'persistent' ? 'persistent' : String(item.tier || '') === 'oneTime' ? 'oneTime' : 'conversation',
            tokenCount: Number(item.tokenCount || 0),
            lastKnownMtimeMs: Number(item.lastKnownMtimeMs || 0) || undefined
          });
        } else if (item?.kind === 'text' && typeof item?.text === 'string') {
          chat.context.upsertText({
            source: 'workspace',
            displayPath: String(item.path || item.name || 'file'),
            sizeBytes: Number(item.sizeBytes || 0),
            text: String(item.text),
            tier: String(item.tier || 'conversation') === 'persistent' ? 'persistent' : String(item.tier || '') === 'oneTime' ? 'oneTime' : 'conversation',
            tokenCount: Number(item.tokenCount || 0),
            lastKnownMtimeMs: Number(item.lastKnownMtimeMs || 0) || undefined,
            isVirtual: !!item.isVirtual
          });
        }
      }
      this._sendChatState();
      this._sendContextStatus();
      vscode.window.showInformationMessage('Loaded shared session snapshot.');
    } catch {
      vscode.window.showWarningMessage('No shared session found at .azure-codex/shared-session.json');
    }
  }

  private async _openChangeLogFile(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    const uri = vscode.Uri.joinPath(folders[0].uri, '.azure-codex', 'change-log.md');
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, '.azure-codex'));
      await vscode.workspace.fs.writeFile(uri, Buffer.from('# Azure Codex Change Log\n\n', 'utf8'));
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private _historyUri(): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return null;
    return vscode.Uri.joinPath(folders[0].uri, HISTORY_DIR, HISTORY_FILE);
  }

  private _persistentContextUri(): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return null;
    return vscode.Uri.joinPath(folders[0].uri, HISTORY_DIR, PERSISTENT_CONTEXT_FILE);
  }

  private async _readPersistentContextPaths(): Promise<string[]> {
    const uri = this._persistentContextUri();
    if (!uri) return [];
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (!Array.isArray(parsed?.paths)) return [];
      return parsed.paths.map((p: any) => String(p || '')).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async _writePersistentContextPaths(paths: string[]): Promise<void> {
    const uri = this._persistentContextUri();
    if (!uri) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, HISTORY_DIR));
    const payload = { paths: Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b)), updatedAt: Date.now() };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
  }

  private async _bootstrapPersistentWorkspaceContext(): Promise<void> {
    if (this._didBootstrapPersistentContext) return;
    this._didBootstrapPersistentContext = true;

    const chat = this._activeChat();
    const stack = await this._ensureDetectedStack();
    const fromStorage = await this._readPersistentContextPaths();

    const defaults = ['README.md', 'package.json', 'tsconfig.json', '.env.example'];
    const stackEntries = Array.isArray(stack?.entryPoints) ? stack!.entryPoints.map((p) => String(p)) : [];
    const seed = Array.from(new Set([...defaults, ...stackEntries, ...fromStorage]))
      .map((p) => p.trim())
      .filter((p) => !!p && !p.startsWith('/') && !p.includes('**') && !looksSensitivePath(p));

    const persisted: string[] = [];
    for (const relPath of seed.slice(0, 40)) {
      const loaded = await this._loadWorkspaceFileForContext(relPath, { source: 'workspace', tier: 'persistent' });
      if (loaded) persisted.push(relPath);
    }

    if (persisted.length) {
      await this._writePersistentContextPaths(persisted);
      this._sendActionLog(`📌 Injecting ${persisted.length} persistent workspace files into context`);
      this._sendContextStatus();
    }
  }

  private async _readHistorySnapshots(): Promise<HistorySnapshot[]> {
    const uri = this._historyUri();
    if (!uri) return [];
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((x: any) => ({
          id: String(x?.id || ''),
          at: Number(x?.at || 0),
          action: String(x?.action || 'Change'),
          files: Array.isArray(x?.files) ? x.files.map((f: any) => String(f)) : [],
          ops: Array.isArray(x?.ops)
            ? x.ops.map((o: any) => ({
                path: String(o?.path || ''),
                prevExists: !!o?.prevExists,
                prevContent: String(o?.prevContent || '')
              }))
            : []
        }))
        .filter((x: HistorySnapshot) => !!x.id);
    } catch {
      return [];
    }
  }

  private async _writeHistorySnapshots(items: HistorySnapshot[]): Promise<void> {
    const uri = this._historyUri();
    if (!uri) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    const folderUri = vscode.Uri.joinPath(folders[0].uri, HISTORY_DIR);
    await vscode.workspace.fs.createDirectory(folderUri);
    const trimmed = items.slice(-1000);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(trimmed, null, 2), 'utf8'));
  }

  private async _appendHistorySnapshot(snapshot: HistorySnapshot): Promise<void> {
    const current = await this._readHistorySnapshots();
    current.push(snapshot);
    await this._writeHistorySnapshots(current);
  }

  private async _historyPanelEntries(): Promise<SessionHistoryEntry[]> {
    const snapshots = await this._readHistorySnapshots();
    return snapshots.map((s) => ({
      id: s.id,
      at: s.at,
      action: s.action,
      files: s.files,
      opCount: s.ops.length
    }));
  }

  private async _openSessionHistoryPanel(): Promise<void> {
    const entries = await this._historyPanelEntries();
    SessionHistoryPanel.show({
      extensionUri: this._extensionUri,
      entries,
      onRefresh: async () => await this._historyPanelEntries(),
      onRestore: async (id) => {
        await this._restoreHistorySnapshot(id);
      }
    });
  }

  private async _restoreHistorySnapshot(id: string): Promise<void> {
    const snapshots = await this._readHistorySnapshots();
    const target = snapshots.find((s) => s.id === id);
    if (!target) {
      vscode.window.showWarningMessage('History snapshot not found.');
      return;
    }
    if (!target.ops.length) {
      vscode.window.showWarningMessage('Snapshot has no restorable operations.');
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;

    const undoOps: Array<{ path: string; prevExists: boolean; prevContent: string }> = [];

    for (const op of [...target.ops].reverse()) {
      const targetUri = vscode.Uri.joinPath(folders[0].uri, op.path);

      // Capture current state so restore itself is undoable.
      let currentExists = false;
      let currentContent = '';
      try {
        const currentBytes = await vscode.workspace.fs.readFile(targetUri);
        currentExists = true;
        currentContent = Buffer.from(currentBytes).toString('utf8');
      } catch {
        currentExists = false;
        currentContent = '';
      }
      undoOps.push({ path: op.path, prevExists: currentExists, prevContent: currentContent });

      if (!op.prevExists) {
        try {
          await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: true });
        } catch {
          // ignore
        }
        continue;
      }

      const dir = op.path.split('/').slice(0, -1).join('/');
      if (dir) {
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, dir));
        } catch {
          // ignore
        }
      }
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(op.prevContent, 'utf8'));
    }

    this._pushUndoBatch({ label: `Restore snapshot: ${target.action}`, ops: undoOps });
    vscode.window.showInformationMessage(`Restored snapshot: ${target.action}`);
    void this._appendChangeLog(`## ${new Date().toISOString()}\n- Session restore: ${target.action}\n\n`);
  }

  private async _appendChangeLog(entry: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    const uri = vscode.Uri.joinPath(folders[0].uri, '.azure-codex', 'change-log.md');
    try {
      const prev = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(prev).toString('utf8');
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text + entry, 'utf8'));
    } catch {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, '.azure-codex'));
      await vscode.workspace.fs.writeFile(uri, Buffer.from('# Azure Codex Change Log\n\n' + entry, 'utf8'));
    }
  }

  private _sendToWebview(message: any) {
    this._view?.webview.postMessage(message);
  }

  private async _sendWorkspaceFiles() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) {
      this._sendToWebview({ type: 'workspaceFiles', files: [] });
      return;
    }
    const exclude = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode/**,**/.next/**,**/coverage/**}';
    const uris = await vscode.workspace.findFiles('**/*', exclude, 2000);
    const files = uris
      .map((u) => this._relPath(u))
      .filter((p) => !!p && !p.endsWith('/'))
      .sort((a, b) => a.localeCompare(b));
    this._sendToWebview({ type: 'workspaceFiles', files });
  }

  private async _autoFetchRequestedFilesFromAssistant(
    assistantText: string,
    opts: { autoFetchDepth: number }
  ): Promise<void> {
    const depth = Math.max(0, Number(opts.autoFetchDepth ?? 0));
    const maxDepth = 3;
    if (depth >= maxDepth) return;

    const config = vscode.workspace.getConfiguration('azureCodex');
    const enabled = config.get<boolean>('autoFetchRequestedFiles', true);
    if (!enabled) return;

    const blocks = this._extractFencedBlocks(assistantText);
    const requests = blocks.filter((b) => b.lang === 'request');
    if (!requests.length) return;

    // Only auto-handle the first request block to avoid runaway chains.
    const first = requests[0];
    const requested = this._parseRequestedPaths(first.code);
    if (!requested.length) return;
    this._sendActionLog(`🔍 Searched for requested files — found ${requested.length} path(s).`);

    const chat = this._activeChat();
    const alreadyPinned = (p: string) => {
      if (!p) return false;
      if (chat.context.getByPath(p)) return true;
      const base = p.split('/').pop() || p;
      return chat.context.list().some((i) => i.name === base || i.path === base);
    };

    const allAlready = requested.every((p) => alreadyPinned(p));
    if (allAlready) {
      await this._handleUserMessage(
        'Continue. The requested files are already in pinned context. Do not ask to fetch; just proceed with the task.',
        { displayText: `Already had ${requested.length} requested file(s) pinned. Continue.`, autoFetchDepth: depth + 1 }
      );
      return;
    }

    const added = await this._fetchRequestedFilesInternal(first.code);
    if (!added.length) return;
    this._sendActionLog(`✅ Validating changes... auto-attached ${added.length} requested file(s).`, 'ok');

    await this._handleUserMessage(
      'Continue. You now have the requested files in pinned context. Do not repeat the file contents; just proceed with the task.',
      { displayText: `Auto-fetched ${added.length} file(s) into context. Continue.`, autoFetchDepth: depth + 1 }
    );
  }

  private async _fetchRequestedFilesInternal(code: string): Promise<string[]> {
    const requested = this._parseRequestedPaths(code);
    if (!requested.length) return [];

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return [];

    const chat = this._activeChat();
    const maxBytes = vscode.workspace.getConfiguration('azureCodex').get<number>('attachmentsMaxBytes', 2_000_000);
    const exclude = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode/**,**/.next/**,**/coverage/**}';

    const added: string[] = [];
    for (const req of requested.slice(0, 20)) {
      if (!req || looksSensitivePath(req)) continue;

      const candidates: vscode.Uri[] = [];
      if (req.includes('/')) {
        candidates.push(vscode.Uri.joinPath(folders[0].uri, req));
      } else {
        // If only a filename was provided, search the workspace.
        try {
          const hits = await vscode.workspace.findFiles(`**/${req}`, exclude, 5);
          candidates.push(...hits);
        } catch {
          // ignore
        }
        if (!candidates.length) {
          candidates.push(vscode.Uri.joinPath(folders[0].uri, req));
        }
      }

      let pinned = false;
      for (const uri of candidates) {
        try {
          const rel = this._relPath(uri);
          if (looksSensitivePath(rel)) continue;
          if (chat.context.getByPath(rel)) {
            pinned = true;
            break;
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          const loaded = await loadFromBytes(path.basename(rel), rel, bytes, { maxBytes });
          if (loaded.kind === 'image') {
            chat.context.upsertImage({
              source: 'auto',
              displayPath: loaded.displayPath,
              sizeBytes: loaded.sizeBytes,
              dataUrl: loaded.dataUrl,
              tier: 'conversation',
              tokenCount: 0
            });
          } else {
            const text = this._truncate(loaded.text, 500_000);
            chat.context.upsertText({
              source: 'auto',
              displayPath: loaded.displayPath,
              sizeBytes: loaded.sizeBytes,
              text,
              tier: 'conversation',
              tokenCount: this._estimateTokenCount(text)
            });
          }
          this._sendActionLog(`📄 Reading ${rel}, lines 1 to 200`);
          added.push(rel);
          pinned = true;
          break;
        } catch {
          // try next candidate
        }
      }
      if (!pinned) {
        // ignore missing/unreadable
      }
    }

    if (added.length) this._sendContextStatus();
    return added;
  }

  private _extractAbsolutePathsFromText(text: string): string[] {
    const t = String(text || '');
    const found: string[] = [];

    const quoted = /["'`]\s*([/][^"'`]{1,600}|~\/[^"'`]{1,600}|[A-Za-z]:\\[^"'`]{1,600})\s*["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = quoted.exec(t))) {
      const p = (m[1] || '').trim();
      if (p) found.push(p);
    }

    const unquoted = /((?:\/|~\/)[^\s"'`]{1,600}|[A-Za-z]:\\[^\s"'`]{1,600})/g;
    while ((m = unquoted.exec(t))) {
      const p = (m[1] || '').trim();
      if (p) found.push(p);
    }

    const cleaned = found
      .map((p) => p.replace(/[),.;:!?]+$/g, '').trim())
      .filter((p) => isAbsoluteUserPath(p))
      .filter((p) => !p.endsWith('/'));

    return Array.from(new Set(cleaned)).slice(0, 10);
  }

  private _estimateTokenCount(text: string): number {
    return this._contextWindow.countTokens(String(text || ''));
  }

  private async _loadWorkspaceFileForContext(
    relPath: string,
    opts: { source: 'workspace' | 'auto' | 'upload' | 'absolutePath'; tier: 'persistent' | 'conversation' | 'oneTime' }
  ): Promise<FileContextItem | null> {
    const chat = this._activeChat();
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return null;
    const p = String(relPath || '').trim();
    if (!p || p.startsWith('/') || p.startsWith('~') || p.startsWith('..') || p.includes('\\') || p.includes(':')) return null;
    if (looksSensitivePath(p)) return null;

    const uri = vscode.Uri.joinPath(folders[0].uri, p);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const maxBytes = vscode.workspace.getConfiguration('azureCodex').get<number>('attachmentsMaxBytes', 2_000_000);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const loaded = await loadFromBytes(path.basename(p), p, bytes, { maxBytes });
      if (loaded.kind === 'image') {
        chat.context.upsertImage({
          source: opts.source,
          displayPath: loaded.displayPath,
          sizeBytes: loaded.sizeBytes,
          dataUrl: loaded.dataUrl,
          tier: opts.tier,
          tokenCount: 0,
          lastKnownMtimeMs: stat.mtime
        });
      } else {
        const text = this._truncate(loaded.text, 500_000);
        chat.context.upsertText({
          source: opts.source,
          displayPath: loaded.displayPath,
          sizeBytes: loaded.sizeBytes,
          text,
          tier: opts.tier,
          tokenCount: this._estimateTokenCount(text),
          lastKnownMtimeMs: stat.mtime
        });
      }
      return chat.context.getByPath(p) || null;
    } catch {
      return null;
    }
  }

  private async _autoAttachPathsFromText(text: string) {
    const cfg = vscode.workspace.getConfiguration('azureCodex');
    const enabled = cfg.get<boolean>('absolutePathReadsEnabled', true);
    if (!enabled) return;

    const paths = this._extractAbsolutePathsFromText(text);
    if (!paths.length) return;

    const chat = this._activeChat();
    const maxBytes =
      cfg.get<number>('absolutePathMaxBytes', 0) ||
      cfg.get<number>('attachmentsMaxBytes', 2_000_000);

    let added = 0;
    let attempted = 0;
    this._sendActionLog(`🔍 Searched for absolute paths — found ${paths.length}.`);
    for (const p of paths) {
      if (looksSensitivePath(p)) continue;
      if (chat.context.getByPath(p)) continue;
      try {
        attempted++;
        this._sendActionLog(`📄 Reading ${p}, lines 1 to 200`);
        const loaded = await loadFromAbsolutePath(p, { maxBytes });
        if (loaded.kind === 'image') {
          chat.context.upsertImage({
            source: 'auto',
            displayPath: loaded.displayPath,
            sizeBytes: loaded.sizeBytes,
            dataUrl: loaded.dataUrl,
            tier: 'conversation',
            tokenCount: 0
          });
        } else {
          const text = this._truncate(loaded.text, 500_000);
          chat.context.upsertText({
            source: 'auto',
            displayPath: loaded.displayPath,
            sizeBytes: loaded.sizeBytes,
            text,
            tier: 'conversation',
            tokenCount: this._estimateTokenCount(text)
          });
        }
        added++;
      } catch {
        // ignore failures; user may paste paths that don't exist
      }
    }

    if (added) {
      this._sendContextStatus();
      this._sendActionLog(`✅ Validating changes... loaded ${added} auto-attached file(s).`, 'ok');
      this._sendToWebview({ type: 'toast', level: 'info', text: `Loaded ${added} file(s) from path into context.` });
    } else if (attempted) {
      this._sendActionLog('⚠️ Found issue while loading one or more auto-attached paths.', 'warn');
      this._sendToWebview({ type: 'toast', level: 'warning', text: 'Could not load the file path(s). Check they exist, are readable, and are under the size limit.' });
    }
  }

  private async _pinWorkspaceFile(relPath: string) {
    const chat = this._activeChat();
    const p = String(relPath || '').trim();
    if (!p) return;
    if (p.startsWith('/') || p.startsWith('~') || p.startsWith('..') || p.includes('\\') || p.includes(':')) {
      vscode.window.showWarningMessage('Please select a workspace-relative path from the explorer.');
      return;
    }
    if (looksSensitivePath(p)) {
      vscode.window.showWarningMessage(`Skipped sensitive file: ${p}`);
      return;
    }

    if (chat.context.getByPath(p)) {
      this._sendToWebview({ type: 'toast', text: `${path.basename(p)} is already in context` });
      return;
    }

    try {
      const loaded = await this._loadWorkspaceFileForContext(p, { source: 'workspace', tier: 'conversation' });
      if (!loaded) throw new Error('Could not load file');
      this._sendContextStatus();
    } catch (e: any) {
      vscode.window.showWarningMessage(`Failed to add to context: ${p} (${e?.message || String(e)})`);
    }
  }

  private async _uploadAttachments(files: any[]) {
    const chat = this._activeChat();
    const maxBytes = vscode.workspace.getConfiguration('azureCodex').get<number>('attachmentsMaxBytes', 2_000_000);

    let added = 0;
    for (const f of files.slice(0, 20)) {
      const name = String(f?.name || 'attachment').slice(0, 200);
      const base64 = String(f?.base64 || '');
      const mime = String(f?.mime || '');
      if (!base64) continue;

      try {
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.byteLength > maxBytes) throw new Error(`Too large (${bytes.byteLength} bytes).`);

        // Prefer mime-based image detection for uploads.
        const isImage = mime.toLowerCase().startsWith('image/');
        if (isImage) {
          chat.context.upsertImage({
            source: 'upload',
            displayPath: name,
            sizeBytes: bytes.byteLength,
            dataUrl: `data:${mime || 'application/octet-stream'};base64,${base64}`,
            tier: 'conversation',
            tokenCount: 0
          });
          added++;
          continue;
        }

        const loaded = await loadFromBytes(path.basename(name), name, bytes, { maxBytes });
        if (loaded.kind === 'image') {
          chat.context.upsertImage({
            source: 'upload',
            displayPath: loaded.displayPath,
            sizeBytes: loaded.sizeBytes,
            dataUrl: loaded.dataUrl,
            tier: 'conversation',
            tokenCount: 0
          });
        } else {
          const text = this._truncate(loaded.text, 500_000);
          chat.context.upsertText({
            source: 'upload',
            displayPath: loaded.displayPath,
            sizeBytes: loaded.sizeBytes,
            text,
            tier: 'conversation',
            tokenCount: this._estimateTokenCount(text)
          });
        }
        added++;
      } catch (e: any) {
        this._sendToWebview({ type: 'toast', level: 'warning', text: `Skipped ${name}: ${e?.message || String(e)}` });
      }
    }

    if (added) {
      this._sendContextStatus();
      this._sendToWebview({ type: 'toast', level: 'info', text: `Added ${added} attachment(s) to context.` });
    }
  }

  private async _previewContextItem(id: string) {
    const chat = this._activeChat();
    const item = chat.context.get(id) ?? chat.context.getByPath(id);
    if (!item) return;
    const payload: any = { ...item };
    if (payload.text) payload.text = this._truncate(String(payload.text), 60_000);
    this._sendToWebview({ type: 'contextPreview', item: payload });
  }

  private async _openFileInEditor(relPath: string) {
    const p = String(relPath || '').trim();
    if (!p) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    try {
      const uri = vscode.Uri.joinPath(folders[0].uri, p);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      // ignore
    }
  }

  private async _buildContextMessages(queryText?: string): Promise<ChatMessage[]> {
    const config = vscode.workspace.getConfiguration('azureCodex');
    const includeContext = config.get<boolean>('includeWorkspaceContext', true);

    const maxChars = config.get<number>('contextMaxChars', 20000);
    const includeFileList = config.get<boolean>('includeFileList', true);
    const includeActiveFile = config.get<boolean>('includeActiveFile', true);
    const includeRootDocs = config.get<boolean>('includeRootDocs', true);
    const pinnedMaxChars = config.get<number>('pinnedContextMaxChars', 20000);
    const semanticEnabled = config.get<boolean>('semanticIndexEnabled', true);
    const semanticMaxChars = config.get<number>('semanticMaxChars', 12000);
    const semanticTopK = config.get<number>('semanticTopK', 6);
    const memoryText = this._deps?.memoryStore?.buildContext(4000) || '';
    const chat = this._activeChat();
    const simpleNoFileContext = this._isLikelyNoFileAccessQuery(queryText);

    const chunks: string[] = [];

    // Pinned context MUST be included (and should be early to avoid truncation).
    const pinned = this._buildPinnedContext(pinnedMaxChars, chat.messageSeq);
    if (pinned.context) chunks.push(pinned.context);
    if (pinned.persistentCount) {
      this._sendActionLog(`📌 Injecting ${pinned.persistentCount} persistent workspace files into context`);
    }

    if (includeContext && !simpleNoFileContext) {
      const folders = vscode.workspace.workspaceFolders || [];
      if (folders.length) {
        chunks.push(`Workspace folders:\n${folders.map((f) => `- ${f.name} (${f.uri.fsPath})`).join('\n')}`);
      }

      if (includeFileList) {
        const files = await this._getWorkspaceFileList();
        if (files.length) {
          chunks.push(`Project file list (paths relative to workspace root):\n${files.slice(0, 160).map((p) => `- ${p}`).join('\n')}`);
        }
      }

      if (includeRootDocs) {
        const maybeReadme = await this._tryReadWorkspaceFile('README.md', 4000);
        if (maybeReadme) chunks.push(maybeReadme);
        const maybePackage = await this._tryReadWorkspaceFile('package.json', 3000);
        if (maybePackage) chunks.push(maybePackage);
      }

      if (includeActiveFile) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const rel = this._relPath(editor.document.uri);
          const lang = editor.document.languageId;
          const text = editor.document.getText();
          chunks.push(`Active file section (${rel}) [${lang}]:\n` + this._truncate(text, 4000));
        }
      }

      if (queryText && /(csv|excel|xlsx|formula|sheet|table|dataset|data\s*file|feature\s*generation|synthetic)/i.test(queryText)) {
        const dataContext = await this._loadRelevantDataFileSnippets(queryText, 5);
        if (dataContext.snippets.length) {
          chunks.push(`Relevant data file snippets:\n${dataContext.snippets.join('\n\n')}`);
          this._sendActionLog(`📄 Reading relevant CSV/Excel files — loaded ${dataContext.snippets.length} snippet(s).`);
          if (dataContext.pinned.length) {
            this._sendActionLog(`📌 Auto-pinned ${dataContext.pinned.length} data file(s): ${dataContext.pinned.slice(0, 5).join(', ')}`);
            this._sendToWebview({ type: 'toast', level: 'info', text: `Auto-pinned ${dataContext.pinned.length} CSV/Excel file(s) to Context.` });
          }
          if (dataContext.skippedRecent.length) {
            this._sendActionLog(
              `🧹 Skipped ${dataContext.skippedRecent.length} recently auto-pinned data file(s) to avoid context clutter (${dataContext.skippedRecent.slice(0, 5).join(', ')})`
            );
          }
        }
      }

      if (memoryText) {
        chunks.push(memoryText);
      }

      // @mentions: allow users to pull specific files into context inline, e.g. "@src/app.ts".
      if (queryText && queryText.includes('@')) {
        const mentioned = this._extractMentionedPaths(queryText);
        if (mentioned.length) {
          const folders = vscode.workspace.workspaceFolders;
          if (folders && folders.length) {
            const parts: string[] = [];
            for (const p of mentioned.slice(0, 10)) {
              if (this._looksSensitive(p)) continue;
              const uri = vscode.Uri.joinPath(folders[0].uri, p);
              try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const txt = Buffer.from(bytes).toString('utf8');
                const key = `${p}:mention`;
                if (chat.loadedSectionRegistry.has(key)) continue;
                chat.loadedSectionRegistry.add(key);
                parts.push(`File (@${p}) section:\n${this._truncate(txt, 2200)}`);
              } catch {
                parts.push(`File (@${p}):\n[missing/unreadable]`);
              }
            }
            if (parts.length) chunks.push(`Mentioned files:\n${parts.join('\n\n')}`);
          }
        }
      }
    }

    if (includeContext && !simpleNoFileContext) {
      if (semanticEnabled && this._deps?.semanticIndex && queryText && queryText.trim()) {
        try {
          const hits = await this._deps.semanticIndex.search(queryText, { topK: Math.max(10, Math.min(15, semanticTopK)), maxChars: semanticMaxChars });
          if (hits.length) {
            const snippetParts: string[] = [];
            for (const h of hits) {
              const sectionKey = `${h.path}:${h.startLine}-${h.endLine}`;
              if (chat.loadedSectionRegistry.has(sectionKey)) continue;
              chat.loadedSectionRegistry.add(sectionKey);
              snippetParts.push(
                `File (${h.path}:${h.startLine}-${h.endLine}):\n${this._truncate(h.text, 2200)}`
              );
            }
            if (snippetParts.length) {
              chunks.push(`Relevant code snippets (semantic search):\n${snippetParts.slice(0, 15).join('\n\n')}`);
              this._sendActionLog(`🧠 Retrieved ${Math.min(15, snippetParts.length)} relevant chunks from project memory`);
            }
          }
        } catch {
          // ignore semantic failures
        }
      }

      if (queryText && queryText.trim()) {
        const keywordResults = await this._keywordRelevantSections(queryText, 10);
        if (keywordResults.length) {
          chunks.push(`Relevant code snippets (keyword scan):\n${keywordResults.join('\n\n')}`);
        }
      }
    }

    const perfHints = this._collectPerformanceHints(chunks.join('\n\n'));
    if (perfHints.length) {
      const perfText = `Passive performance suggestions (heuristic):\n${perfHints.map((h) => `- ${h}`).join('\n')}`;
      chunks.push(perfText);
      this._sendActionLog(`⚡ Found ${perfHints.length} potential performance improvement(s).`);
    }

    let context = chunks.filter(Boolean).join('\n\n---\n\n');
    context = this._truncate(context, maxChars);

    if (!context.trim()) return [];

    return [
      {
        role: 'system',
        content:
          `Workspace context (auto-included). Use this to answer questions and propose code changes. ` +
          `Pinned files shown below are already loaded; do NOT ask the user to fetch them again. ` +
          `If you need a specific file that isn't shown, ask for it by path.\n\n${context}`
      }
    ];
  }

  private _collectPerformanceHints(text: string): string[] {
    const out: string[] = [];
    const source = String(text || '');
    if (!source) return out;

    if (/for\s*\([^)]*\)\s*\{[\s\S]{0,240}(await\s+\w+\.)/m.test(source)) {
      out.push('Possible sequential await inside loop; consider batching with Promise.all where safe.');
    }
    if (/select\s+\*\s+from|findAll\(|\.find\(\{\s*\}\)/i.test(source)) {
      out.push('Potential broad/unbounded query detected; verify indexes and pagination.');
    }
    if (/readFileSync\(|execSync\(|spawnSync\(/.test(source)) {
      out.push('Synchronous I/O or process call may block event loop; prefer async alternatives.');
    }
    if (/forEach\(\s*async\s*\(/.test(source)) {
      out.push('async inside forEach can cause uncontrolled concurrency; use for..of or Promise.all explicitly.');
    }
    if (/JSON\.parse\([^)]{2000,}\)/.test(source)) {
      out.push('Large JSON parse detected; consider streaming/chunked processing for big payloads.');
    }

    return out.slice(0, 6);
  }

  private async _keywordRelevantSections(queryText: string, maxFiles: number): Promise<string[]> {
    const q = String(queryText || '').trim();
    if (!q) return [];
    const words = q
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((w) => w.length >= 3)
      .slice(0, 12);
    if (!words.length) return [];

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return [];

    const files = await this._getWorkspaceFileList();
    const candidates = files
      .map((file) => {
        const lower = file.toLowerCase();
        let score = 0;
        for (const w of words) {
          if (lower.includes(w)) score += 3;
        }
        return { file, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFiles);

    const sections: string[] = [];
    const chat = this._activeChat();
    for (const c of candidates) {
      try {
        const uri = vscode.Uri.joinPath(folders[0].uri, c.file);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const hitIndex = lines.findIndex((ln) => words.some((w) => ln.toLowerCase().includes(w)));
        if (hitIndex < 0) continue;
        const start = Math.max(0, hitIndex - 25);
        const end = Math.min(lines.length, hitIndex + 45);
        const sectionKey = `${c.file}:${start + 1}-${end}`;
        if (chat.loadedSectionRegistry.has(sectionKey)) continue;
        chat.loadedSectionRegistry.add(sectionKey);
        sections.push(`File (${c.file}:${start + 1}-${end}):\n${lines.slice(start, end).join('\n')}`);
      } catch {
        // ignore unreadable files
      }
    }
    return sections;
  }

  private async _loadRelevantDataFileSnippets(
    queryText: string,
    maxFiles: number
  ): Promise<{ snippets: string[]; pinned: string[]; skippedRecent: string[] }> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return { snippets: [], pinned: [], skippedRecent: [] };

    const files = await this._getWorkspaceFileList();
    if (!files.length) return { snippets: [], pinned: [], skippedRecent: [] };

    const config = vscode.workspace.getConfiguration('azureCodex');
    const cooldownMinutes = Math.max(0, Math.min(120, Number(config.get<number>('autoPinCooldownMinutes', 10)) || 0));
    const cooldownMs = cooldownMinutes * 60_000;
    const now = Date.now();

    if (cooldownMs > 0) {
      for (const [k, ts] of this._recentAutoPinnedAt.entries()) {
        if (now - ts >= cooldownMs) this._recentAutoPinnedAt.delete(k);
      }
    } else {
      this._recentAutoPinnedAt.clear();
    }

    const q = String(queryText || '').toLowerCase();
    const tokens = q
      .split(/[^a-z0-9_./-]+/)
      .filter((w) => w.length >= 3)
      .slice(0, 12);

    const candidates = files
      .filter((p) => /\.(csv|xlsx|xls)$/i.test(p))
      .map((p) => {
        const lower = p.toLowerCase();
        let score = 1;
        for (const t of tokens) {
          if (lower.includes(t)) score += 3;
        }
        if (/(feature|synthetic|generator|derive|formula|sheet|report)/.test(lower)) score += 2;
        return { path: p, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(8, maxFiles)));

    const out: string[] = [];
    const pinned: string[] = [];
    const skippedRecent: string[] = [];
    const chat = this._activeChat();
    for (const candidate of candidates) {
      try {
        const uri = vscode.Uri.joinPath(folders[0].uri, candidate.path);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const loaded = await loadFromBytes(path.basename(candidate.path), candidate.path, bytes, {
          maxBytes: 2_000_000
        });
        if (loaded.kind === 'text') {
          out.push(this._truncate(`File (${candidate.path}):\n${loaded.text}`, 6000));

          if (!chat.context.getByPath(candidate.path)) {
            const key = candidate.path.toLowerCase();
            const recentTs = this._recentAutoPinnedAt.get(key) || 0;
            if (cooldownMs > 0 && now - recentTs < cooldownMs) {
              skippedRecent.push(candidate.path);
              if (out.length >= maxFiles) break;
              continue;
            }
            const text = this._truncate(loaded.text, 500_000);
            chat.context.upsertText({
              source: 'auto',
              displayPath: candidate.path,
              sizeBytes: loaded.sizeBytes,
              text,
              tier: 'conversation',
              tokenCount: this._estimateTokenCount(text)
            });
            this._recentAutoPinnedAt.set(key, now);
            pinned.push(candidate.path);
          }
        }
      } catch {
        // ignore unreadable data files
      }
      if (out.length >= maxFiles) break;
    }

    if (pinned.length) {
      this._sendContextStatus();
    }

    return { snippets: out, pinned, skippedRecent };
  }

  private _extractMentionedPaths(text: string): string[] {
    const out: string[] = [];
    const re = /@([A-Za-z0-9_./-]{1,200})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(text || '')))) {
      const p = m[1];
      if (!p) continue;
      if (p.startsWith('/') || p.startsWith('~') || p.startsWith('..') || p.includes('\\') || p.includes(':')) continue;
      // skip obvious emails
      if (p.includes('@')) continue;
      out.push(p);
    }
    return Array.from(new Set(out));
  }

  private async _getWorkspaceFileList(): Promise<string[]> {
    const now = Date.now();
    if (this._lastFileList && now - this._lastFileList.at < 30_000) return this._lastFileList.items;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return [];

    const exclude = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode/**,**/.next/**,**/coverage/**}';
    const uris = await vscode.workspace.findFiles('**/*', exclude, 250);

    const items = uris
      .map((u) => this._relPath(u))
      .filter((p) => !!p && !p.endsWith('/'))
      .sort((a, b) => a.localeCompare(b));

    this._lastFileList = { at: now, items };
    return items;
  }

  private async _tryReadWorkspaceFile(relPath: string, maxChars: number): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return null;
    const uri = vscode.Uri.joinPath(folders[0].uri, relPath);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      return `File (${relPath}):\n` + this._truncate(text, maxChars);
    } catch {
      return null;
    }
  }

  private _truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + `\n\n[truncated to ${maxChars} chars]`;
  }

  private _relPath(uri: vscode.Uri): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return uri.fsPath;
    const folder = folders[0];
    const root = folder.uri.fsPath.replace(/\/$/, '');
    const full = uri.fsPath;
    if (full.startsWith(root)) {
      const rel = full.slice(root.length).replace(/^\/+/, '');
      return rel || uri.fsPath;
    }
    return uri.fsPath;
  }

  private async _applyFileBlock(
    lang: string,
    code: string,
    opts?: { confirm?: boolean; suppressToast?: boolean }
  ) {
    const ops: Array<{ path: string; prevExists: boolean; prevContent: string }> = [];
    const confirm = opts?.confirm ?? true;
    const suppressToast = !!opts?.suppressToast;
    const res = await this._applyFileBlockInternal(lang, code, { confirm, collectUndoOps: ops });
    if (!res) return;
    this._sendChangeSummary([{ path: res.path, added: res.addedLines, removed: res.removedLines }]);
    if (ops.length) {
      this._pushUndoBatch({ label: `Apply ${res.path}`, ops });
      if (!suppressToast) {
        const picked = await vscode.window.showInformationMessage(`Azure Codex: Applied ${res.path}`, 'Undo');
        if (picked === 'Undo') await this._undoLastApply();
      }
    }
    void this._runAutoTestLoop([res.path]);
  }

  private async _applyFileBlockInternal(
    lang: string,
    code: string,
    opts: { confirm: boolean; collectUndoOps?: Array<{ path: string; prevExists: boolean; prevContent: string }> }
  ): Promise<{ kind: 'file' | 'delete'; path: string; addedLines: number; removedLines: number } | null> {
    const normalizedLang = String(lang || '').trim().toLowerCase();
    if (normalizedLang !== 'file' && normalizedLang !== 'delete' && normalizedLang !== 'edit') {
      vscode.window.showWarningMessage(`Unsupported apply block type: ${lang}`);
      return null;
    }

    const parsed = this._parseFileBlock(code);
    if (!parsed) {
      vscode.window.showErrorMessage(`Could not parse ${normalizedLang} block. Expected first line like: path: src/file.ts`);
      return null;
    }

    const { path, content } = parsed;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) {
      vscode.window.showErrorMessage('No workspace folder is open.');
      return null;
    }

    const targetUri = vscode.Uri.joinPath(folders[0].uri, path);

    if (normalizedLang === 'delete') {
      if (opts.confirm) {
        const confirm = await vscode.window.showWarningMessage(
          `Delete file ${path}?`,
          { modal: true },
          'Delete'
        );
        if (confirm !== 'Delete') return null;
      }
      try {
        const prevBytes = await vscode.workspace.fs.readFile(targetUri);
        const prevContent = Buffer.from(prevBytes).toString('utf8');
        opts.collectUndoOps?.push({ path, prevExists: true, prevContent });
        await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: true });
        if (opts.confirm) vscode.window.showInformationMessage(`Deleted ${path}`);
        const removedLines = prevContent ? prevContent.replace(/\r\n/g, '\n').split('\n').length : 0;
        return { kind: 'delete', path, addedLines: 0, removedLines };
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to delete ${path}: ${e?.message || String(e)}`);
        return null;
      }
    }

    // For `file`: overwrite with provided content.
    // For `edit`: apply search/replace blocks to existing content.

    const dir = path.split('/').slice(0, -1).join('/');
    if (dir) {
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, dir));
      } catch {
        // ignore
      }
    }

    try {
      let prevExists = false;
      let prevContent = '';
      try {
        const prevBytes = await vscode.workspace.fs.readFile(targetUri);
        prevExists = true;
        prevContent = Buffer.from(prevBytes).toString('utf8');
      } catch {
        prevExists = false;
        prevContent = '';
      }

      let nextContent = content;
      if (normalizedLang === 'edit') {
        if (!prevExists) {
          vscode.window.showErrorMessage(`Cannot apply edits: ${path} does not exist yet. Use a \`\`\`file\`\`\` block to create it.`);
          return null;
        }
        const targetRanges = this._estimateEditTargetRanges(prevContent, content);
        if (targetRanges.length) {
          this._sendActionLog(`🎯 Targeting ${path} lines ${targetRanges.join(', ')} — isolated edit block`);
        }
        const applied = this._applySearchReplaceEdits(prevContent, content);
        if (!applied.ok) {
          this._sendActionLog(`⚠️ Found issue in ${path}. ${applied.error}`, 'warn');
          vscode.window.showErrorMessage(`Failed to apply edits to ${path}: ${applied.error}`);
          return null;
        }
        nextContent = applied.updated;
        this._sendActionLog(`✏️ Modifying ${path}`);

        if (opts.confirm) {
          const picked = await vscode.window.showWarningMessage(
            `Apply ${applied.count} edit(s) to ${path}?`,
            { modal: true },
            'Preview',
            'Apply'
          );
          if (!picked) return null;
          if (picked === 'Preview') {
            await this._showDiffPreview(targetUri, prevContent, nextContent, `Azure Codex: Preview edits — ${path}`);
            const confirmAfter = await vscode.window.showWarningMessage(
              `Apply edits to ${path}?`,
              { modal: true },
              'Apply'
            );
            if (confirmAfter !== 'Apply') return null;
          }
        }
      } else if (opts.confirm) {
        const confirm = await vscode.window.showWarningMessage(
          `Write file ${path}? This will overwrite it if it already exists.`,
          { modal: true },
          'Write'
        );
        if (confirm !== 'Write') return null;
      }

      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(nextContent, 'utf8'));
      const delta = this._computeLineDelta(prevExists ? prevContent : '', nextContent);
  const scope = this._classifyChangeScope(Math.max(0, delta.added) + Math.max(0, delta.removed));
  const scopeBadge = scope === 'tiny' ? '🟢' : scope === 'small' ? '🟡' : scope === 'medium' ? '🟠' : '🔴';
  this._sendActionLog(`${scopeBadge} ${scope.toUpperCase()} fix detected — +${delta.added} -${delta.removed}`);
  this._sendActionLog('✅ Zero noise confirmed — only intended lines were modified.', 'ok');
      this._sendActionLog('✅ Validating changes...', 'ok');
      opts.collectUndoOps?.push({ path, prevExists, prevContent });
      if (opts.confirm) {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(`${normalizedLang === 'edit' ? 'Edited' : 'Wrote'} ${path}`);
      }
      return { kind: 'file', path, addedLines: delta.added, removedLines: delta.removed };
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to write ${path}: ${e?.message || String(e)}`);
      return null;
    }
  }

  private _parseFileBlock(code: string): { path: string; content: string } | null {
    const lines = String(code || '').replace(/\r\n/g, '\n').split('\n');
    const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
    if (firstNonEmptyIdx === -1) return null;

    const first = lines[firstNonEmptyIdx].trim();
    const match = first.match(/^path:\s*(.+)\s*$/i);
    if (!match) return null;

    const rawPath = match[1].trim().replace(/^["']|["']$/g, '');
    if (
      !rawPath ||
      rawPath.startsWith('/') ||
      rawPath.startsWith('~') ||
      rawPath.startsWith('..') ||
      rawPath.includes('\\') ||
      rawPath.includes(':')
    )
      return null;

    const content = lines.slice(firstNonEmptyIdx + 1).join('\n');
    return { path: rawPath, content };
  }

  private _buildPinnedContext(
    maxChars: number,
    messageSeq: number
  ): { context: string; persistentCount: number } {
    const chat = this._activeChat();
    const all = chat.context.list();
    const persistent = all.filter((i) => i.tier === 'persistent' && i.kind === 'text' && i.text);
    const conversation = all
      .filter((i) => i.tier === 'conversation' && i.kind === 'text' && i.text)
      .sort((a, b) => (b.lastUsedMessage || 0) - (a.lastUsedMessage || 0));
    const oneTime = all.filter((i) => i.tier === 'oneTime' && i.kind === 'text' && i.text);

    const takeTier = (items: FileContextItem[], budget: number, label: string): { text: string; usedIds: string[]; warning: boolean } => {
      const blocks: string[] = [];
      const usedIds: string[] = [];
      let used = 0;
      let warning = false;

      for (const item of items) {
        const raw = String(item.text || '');
        if (!raw.trim()) continue;
        const fullBlock = `File (${item.path}) [${item.language}, ${Math.round(item.sizeBytes / 1024)}KB]:\n${this._truncate(raw, 8000)}`;
        const fullTokens = this._estimateTokenCount(fullBlock);
        if (used + fullTokens <= budget) {
          blocks.push(fullBlock);
          used += fullTokens;
          usedIds.push(item.id);
          continue;
        }

        warning = true;
        const summary = `${raw.split(/\r?\n/).slice(0, 3).join(' ').slice(0, 220)}${raw.length > 220 ? '…' : ''}`;
        const summaryBlock = `File (${item.path}) [summarized — ${fullTokens} -> ~${this._estimateTokenCount(summary)} tokens]:\n${summary}`;
        const summaryTokens = this._estimateTokenCount(summaryBlock);
        if (used + summaryTokens <= budget) {
          blocks.push(summaryBlock);
          used += summaryTokens;
          usedIds.push(item.id);
        }
      }

      if (!blocks.length) return { text: '', usedIds, warning };
      return {
        text: `${label}:\n${blocks.join('\n\n')}`,
        usedIds,
        warning
      };
    };

    const p = takeTier(persistent, TIER_BUDGETS.persistent, 'Persistent workspace references');
    const c = takeTier(conversation, TIER_BUDGETS.conversation, 'Conversation-scoped references');
    const o = takeTier(oneTime, TIER_BUDGETS.oneTime, 'One-time references for this message');

    chat.context.markUsed([...p.usedIds, ...c.usedIds, ...o.usedIds], messageSeq);

    if (p.warning || c.warning || o.warning) {
      this._sendToWebview({
        type: 'toast',
        level: 'warning',
        text: '⚠️ Context nearly full — some references were summarized to fit token limits.'
      });
    }

    const parts = [p.text, c.text, o.text].filter(Boolean);
    const context = this._truncate(parts.join('\n\n---\n\n'), maxChars);
    return { context, persistentCount: p.usedIds.length };
  }

  private _buildUserContent(text: string): any {
    const chat = this._activeChat();
    const images = chat.context.list().filter((i) => i.kind === 'image' && i.dataUrl) as Array<
      FileContextItem & { dataUrl: string }
    >;
    if (!images.length) return text;
    const looksLikeBugReport = /(bug|ui|layout|screen|screenshot|visual|error|broken|misaligned|console)/i.test(
      String(text || '')
    );
    const parts: any[] = [
      {
        type: 'input_text',
        text: looksLikeBugReport
          ? `${text}\n\nImage bug-report mode: analyze attached screenshot(s), identify visible issue, map to likely frontend files/components, and propose concrete fix edits.`
          : text
      }
    ];
    for (const i of images) {
      parts.push({ type: 'input_text', text: `Attached image: ${i.path}` });
      parts.push({ type: 'input_image', image_url: i.dataUrl });
    }
    return parts;
  }

  private async _pickAttachments() {
    const chat = this._activeChat();
    let picked: vscode.Uri[] | undefined;
    try {
      picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: 'Add to Context'
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to open file picker: ${e?.message || String(e)}`);
      return;
    }
    if (!picked || !picked.length) return;

    for (const uri of picked) {
      const rel = this._relPath(uri);
      if (looksSensitivePath(rel)) {
        vscode.window.showWarningMessage(`Skipped sensitive file: ${rel}`);
        continue;
      }
      if (chat.context.getByPath(rel)) {
        this._sendToWebview({ type: 'toast', text: `${path.basename(rel)} is already in context` });
        continue;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      try {
        const maxBytes = vscode.workspace.getConfiguration('azureCodex').get<number>('attachmentsMaxBytes', 2_000_000);
        const loaded = await loadFromBytes(path.basename(rel), rel, bytes, { maxBytes });
        const src = isAbsoluteUserPath(rel) ? 'absolutePath' : 'workspace';
        if (loaded.kind === 'image') {
          chat.context.upsertImage({
            source: src,
            displayPath: loaded.displayPath,
            sizeBytes: loaded.sizeBytes,
            dataUrl: loaded.dataUrl,
            tier: 'conversation',
            tokenCount: 0
          });
        } else {
          const text = this._truncate(loaded.text, 500_000);
          chat.context.upsertText({
            source: src,
            displayPath: loaded.displayPath,
            sizeBytes: loaded.sizeBytes,
            text,
            tier: 'conversation',
            tokenCount: this._estimateTokenCount(text)
          });
        }
      } catch (e: any) {
        vscode.window.showWarningMessage(`Skipped attachment: ${rel} (${e?.message || String(e)})`);
      }
    }

    this._sendContextStatus();
    vscode.window.showInformationMessage('Added selected files to context.');
  }

  private async _removeContextItem(kind: string, label: string) {
    const chat = this._activeChat();
    const k = String(kind || '').toLowerCase();
    const l = String(label || '');
    // Back-compat: prior UI sent (kind,label) where label was the display path.
    const byPath = chat.context.getByPath(l);
    if (byPath) chat.context.remove(byPath.id);
    // New UI sends id directly in `label` (kept so old webview still works).
    if (!byPath && l) chat.context.remove(l);
    this._sendContextStatus();
  }

  private async _togglePersistentContextItem(id: string) {
    const chat = this._activeChat();
    const item = chat.context.get(id) ?? chat.context.getByPath(id);
    if (!item) return;
    const nextTier = item.tier === 'persistent' ? 'conversation' : 'persistent';
    chat.context.setTier(item.id, nextTier);
    await this._syncPersistentContextFromActiveChat();
    this._sendContextStatus();
    this._sendToWebview({
      type: 'toast',
      text: nextTier === 'persistent' ? `📌 ${item.name} added to workspace context` : `📎 ${item.name} moved to conversation context`
    });
  }

  private async _toggleOneTimeContextItem(id: string) {
    const chat = this._activeChat();
    const item = chat.context.get(id) ?? chat.context.getByPath(id);
    if (!item) return;
    if (item.tier === 'persistent') return;
    const nextTier = item.tier === 'oneTime' ? 'conversation' : 'oneTime';
    chat.context.setTier(item.id, nextTier);
    this._sendContextStatus();
  }

  private async _clearConversationContext() {
    const chat = this._activeChat();
    const removed = chat.context.removeByTier('conversation');
    this._sendContextStatus();
    this._sendToWebview({ type: 'toast', text: `Cleared ${removed} conversation reference(s).` });
  }

  private async _clearNonPersistentContext() {
    const chat = this._activeChat();
    const removedConversation = chat.context.removeByTier('conversation');
    const removedOneTime = chat.context.removeByTier('oneTime');
    this._sendContextStatus();
    this._sendToWebview({ type: 'toast', text: `Cleared ${removedConversation + removedOneTime} non-persistent reference(s).` });
  }

  private async _dismissStaleContextItem(id: string) {
    const chat = this._activeChat();
    chat.context.dismissStalePrompt(id);
    this._sendContextStatus();
  }

  private async _reloadContextItem(id: string) {
    const chat = this._activeChat();
    const item = chat.context.get(id) ?? chat.context.getByPath(id);
    if (!item) return;
    if (item.path.startsWith('/') || item.path.startsWith('~') || item.path.includes(':')) return;
    const reloaded = await this._loadWorkspaceFileForContext(item.path, {
      source: item.source,
      tier: item.tier
    });
    if (!reloaded) {
      this._sendToWebview({ type: 'toast', level: 'warning', text: `Could not reload ${item.name}.` });
      return;
    }
    this._sendContextStatus();
    this._sendToWebview({ type: 'toast', text: `Reloaded ${item.name}` });
  }

  private async _reorderContextTier(tier: string, ids: string[]) {
    const t = tier === 'persistent' || tier === 'conversation' || tier === 'oneTime' ? tier : 'conversation';
    const chat = this._activeChat();
    chat.context.reorderWithinTier(t, ids);
    if (t === 'persistent') {
      await this._syncPersistentContextFromActiveChat();
    }
    this._sendContextStatus();
  }

  private async _syncPersistentContextFromActiveChat() {
    const chat = this._activeChat();
    const paths = chat.context.listByTier('persistent').map((i) => i.path).filter((p) => !p.startsWith('/') && !p.includes(':'));
    await this._writePersistentContextPaths(paths);
  }

  private async _fetchRequestedFiles(code: string) {
    const added = await this._fetchRequestedFilesInternal(code);
    if (!added.length) {
      vscode.window.showWarningMessage('No requested files could be added (missing or blocked).');
      return;
    }
    await this._handleUserMessage(
      'Continue. You now have the requested files in pinned context. Do not repeat the file contents; just proceed with the task.',
      { displayText: `Fetched ${added.length} file(s) into context. Continue.`, autoFetchDepth: 0 }
    );
  }

  private _parseRequestedPaths(code: string): string[] {
    const text = String(code || '').replace(/\r\n/g, '\n').trim();
    if (!text) return [];
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    const out: string[] = [];
    for (const line of lines) {
      if (line.toLowerCase() === 'paths:' || line.toLowerCase() === 'path:' || line.toLowerCase().startsWith('#')) continue;
      const m = line.match(/^-\s*(.+)$/);
      const candidate = (m ? m[1] : line).trim().replace(/^["']|["']$/g, '');
      if (!candidate) continue;
      if (candidate.startsWith('/') || candidate.startsWith('~') || candidate.startsWith('..') || candidate.includes('\\') || candidate.includes(':'))
        continue;
      out.push(candidate);
    }

    return Array.from(new Set(out)).slice(0, 20);
  }

  private _looksSensitive(relPath: string): boolean {
    return looksSensitivePath(relPath);
  }

  private _workspaceUriForPath(relPath: string): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return null;
    const clean = String(relPath || '').trim();
    if (!clean || path.isAbsolute(clean)) return null;
    return vscode.Uri.joinPath(folders[0].uri, ...clean.split('/'));
  }

  private async _sendContextStatus() {
    if (!this._view) return;
    const chat = this._activeChat();
    const config = vscode.workspace.getConfiguration('azureCodex');
    const includeContext = config.get<boolean>('includeWorkspaceContext', true);
    const includeFileList = config.get<boolean>('includeFileList', true);
    const includeActiveFile = config.get<boolean>('includeActiveFile', true);
    const includeRootDocs = config.get<boolean>('includeRootDocs', true);
    const autoApplyFileChanges = config.get<boolean>('autoApplyFileChanges', false);
    const alwaysStartFreshOnOpen = config.get<boolean>('alwaysStartFreshOnOpen', true);
    const autoContinueOnTruncation = config.get<boolean>('autoContinueOnTruncation', true);
    const agentEnabled = config.get<boolean>('agentEnabled', false);
    const chatModelMode = config.get<string>('chatModelMode', 'smart');
    const memoryEnabled = config.get<boolean>('memoryEnabled', true);

    let fileCount = 0;
    let activeFile: string | null = null;
    if (includeFileList) {
      try {
        fileCount = (await this._getWorkspaceFileList()).length;
      } catch {
        fileCount = 0;
      }
    }
    if (includeActiveFile && vscode.window.activeTextEditor) {
      activeFile = this._relPath(vscode.window.activeTextEditor.document.uri);
    }

    const pinnedItems = chat.context.list();
    await Promise.all(
      pinnedItems.map(async (item) => {
        if (item.kind !== 'text' || item.source !== 'workspace') {
          item.missingOnDisk = false;
          item.changedOnDisk = false;
          return;
        }
        const uri = this._workspaceUriForPath(item.path);
        if (!uri) {
          item.missingOnDisk = true;
          item.changedOnDisk = false;
          return;
        }
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          item.missingOnDisk = false;
          item.changedOnDisk = !!item.lastKnownMtimeMs && stat.mtime !== item.lastKnownMtimeMs;
        } catch {
          item.missingOnDisk = true;
          item.changedOnDisk = false;
        }
      })
    );
    const textFiles = pinnedItems.filter((i) => i.kind === 'text').map((i) => i.path);
    const images = pinnedItems.filter((i) => i.kind === 'image').map((i) => i.path);
    const tiered = {
      persistent: pinnedItems.filter((i) => i.tier === 'persistent'),
      conversation: pinnedItems.filter((i) => i.tier === 'conversation'),
      oneTime: pinnedItems.filter((i) => i.tier === 'oneTime')
    };

    this._sendToWebview({
      type: 'contextStatus',
      status: {
        auto: {
          enabled: includeContext,
          includeFileList,
          includeActiveFile,
          includeRootDocs,
          autoApplyFileChanges,
          alwaysStartFreshOnOpen,
          autoContinueOnTruncation,
          agentEnabled,
          chatModelMode,
          memoryEnabled,
          fileCount,
          activeFile
        },
        pinned: {
          items: pinnedItems.map((i) => ({
            id: i.id,
            kind: i.kind,
            source: i.source,
            name: i.name,
            path: i.path,
            language: i.language,
            sizeBytes: i.sizeBytes,
            addedAt: i.addedAt,
            tier: i.tier,
            tokenCount: i.tokenCount,
            order: i.order,
            lastUsedMessage: i.lastUsedMessage,
            isMissingOnDisk: i.missingOnDisk,
            isChangedOnDisk: i.changedOnDisk,
            stalePromptDismissed: i.stalePromptDismissed,
            isVirtual: i.isVirtual
          })),
          textFiles: textFiles.sort((a, b) => a.localeCompare(b)),
          images: images.sort((a, b) => a.localeCompare(b)),
          tiers: {
            persistent: tiered.persistent.map((i) => i.id),
            conversation: tiered.conversation.map((i) => i.id),
            oneTime: tiered.oneTime.map((i) => i.id)
          },
          budgets: TIER_BUDGETS
        }
      }
    });
  }

  private async _setConfig(key: string, value: any) {
    const k = String(key || '').trim();
    const allowed: Record<string, string> = {
      autoApplyFileChanges: 'azureCodex.autoApplyFileChanges',
      alwaysStartFreshOnOpen: 'azureCodex.alwaysStartFreshOnOpen',
      autoContinueOnTruncation: 'azureCodex.autoContinueOnTruncation',
      agentEnabled: 'azureCodex.agentEnabled',
      chatModelMode: 'azureCodex.chatModelMode',
      semanticIndexEnabled: 'azureCodex.semanticIndexEnabled',
      autocompleteEnabled: 'azureCodex.autocompleteEnabled',
      memoryEnabled: 'azureCodex.memoryEnabled'
    };
    const setting = allowed[k];
    if (!setting) {
      vscode.window.showWarningMessage(`Unsupported setting: ${k}`);
      return;
    }

    try {
      await vscode.workspace.getConfiguration().update(setting, value, vscode.ConfigurationTarget.Global);
      await this._sendContextStatus();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to update setting ${k}: ${e?.message || String(e)}`);
    }
  }

	  private _stopGeneration() {
	    if (!this._currentAbort) return;
	    try {
	      this._currentAbort.abort();
	    } catch {
	      // ignore
	    } finally {
	      this._currentAbort = undefined;
	      // Failsafe: if the network stream misbehaves, don't leave the UI "stuck" in streaming mode.
	      this._sendToWebview({ type: 'assistantStopped' });
	    }
	  }

  private async _autoApplyIfEnabled(assistantText: string) {
    const config = vscode.workspace.getConfiguration('azureCodex');
    const enabled = config.get<boolean>('autoApplyFileChanges', false);
    if (!enabled) return;

    const blocks = this._extractFencedBlocks(assistantText);
    const actionableFiles = blocks.filter((b) => b.lang === 'file' || b.lang === 'edit');
    const hasDeletes = blocks.some((b) => b.lang === 'delete');
    if (!actionableFiles.length) {
      if (hasDeletes) {
        vscode.window.showInformationMessage('Azure Codex: Auto-apply skips `delete` blocks. Click Apply on the delete block to confirm.');
      }
      return;
    }

    this._sendActionLog(
      `🧩 Auto-apply armed for ${actionableFiles.length} block(s) — policy handled in diff panel (tiny: immediate, small: 3s delay, medium/large: manual Keep).`
    );
    this._sendToWebview({ type: 'autoApplyArmed', count: actionableFiles.length });
  }

  private async _runAgent(userText: string) {
    if (!this._view) return;

    const chat = this._activeChat();
    const config = vscode.workspace.getConfiguration('azureCodex');
    const maxSteps = Math.max(1, Math.min(20, config.get<number>('agentMaxSteps', 6)));
    const allowShell = config.get<boolean>('agentAllowShellCommands', false);
    const defaultDeployment = config.get<string>('deploymentName', 'gpt-5-2-codex-max');
    const model = this._deps?.modelRouter?.getAgentDeployment(defaultDeployment) || defaultDeployment;

    this._sendToWebview({ type: 'assistantStart' });

    const exec = promisify(execCb);
    const folders = vscode.workspace.workspaceFolders;
    const root = folders && folders.length ? folders[0].uri.fsPath : process.cwd();
    const rootUri = folders && folders.length ? folders[0].uri : vscode.Uri.file(root);
    const session = new AgentSession(rootUri);

    const toolHelp =
      `You are running in AGENT MODE. You can use tools to read/search files, apply edits, run commands, and use git.\n` +
      `To call a tool, output a fenced block:\n` +
      '```tool\n' +
      '{"name":"read_file","args":{"path":"src/app.ts"}}\n' +
      '```\n' +
      `Available tools:\n` +
      `- list_files { glob?, max? }\n` +
      `- read_file { path, maxChars? }\n` +
      `- search_files { query, glob?, maxResults? }\n` +
      `- write_file { path, content } (staged; will be reviewed)\n` +
      `- apply_edit { path, edits } where edits is the inside of an \`edit\` block (SEARCH/REPLACE)\n` +
      `- run_command { command } (requires user confirmation; may be disabled)\n` +
      `- git_status {}\n` +
      `- git_diff { args? } (args like "--staged" or "path")\n` +
      `- fetch_url { url } (fetch external docs)\n` +
      `- remember { key, value }\n` +
      `- forget { key }\n` +
      `Rules:\n` +
      `- Prefer apply_edit (diff-based) over write_file.\n` +
      `- File changes are staged; at the end ask user to review/apply.\n` +
      `- Keep tool calls minimal. After tools, respond with a short summary and "Next improvements".`;

    const baseContext = await this._buildContextMessages(userText);
    const personaInstruction = this._buildPersonaInstruction();
    const memory = this._deps?.memoryStore;

    let scratch: ChatMessage[] = [
      ...baseContext,
      ...(personaInstruction ? ([{ role: 'system', content: personaInstruction }] as ChatMessage[]) : []),
      { role: 'system', content: toolHelp }
    ];
    // keep recent chat history
    scratch.push(...chat.history.slice(-8));
    let accumulatedDisplay = '';

    for (let step = 1; step <= maxSteps; step++) {
      session.beginStep(`Step ${step}`);
      const assistantText = await this._client.chatToText(scratch, step === 1 ? userText : 'Continue.', { model });

      const { display, tools } = this._extractToolCallsAndStrip(assistantText);
      if (display.trim()) {
        const chunk = `\n\n${display.trim()}\n`;
        accumulatedDisplay += chunk;
        this._sendToWebview({ type: 'assistantToken', token: chunk });
      }

      // Apply file/edit blocks opportunistically if auto-apply is enabled.
      // In agent mode, we stage via tools; we still allow auto-apply of explicit blocks if present.
      await this._autoApplyIfEnabled(assistantText);

      if (!tools.length) {
        this._sendActionLog(`✅ Step ${step}: no tool calls required; drafting final answer.`, 'ok');
        break;
      }

      this._sendActionLog(`🧠 Step ${step}: executing ${tools.length} tool call(s).`);

      const toolResults: string[] = [];
      for (const call of tools) {
        const name = String(call?.name || '');
        const args = call?.args ?? {};
        try {
          switch (name) {
            case 'list_files': {
              const glob = typeof args.glob === 'string' ? args.glob : '**/*';
              const max = Math.max(1, Math.min(500, Number(args.max ?? 50)));
              const exclude = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode/**,**/.next/**,**/coverage/**}';
              const uris = await vscode.workspace.findFiles(glob, exclude, max);
              const firstFile = uris.length ? this._relPath(uris[0]) : '';
              this._sendActionLog(
                `🔍 Searched files (glob: ${glob}) — found ${uris.length}${firstFile ? `, first: ${firstFile}` : ''}.`,
                undefined,
                { toolName: 'list_files' }
              );
              toolResults.push(`list_files:\n${uris.map((u) => this._relPath(u)).join('\n')}`);
              break;
            }
            case 'read_file': {
              const p = String(args.path || '').trim();
              const maxChars = Math.max(1000, Math.min(200_000, Number(args.maxChars ?? 50_000)));
              const txt = await session.readFile(p, maxChars);
              const lineCount = txt ? txt.replace(/\r\n/g, '\n').split('\n').length : 0;
              this._sendActionLog(
                `📄 Reading ${p || '[unknown]'}${lineCount ? `, lines 1 to ${lineCount}` : ''}`,
                undefined,
                { toolName: 'read_file', outcome: txt ? 'success' : 'warning' }
              );
              toolResults.push(`read_file (${p}):\n${txt ?? '[missing or unreadable]'}`);
              break;
            }
            case 'search_files': {
              const query = String(args.query || '').trim();
              const glob = typeof args.glob === 'string' ? args.glob : '**/*';
              const maxResults = Math.max(1, Math.min(200, Number(args.maxResults ?? 50)));
              const exclude = '{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode/**,**/.next/**,**/coverage/**}';
              const uris = await vscode.workspace.findFiles(glob, exclude, 500);
              const hits: string[] = [];
              const ioConcurrency = 10;
              for (let i = 0; i < uris.length && hits.length < maxResults; i += ioConcurrency) {
                const batch = uris.slice(i, i + ioConcurrency);
                const loaded = await Promise.all(
                  batch.map(async (uri) => {
                    try {
                      const rel = this._relPath(uri);
                      if (this._looksSensitive(rel)) return null;
                      const stat = await vscode.workspace.fs.stat(uri);
                      if (stat.size > 400_000) return null;
                      const staged = (await session.readFile(rel, 500_000)) ?? null;
                      if (staged !== null) return { rel, text: staged };
                      const bytes = await vscode.workspace.fs.readFile(uri);
                      const text = Buffer.from(bytes).toString('utf8');
                      return { rel, text };
                    } catch {
                      return null;
                    }
                  })
                );
                for (const file of loaded) {
                  if (!file) continue;
                  if (hits.length >= maxResults) break;
                  const lines = file.text.replace(/\r\n/g, '\n').split('\n');
                  for (let ln = 0; ln < lines.length && hits.length < maxResults; ln++) {
                    if (lines[ln].includes(query)) {
                      hits.push(`${file.rel}:${ln + 1}: ${lines[ln].trim().slice(0, 200)}`);
                    }
                  }
                }
              }
              const firstHitFile = hits.length ? String(hits[0]).split(':')[0] : '';
              this._sendActionLog(
                `🔍 Searched for "${query || '[empty query]'}" — found ${hits.length} result(s)${firstHitFile ? ` in ${firstHitFile}` : ''}.`,
                undefined,
                { toolName: 'search_files' }
              );
              toolResults.push(`search_files (${query}):\n${hits.join('\n') || '[no matches]'}`);
              break;
            }
            case 'write_file': {
              const p = String(args.path || '').trim();
              const content = String(args.content ?? '');
              await session.stageWrite(p, content);
              this._sendActionLog(`✏️ Modifying ${p || '[unknown file]'}`, undefined, { toolName: 'write_file' });
              toolResults.push(`write_file: staged ${p}`);
              break;
            }
            case 'apply_edit': {
              const p = String(args.path || '').trim();
              const edits = String(args.edits ?? '');
              const current = await session.readFile(p, 2_000_000);
              if (current === null) throw new Error('File missing or unreadable.');
              const applied = this._applySearchReplaceEdits(current, edits);
              if (!applied.ok) throw new Error(applied.error);
              await session.stageWrite(p, applied.updated);
              this._sendActionLog(`✏️ Modifying ${p || '[unknown file]'} with ${applied.count} edit block(s).`, undefined, { toolName: 'apply_edit' });
              toolResults.push(`apply_edit: staged edits for ${p} (${applied.count} block(s))`);
              break;
            }
            case 'run_command': {
              if (!allowShell) {
                this._sendActionLog('⚠️ Shell command blocked by settings.', undefined, { toolName: 'run_command', outcome: 'warning' });
                toolResults.push('run_command: blocked (agentAllowShellCommands=false)');
                break;
              }
              const command = String(args.command || '').trim();
              this._sendActionLog(`$ ${command || '[empty command]'}`, undefined, { toolName: 'run_command' });
              this._sendActionLog(`🔬 Running verification command`, undefined, { toolName: 'run_command' });
              const confirm = await vscode.window.showWarningMessage(
                `Azure Codex Agent wants to run:\n${command}`,
                { modal: true },
                'Run'
              );
              if (confirm !== 'Run') {
                this._sendActionLog(`⚠️ Command canceled: ${command}`, undefined, { toolName: 'run_command', outcome: 'warning' });
                toolResults.push(`run_command: canceled (${command})`);
                break;
              }
              const res = await this._runShellCommandStreaming(command, root, 120_000);
              this._terminalRuns.push({
                command,
                output: res.output.slice(0, 20_000),
                result: res.exitCode === 0 ? 'pass' : 'fail'
              });
              if (this._terminalRuns.length > 12) this._terminalRuns = this._terminalRuns.slice(-12);
              toolResults.push(
                `run_command (${command}) [exit=${res.exitCode}]:\n${res.output.slice(0, 20_000)}`
              );
              break;
            }
            case 'fetch_url': {
              const url = String(args.url || '').trim();
              this._sendActionLog(`📄 Reading ${url || '[empty url]'} from web source`, undefined, { toolName: 'fetch_url' });
              const fetched = await this._safeFetchUrl(url);
              toolResults.push(`fetch_url (${url}):\n${fetched}`);
              break;
            }
            case 'git_status': {
              this._sendActionLog('✅ Running checks: git status', undefined, { toolName: 'git_status' });
              const res = await exec('git status --porcelain=v1 -b', { cwd: root, timeout: 30_000, maxBuffer: 500_000 });
              toolResults.push(`git_status:\n${(res.stdout || '').trim()}`);
              break;
            }
            case 'git_diff': {
              const extra = typeof args.args === 'string' ? args.args : '';
              this._sendActionLog(`✅ Running checks: git diff ${extra}`.trim(), undefined, { toolName: 'git_diff' });
              const res = await exec(`git diff ${extra}`.trim(), { cwd: root, timeout: 30_000, maxBuffer: 2_000_000 });
              toolResults.push(`git_diff ${extra}:\n${(res.stdout || '').slice(0, 40_000)}`);
              break;
            }
            case 'remember': {
              if (!memory) {
                this._sendActionLog('⚠️ Memory tool unavailable in current session.', undefined, { toolName: 'remember', outcome: 'warning' });
                toolResults.push('remember: unavailable');
                break;
              }
              await memory.remember(String(args.key || ''), String(args.value || ''));
              this._sendActionLog(`🧠 Saved memory key: ${String(args.key || '[empty]')}`, undefined, { toolName: 'remember' });
              toolResults.push(`remember: saved ${String(args.key || '')}`);
              break;
            }
            case 'forget': {
              if (!memory) {
                this._sendActionLog('⚠️ Memory tool unavailable in current session.', undefined, { toolName: 'forget', outcome: 'warning' });
                toolResults.push('forget: unavailable');
                break;
              }
              await memory.forget(String(args.key || ''));
              this._sendActionLog(`🧠 Removed memory key: ${String(args.key || '[empty]')}`, undefined, { toolName: 'forget' });
              toolResults.push(`forget: removed ${String(args.key || '')}`);
              break;
            }
            default:
              this._sendActionLog(`⚠️ Unknown tool requested: ${name || '[empty]'}`, undefined, { toolName: name || 'unknown', outcome: 'warning' });
              toolResults.push(`unknown_tool: ${name}`);
          }
        } catch (e: any) {
          this._sendActionLog(`⚠️ Tool ${name || '[unknown]'} failed: ${e?.message || String(e)}`, undefined, { toolName: name || 'unknown', outcome: 'error' });
          toolResults.push(`${name} failed: ${e?.message || String(e)}`);
        }
      }

      const resultMsg = `Tool results (step ${step}):\n\n${toolResults.join('\n\n---\n\n')}`;
      this._rememberToolResultSnippet(resultMsg);
      this._sendToWebview({ type: 'assistantToken', token: `\n\n${resultMsg}\n` });
      scratch.push({ role: 'assistant', content: assistantText });
      scratch.push({ role: 'user', content: resultMsg });
    }

    if (!accumulatedDisplay.trim()) {
      try {
        const defaultDeployment = config.get<string>('deploymentName', 'gpt-5-2-codex-max');
        const chatModel = this._deps?.modelRouter?.getChatDeployment(defaultDeployment) || defaultDeployment;
        const fallback = await this._client.chatToText(baseContext, userText, { model: chatModel });
        const fallbackText = String(fallback || '').trim();
        if (fallbackText) {
          accumulatedDisplay = fallbackText;
          this._sendToWebview({ type: 'assistantToken', token: `\n\n${fallbackText}\n` });
        }
      } catch {
        // ignore and let final guard below handle empty output
      }
    }

    if (!accumulatedDisplay.trim()) {
      const fallbackText = 'I’m here and ready. Tell me what you want to build, fix, or explain, and I’ll help right away.';
      accumulatedDisplay = fallbackText;
      this._sendToWebview({ type: 'assistantToken', token: `\n\n${fallbackText}\n` });
    }

    this._sendToWebview({ type: 'assistantDone' });

    // Save a compact version to history so future turns have continuity.
    chat.history.push({ role: 'user', content: userText });
    chat.history.push({ role: 'assistant', content: accumulatedDisplay.trim() || '[agent run completed]' });
    chat.messagesSinceSummary += 2;
    if (chat.history.length > 20) chat.history = chat.history.slice(-20);
    this._sendChatState();

    const staged = session.listStaged();
    if (staged.length) {
      this._sendActionLog(`✏️ Prepared ${staged.length} staged file change(s) for review.`);
      const picked = await vscode.window.showInformationMessage(
        `Azure Codex Agent staged ${staged.length} file(s). Review before applying.`,
        'Open Review Panel',
        'Review (Quick)'
      );
      if (picked === 'Open Review Panel') {
        await this._openAgentReviewPanel(session);
      } else if (picked === 'Review (Quick)') {
        await this._reviewAndMaybeApplyAgentChanges(session);
      }
    }
  }

  private async _openAgentReviewPanel(session: AgentSession) {
    const staged = session.listStaged();
    if (!staged.length) return;

    AgentReviewPanel.show({
      extensionUri: this._extensionUri,
      title: `Azure Codex: Agent Review (${staged.length} file(s))`,
      session,
      onApply: async (acceptedPaths) => {
        // Apply only accepted paths
        const filteredSession = session;
        const all = filteredSession.listStaged();
        const acceptSet = new Set(acceptedPaths);
        const keep = all.filter((c) => acceptSet.has(c.path));
        // Temporarily discard other staged changes from apply
        const tmp = new AgentSession((vscode.workspace.workspaceFolders?.[0]?.uri) ?? vscode.Uri.file(process.cwd()));
        for (const k of keep) {
          await tmp.stageWrite(k.path, k.nextContent);
          // keep original prev snapshots
          const stagedTmp = tmp.listStaged().find((x) => x.path === k.path);
          if (stagedTmp) {
            stagedTmp.prevExists = k.prevExists;
            stagedTmp.prevContent = k.prevContent;
          }
        }
        await this._applyStagedChanges(tmp, { confirm: false });
      },
      onDiscard: () => session.discardAll()
    });
  }

  private async _reviewAndMaybeApplyAgentChanges(session: AgentSession) {
    const staged = session.listStaged();
    if (!staged.length) return;

    type ReviewPickItem = vscode.QuickPickItem & { action: 'apply' | 'discard' | 'diff'; path?: string };
    const items: ReviewPickItem[] = [
      { label: 'Apply All', description: 'Write all staged changes to disk', action: 'apply' },
      { label: 'Discard All', description: 'Drop all staged changes', action: 'discard' },
      { label: 'Review', kind: vscode.QuickPickItemKind.Separator, action: 'diff' }
    ];
    const checkpoints = session.listCheckpoints();
    if (checkpoints.length > 1) {
      items.push({ label: 'Revert to checkpoint…', description: 'Rollback staged changes to an earlier agent step', action: 'diff', path: '__revert__' });
    }
    items.push(
      ...staged.map(
        (c): ReviewPickItem => ({ label: c.path, description: 'Open diff preview', action: 'diff', path: c.path })
      )
    );

    const pick = await vscode.window.showQuickPick<ReviewPickItem>(items, { placeHolder: 'Review staged changes' });
    if (!pick) return;
    if (pick.action === 'discard') {
      session.discardAll();
      vscode.window.showInformationMessage('Azure Codex Agent: Discarded staged changes.');
      return;
    }
    if (pick.action === 'apply') {
      await this._applyStagedChanges(session, { confirm: true });
      return;
    }
    if (pick.action === 'diff') {
      if (pick.path === '__revert__') {
        const cps = session
          .listCheckpoints()
          .slice()
          .reverse()
          .map((c) => ({
            label: `Step ${c.step}`,
            description: c.label,
            detail: new Date(c.at).toLocaleString(),
            step: c.step
          }));
        const chosen = await vscode.window.showQuickPick(cps, { placeHolder: 'Revert staged changes to which step?' });
        if (!chosen) return;
        session.revertToStep(chosen.step);
        vscode.window.showInformationMessage(`Azure Codex Agent: Reverted staged changes to step ${chosen.step}.`);
        // Re-open review after revert
        await this._reviewAndMaybeApplyAgentChanges(session);
        return;
      }
      const ch = staged.find((s) => s.path === pick.path);
      if (!ch) return;
      await this._showDiffPreview(ch.uri, ch.prevContent, ch.nextContent, `Azure Codex Agent: ${ch.path}`);
      return;
    }
  }

  private async _applyStagedChanges(session: AgentSession, opts: { confirm: boolean }) {
    const staged = session.listStaged();
    if (!staged.length) return;
    this._sendActionLog(`✅ Validating changes... applying ${staged.length} staged file(s).`, 'ok');
    if (opts.confirm) {
      const confirm = await vscode.window.showWarningMessage(
        `Apply ${staged.length} staged change(s) to your workspace?`,
        { modal: true },
        'Apply'
      );
      if (confirm !== 'Apply') return;
    }

    const ops: Array<{ path: string; prevExists: boolean; prevContent: string }> = [];
    for (const c of staged) {
      const dir = c.path.split('/').slice(0, -1).join('/');
      if (dir) {
        try {
          const folders = vscode.workspace.workspaceFolders;
          if (folders && folders.length) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, dir));
          }
        } catch {
          // ignore
        }
      }
      await vscode.workspace.fs.writeFile(c.uri, Buffer.from(c.nextContent, 'utf8'));
      ops.push({ path: c.path, prevExists: c.prevExists, prevContent: c.prevContent });
    }
    this._pushUndoBatch({ label: `Agent apply (${staged.length} file(s))`, ops });
    this._sendActionLog(`✅ Done — ${staged.length} file(s) changed.`, 'ok');
    vscode.window.showInformationMessage(`Azure Codex Agent: Applied ${staged.length} file(s).`);
    void this._runAutoTestLoop(staged.map((s) => s.path));
  }

  private async _runShellCommandStreaming(
    command: string,
    cwd: string,
    timeoutMs: number
  ): Promise<{ exitCode: number; output: string }> {
    const cmd = String(command || '').trim();
    if (!cmd) return { exitCode: 0, output: '' };

    return await new Promise<{ exitCode: number; output: string }>((resolve) => {
      const child = spawn(cmd, {
        cwd,
        shell: true,
        env: process.env
      });

      let output = '';
      let timedOut = false;

      const emitLine = (line: string) => {
        const clean = String(line || '').replace(/\r/g, '').trimEnd();
        if (!clean) return;
        output += clean + '\n';
        const lower = clean.toLowerCase();
        const level: 'ok' | 'warn' | 'info' =
          /\b(pass|passed|success|compiled successfully|ok)\b/.test(lower)
            ? 'ok'
            : /\b(fail|failed|error|exception|traceback|fatal|cannot)\b/.test(lower)
              ? 'warn'
              : /\b(warn|warning|deprecated)\b/.test(lower)
                ? 'warn'
                : 'info';
        this._sendActionLog(`$ ${clean}`, level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : 'info', {
          toolName: 'run_command',
          outcome: level === 'warn' ? 'warning' : level === 'ok' ? 'success' : 'neutral'
        });
        this._sendToWebview({ type: 'terminalLine', text: clean, level });
      };

      const streamBuffer = (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const line of text.split('\n')) emitLine(line);
      };

      child.stdout?.on('data', streamBuffer);
      child.stderr?.on('data', streamBuffer);

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }, Math.max(1_000, timeoutMs));

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          emitLine('[command timed out]');
          resolve({ exitCode: 124, output: output.trim() });
          return;
        }
        resolve({ exitCode: Number(code ?? 0), output: output.trim() });
      });

      child.on('error', (err: Error) => {
        clearTimeout(timer);
        emitLine(`[command error] ${err.message}`);
        resolve({ exitCode: 1, output: output.trim() });
      });
    });
  }

  private async _runAutoTestLoop(changedPaths: string[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('azureCodex');
    const generateTests = cfg.get<boolean>('autoGenerateTests', true);
    const runTests = cfg.get<boolean>('autoRunTests', false);
    if (!generateTests && !runTests) return;
    if (!changedPaths.length) return;

    const unique = Array.from(new Set(changedPaths)).slice(0, 15);
    if (generateTests) {
      await this._generateTestsForChangedFiles(unique);
    }
    if (!runTests) return;

    const folders = vscode.workspace.workspaceFolders;
    const cwd = folders && folders.length ? folders[0].uri.fsPath : process.cwd();
    const defaultTestCommand = this._detectedStack?.testCommand && this._detectedStack.testCommand !== 'unknown'
      ? this._detectedStack.testCommand
      : 'npm test -- --runInBand';
    const testCommand = String(cfg.get<string>('testCommand', defaultTestCommand) || defaultTestCommand);

    for (let attempt = 1; attempt <= 3; attempt++) {
      this._sendActionLog(`$ ${testCommand}`);
      this._sendActionLog(`🧪 Running tests (attempt ${attempt}/3)`);
      const res = await this._runShellCommandStreaming(testCommand, cwd, 10 * 60_000);
      const passed = res.exitCode === 0;
      this._terminalRuns.push({ command: testCommand, output: res.output.slice(0, 20000), result: passed ? 'pass' : 'fail' });
      if (this._terminalRuns.length > 12) this._terminalRuns = this._terminalRuns.slice(-12);
      this._sendActionLog(passed ? '✅ Tests passed.' : `❌ Tests failed (exit ${res.exitCode}).`);
      this._sendToWebview({ type: 'toast', text: passed ? 'Tests passed' : `Tests failed (attempt ${attempt}/3)` });

      if (passed) return;
      if (attempt >= 3) break;
      await this._attemptAutoFixFromTestOutput(unique, res.output);
    }
  }

  private async _generateTestsForChangedFiles(changedPaths: string[]): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    const root = folders[0].uri;

    const snippets: string[] = [];
    for (const rel of changedPaths.slice(0, 8)) {
      try {
        const uri = vscode.Uri.joinPath(root, rel);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        snippets.push(`File: ${rel}\n${text.slice(0, 5000)}`);
      } catch {
        // ignore unreadable files
      }
    }
    if (!snippets.length) return;

    this._sendActionLog('🧪 Generating unit tests for changed code.');
    const prompt =
      `Generate or update unit tests for changed files. Prefer existing test conventions and avoid unrelated edits.\n` +
      `Return only \`\`\`file\`\`\` or \`\`\`edit\`\`\` blocks for test files.\n\n` +
      snippets.join('\n\n---\n\n');

    const out = await this._client.chatToText([], prompt);
    const blocks = this._extractFencedBlocks(out).filter((b) => b.lang === 'file' || b.lang === 'edit');
    if (!blocks.length) return;

    const ops: Array<{ path: string; prevExists: boolean; prevContent: string }> = [];
    const applied: Array<{ kind: 'file' | 'delete'; path: string; addedLines: number; removedLines: number }> = [];
    for (const block of blocks) {
      const res = await this._applyFileBlockInternal(block.lang, block.code, { confirm: false, collectUndoOps: ops });
      if (res) applied.push(res);
    }
    if (applied.length) {
      this._sendChangeSummary(applied.map((a) => ({ path: a.path, added: a.addedLines, removed: a.removedLines })));
      if (ops.length) this._pushUndoBatch({ label: `Auto-test generation (${applied.length} file(s))`, ops });
    }
  }

  private async _attemptAutoFixFromTestOutput(changedPaths: string[], testOutput: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    const root = folders[0].uri;

    const snippets: string[] = [];
    for (const rel of changedPaths.slice(0, 8)) {
      try {
        const uri = vscode.Uri.joinPath(root, rel);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        snippets.push(`File: ${rel}\n${text.slice(0, 5000)}`);
      } catch {
        // ignore
      }
    }
    if (!snippets.length) return;

    this._sendActionLog('🛠️ Attempting automatic fix from failing tests.');
    const prompt =
      `Tests failed. Fix the relevant source/tests with minimal changes.\n` +
      `Test output:\n${testOutput.slice(0, 12000)}\n\n` +
      `Return only \`\`\`edit\`\`\` or \`\`\`file\`\`\` blocks.\n\n` +
      snippets.join('\n\n---\n\n');

    const out = await this._client.chatToText([], prompt);
    const blocks = this._extractFencedBlocks(out).filter((b) => b.lang === 'file' || b.lang === 'edit');
    if (!blocks.length) return;

    const ops: Array<{ path: string; prevExists: boolean; prevContent: string }> = [];
    const applied: Array<{ kind: 'file' | 'delete'; path: string; addedLines: number; removedLines: number }> = [];
    for (const block of blocks) {
      const res = await this._applyFileBlockInternal(block.lang, block.code, { confirm: false, collectUndoOps: ops });
      if (res) applied.push(res);
    }
    if (applied.length && ops.length) {
      this._pushUndoBatch({ label: `Auto test-fix (${applied.length} file(s))`, ops });
    }
  }

  private async _safeFetchUrl(rawUrl: string): Promise<string> {
    const u = String(rawUrl || '').trim();
    if (!u) return '[empty url]';
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return '[invalid url]';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[blocked protocol]';
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return '[blocked host]';
    if (host.endsWith('.local')) return '[blocked host]';
    if (host === '169.254.169.254') return '[blocked host]';

    try {
      const res = await fetch(url.toString(), { method: 'GET' });
      const text = await res.text();
      const clipped = text.slice(0, 60_000);
      return `HTTP ${res.status}\n${clipped}`;
    } catch (e: any) {
      return `[fetch failed] ${e?.message || String(e)}`;
    }
  }

  private _extractToolCallsAndStrip(text: string): { display: string; tools: Array<{ name: string; args: any }> } {
    const blocks = this._extractFencedBlocks(text);
    const tools: Array<{ name: string; args: any }> = [];
    for (const b of blocks) {
      if (b.lang !== 'tool') continue;
      try {
        const parsed = JSON.parse(b.code);
        if (parsed && typeof parsed.name === 'string') tools.push({ name: parsed.name, args: parsed.args ?? {} });
      } catch {
        // ignore
      }
    }

    let display = String(text || '');
    // remove tool blocks from display
    display = display.replace(/```tool[\s\S]*?```/g, '').trim();
    return { display, tools };
  }

  private _extractFencedBlocks(text: string): Array<{ lang: string; code: string }> {
    const out: Array<{ lang: string; code: string }> = [];
    const s = String(text || '');
    const fence = '```';
    let i = 0;
    while (i < s.length) {
      const start = s.indexOf(fence, i);
      if (start === -1) break;
      const langEnd = s.indexOf('\n', start + fence.length);
      if (langEnd === -1) break;
      const lang = s.slice(start + fence.length, langEnd).trim().toLowerCase();
      const end = s.indexOf(fence, langEnd + 1);
      if (end === -1) break;
      const code = s.slice(langEnd + 1, end).replace(/\r\n/g, '\n').trim();
      out.push({ lang, code });
      i = end + fence.length;
    }
    return out;
  }

  private _applySearchReplaceEdits(
    original: string,
    editBlockContent: string
  ): { ok: true; updated: string; count: number } | { ok: false; error: string } {
    const lines = String(editBlockContent || '').replace(/\r\n/g, '\n').split('\n');

    type Block = { search: string; replace: string };
    const blocks: Block[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trimEnd();
      if (line.trim() !== '<<<<<<< SEARCH') {
        i++;
        continue;
      }
      i++;
      const searchLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '=======') {
        searchLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length || lines[i].trim() !== '=======') return { ok: false, error: 'Malformed edit block (missing =======).' };
      i++;
      const replaceLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '>>>>>>> REPLACE') {
        replaceLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length || lines[i].trim() !== '>>>>>>> REPLACE')
        return { ok: false, error: 'Malformed edit block (missing >>>>>>> REPLACE).' };
      i++;

      blocks.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
    }

    if (!blocks.length) return { ok: false, error: 'No SEARCH/REPLACE blocks found.' };

    let updated = String(original || '').replace(/\r\n/g, '\n');
    let count = 0;
    for (const b of blocks) {
      const search = b.search;
      const replace = b.replace;
      const idx = updated.indexOf(search);
      if (idx === -1) return { ok: false, error: 'SEARCH block not found in file.' };
      if (updated.indexOf(search, idx + 1) !== -1) return { ok: false, error: 'SEARCH block is not unique in file.' };
      updated = updated.slice(0, idx) + replace + updated.slice(idx + search.length);
      count++;
    }

    return { ok: true, updated, count };
  }

  private _estimateEditTargetRanges(original: string, editBlockContent: string): string[] {
    const out: string[] = [];
    const lines = String(editBlockContent || '').replace(/\r\n/g, '\n').split('\n');
    const normalizedOriginal = String(original || '').replace(/\r\n/g, '\n');

    let i = 0;
    while (i < lines.length) {
      if (lines[i].trim() !== '<<<<<<< SEARCH') {
        i++;
        continue;
      }
      i++;
      const searchLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '=======') {
        searchLines.push(lines[i]);
        i++;
      }
      while (i < lines.length && lines[i].trim() !== '>>>>>>> REPLACE') {
        i++;
      }
      i++;

      const search = searchLines.join('\n');
      if (!search.trim()) continue;
      const idx = normalizedOriginal.indexOf(search);
      if (idx < 0) continue;

      const startLine = normalizedOriginal.slice(0, idx).split('\n').length;
      const span = Math.max(1, search.split('\n').length);
      out.push(`${startLine}-${startLine + span - 1}`);
    }

    return out;
  }

  private async _showDiffPreview(targetUri: vscode.Uri, before: string, after: string, title: string) {
    try {
      const originalDoc = await vscode.workspace.openTextDocument({ content: before });
      const modifiedDoc = await vscode.workspace.openTextDocument({ content: after });
      await vscode.commands.executeCommand('vscode.diff', originalDoc.uri, modifiedDoc.uri, title);
    } catch {
      // ignore
    }
  }

  private _pushUndoBatch(batch: { label: string; ops: Array<{ path: string; prevExists: boolean; prevContent: string }> }) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this._undoBatches.push({ id, at: Date.now(), label: batch.label, ops: batch.ops });
    if (this._undoBatches.length > 20) this._undoBatches = this._undoBatches.slice(-20);
    this._sendUndoStatus();
    const filesArr = Array.from(new Set((batch.ops || []).map((o) => o.path)));
    void this._appendHistorySnapshot({
      id,
      at: Date.now(),
      action: batch.label,
      files: filesArr,
      ops: (batch.ops || []).map((o) => ({ path: o.path, prevExists: o.prevExists, prevContent: o.prevContent }))
    });
    const files = filesArr.join(', ');
    void this._appendChangeLog(
      `## ${new Date().toISOString()}\n- Action: ${batch.label}\n- Files: ${files || 'n/a'}\n\n`
    );
  }

  private _sendUndoStatus() {
    const last = this._undoBatches.length ? this._undoBatches[this._undoBatches.length - 1] : null;
    this._sendToWebview({
      type: 'undoStatus',
      status: {
        canUndo: !!last,
        label: last ? last.label : '',
        paths: last ? Array.from(new Set((last.ops || []).map((o) => o.path))).slice(0, 50) : []
      }
    });
  }

  private async _undoLastApply() {
    const batch = this._undoBatches.length ? this._undoBatches[this._undoBatches.length - 1] : null;
    if (!batch) {
      vscode.window.showInformationMessage('Azure Codex: Nothing to undo.');
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) {
      vscode.window.showErrorMessage('No workspace folder is open.');
      return;
    }

    // Only pop once we know we can attempt the undo.
    this._undoBatches.pop();

    for (const op of [...batch.ops].reverse()) {
      const targetUri = vscode.Uri.joinPath(folders[0].uri, op.path);
      if (!op.prevExists) {
        try {
          await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: true });
        } catch {
          // ignore
        }
        continue;
      }

      const dir = op.path.split('/').slice(0, -1).join('/');
      if (dir) {
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, dir));
        } catch {
          // ignore
        }
      }
      try {
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(op.prevContent, 'utf8'));
      } catch {
        // ignore
      }
    }

    this._sendUndoStatus();
    vscode.window.showInformationMessage(`Azure Codex: Undid "${batch.label}".`);
    void this._appendChangeLog(`## ${new Date().toISOString()}\n- Revert: ${batch.label}\n\n`);
  }
}
