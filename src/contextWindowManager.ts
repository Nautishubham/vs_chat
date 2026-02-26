import { encodingForModel, getEncoding, Tiktoken } from 'js-tiktoken';

export type ContextBudgetBreakdown = {
  systemPrompt: number;
  conversationHistory: number;
  loadedFiles: number;
  toolResults: number;
  safetyBuffer: number;
  outputReserved: number;
  totalWindow: number;
};

export type ContextTokenUsage = {
  systemPrompt: number;
  conversationHistory: number;
  loadedFiles: number;
  toolResults: number;
  subtotal: number;
  withReserved: number;
};

export type ContextCompressionInput = {
  systemPrompt: string;
  historyMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  loadedFileSections: string[];
  toolResults: string[];
};

export type ContextCompressionResult = {
  systemPrompt: string;
  historyMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  loadedFileSections: string[];
  toolResults: string[];
  usage: ContextTokenUsage;
  compressed: boolean;
  notes: string[];
};

const DEFAULT_BUDGETS: ContextBudgetBreakdown = {
  systemPrompt: 10_000,
  conversationHistory: 30_000,
  loadedFiles: 150_000,
  toolResults: 30_000,
  safetyBuffer: 52_000,
  outputReserved: 128_000,
  totalWindow: 400_000
};

export class ContextWindowManager {
  private readonly _budgets: ContextBudgetBreakdown;
  private readonly _tokenizer: Tiktoken;

  constructor(modelName = 'gpt-5.1-codex-max', budgets?: Partial<ContextBudgetBreakdown>) {
    this._budgets = { ...DEFAULT_BUDGETS, ...(budgets || {}) };
    this._tokenizer = this._createTokenizer(modelName);
  }

  get budgets(): ContextBudgetBreakdown {
    return { ...this._budgets };
  }

  countTokens(text: string): number {
    const value = String(text || '');
    if (!value) return 0;
    return this._tokenizer.encode(value).length;
  }

  countHistoryTokens(messages: Array<{ role: string; content: string }>): number {
    let total = 0;
    for (const message of messages) {
      const line = `${message.role}: ${String(message.content || '')}`;
      total += this.countTokens(line);
    }
    return total;
  }

  buildUsage(args: ContextCompressionInput): ContextTokenUsage {
    const systemPrompt = this.countTokens(args.systemPrompt);
    const conversationHistory = this.countHistoryTokens(args.historyMessages);
    const loadedFiles = this.countTokens(args.loadedFileSections.join('\n\n'));
    const toolResults = this.countTokens(args.toolResults.join('\n\n'));
    const subtotal = systemPrompt + conversationHistory + loadedFiles + toolResults;
    const withReserved = subtotal + this._budgets.safetyBuffer + this._budgets.outputReserved;
    return { systemPrompt, conversationHistory, loadedFiles, toolResults, subtotal, withReserved };
  }

  compressToBudget(args: ContextCompressionInput): ContextCompressionResult {
    const notes: string[] = [];
    let systemPrompt = String(args.systemPrompt || '');
    let historyMessages = [...args.historyMessages];
    let loadedFileSections = [...args.loadedFileSections];
    let toolResults = [...args.toolResults];
    let compressed = false;

    const trimToTokens = (input: string, maxTokens: number): string => {
      if (maxTokens <= 0) return '';
      if (!input) return '';
      const ids = this._tokenizer.encode(input);
      if (ids.length <= maxTokens) return input;
      const clipped = ids.slice(0, maxTokens);
      return this._tokenizer.decode(clipped);
    };

    if (this.countTokens(systemPrompt) > this._budgets.systemPrompt) {
      systemPrompt = trimToTokens(systemPrompt, this._budgets.systemPrompt);
      notes.push('system_prompt_trimmed');
      compressed = true;
    }

    // Per-category trimming first.
    if (this.countHistoryTokens(historyMessages) > this._budgets.conversationHistory) {
      historyMessages = this._trimHistoryToBudget(historyMessages, this._budgets.conversationHistory);
      notes.push('history_trimmed');
      compressed = true;
    }

    if (this.countTokens(loadedFileSections.join('\n\n')) > this._budgets.loadedFiles) {
      loadedFileSections = this._trimSectionArrayToBudget(loadedFileSections, this._budgets.loadedFiles);
      notes.push('file_sections_trimmed');
      compressed = true;
    }

    if (this.countTokens(toolResults.join('\n\n')) > this._budgets.toolResults) {
      toolResults = this._trimSectionArrayToBudget(toolResults, this._budgets.toolResults);
      notes.push('tool_results_trimmed');
      compressed = true;
    }

    // Global compression trigger near 350k usage.
    let usage = this.buildUsage({ systemPrompt, historyMessages, loadedFileSections, toolResults });
    if (usage.withReserved >= 350_000) {
      compressed = true;
      notes.push('global_compression_triggered');

      historyMessages = this._trimHistoryToBudget(historyMessages, Math.max(5_000, this._budgets.conversationHistory - 6_000));
      loadedFileSections = this._trimSectionArrayToBudget(loadedFileSections, Math.max(30_000, this._budgets.loadedFiles - 25_000));
      toolResults = this._trimSectionArrayToBudget(toolResults, Math.max(5_000, this._budgets.toolResults - 10_000));
      usage = this.buildUsage({ systemPrompt, historyMessages, loadedFileSections, toolResults });
    }

    return {
      systemPrompt,
      historyMessages,
      loadedFileSections,
      toolResults,
      usage,
      compressed,
      notes
    };
  }

  private _trimSectionArrayToBudget(items: string[], budgetTokens: number): string[] {
    const out: string[] = [];
    let used = 0;
    for (const item of items) {
      const tokens = this.countTokens(item);
      if (used + tokens <= budgetTokens) {
        out.push(item);
        used += tokens;
        continue;
      }
      const remaining = budgetTokens - used;
      if (remaining <= 0) break;
      const clipped = this._tokenizer.decode(this._tokenizer.encode(item).slice(0, remaining));
      out.push(`${clipped}\n\n[section trimmed for token budget]`);
      used = budgetTokens;
      break;
    }
    return out;
  }

  private _trimHistoryToBudget(
    items: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    budgetTokens: number
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const kept: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    let used = 0;

    // Keep newest messages first within budget.
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const cost = this.countTokens(`${item.role}: ${item.content}`);
      if (used + cost > budgetTokens) continue;
      kept.push(item);
      used += cost;
    }
    kept.reverse();
    return kept;
  }

  private _createTokenizer(modelName: string): Tiktoken {
    try {
      return encodingForModel(modelName as any);
    } catch {
      try {
        return getEncoding('o200k_base');
      } catch {
        return getEncoding('cl100k_base');
      }
    }
  }
}
