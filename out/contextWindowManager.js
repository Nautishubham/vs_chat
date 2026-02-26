"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextWindowManager = void 0;
const js_tiktoken_1 = require("js-tiktoken");
const DEFAULT_BUDGETS = {
    systemPrompt: 10000,
    conversationHistory: 30000,
    loadedFiles: 150000,
    toolResults: 30000,
    safetyBuffer: 52000,
    outputReserved: 128000,
    totalWindow: 400000
};
class ContextWindowManager {
    constructor(modelName = 'gpt-5.1-codex-max', budgets) {
        this._budgets = { ...DEFAULT_BUDGETS, ...(budgets || {}) };
        this._tokenizer = this._createTokenizer(modelName);
    }
    get budgets() {
        return { ...this._budgets };
    }
    countTokens(text) {
        const value = String(text || '');
        if (!value)
            return 0;
        return this._tokenizer.encode(value).length;
    }
    countHistoryTokens(messages) {
        let total = 0;
        for (const message of messages) {
            const line = `${message.role}: ${String(message.content || '')}`;
            total += this.countTokens(line);
        }
        return total;
    }
    buildUsage(args) {
        const systemPrompt = this.countTokens(args.systemPrompt);
        const conversationHistory = this.countHistoryTokens(args.historyMessages);
        const loadedFiles = this.countTokens(args.loadedFileSections.join('\n\n'));
        const toolResults = this.countTokens(args.toolResults.join('\n\n'));
        const subtotal = systemPrompt + conversationHistory + loadedFiles + toolResults;
        const withReserved = subtotal + this._budgets.safetyBuffer + this._budgets.outputReserved;
        return { systemPrompt, conversationHistory, loadedFiles, toolResults, subtotal, withReserved };
    }
    compressToBudget(args) {
        const notes = [];
        let systemPrompt = String(args.systemPrompt || '');
        let historyMessages = [...args.historyMessages];
        let loadedFileSections = [...args.loadedFileSections];
        let toolResults = [...args.toolResults];
        let compressed = false;
        const trimToTokens = (input, maxTokens) => {
            if (maxTokens <= 0)
                return '';
            if (!input)
                return '';
            const ids = this._tokenizer.encode(input);
            if (ids.length <= maxTokens)
                return input;
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
        if (usage.withReserved >= 350000) {
            compressed = true;
            notes.push('global_compression_triggered');
            historyMessages = this._trimHistoryToBudget(historyMessages, Math.max(5000, this._budgets.conversationHistory - 6000));
            loadedFileSections = this._trimSectionArrayToBudget(loadedFileSections, Math.max(30000, this._budgets.loadedFiles - 25000));
            toolResults = this._trimSectionArrayToBudget(toolResults, Math.max(5000, this._budgets.toolResults - 10000));
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
    _trimSectionArrayToBudget(items, budgetTokens) {
        const out = [];
        let used = 0;
        for (const item of items) {
            const tokens = this.countTokens(item);
            if (used + tokens <= budgetTokens) {
                out.push(item);
                used += tokens;
                continue;
            }
            const remaining = budgetTokens - used;
            if (remaining <= 0)
                break;
            const clipped = this._tokenizer.decode(this._tokenizer.encode(item).slice(0, remaining));
            out.push(`${clipped}\n\n[section trimmed for token budget]`);
            used = budgetTokens;
            break;
        }
        return out;
    }
    _trimHistoryToBudget(items, budgetTokens) {
        const kept = [];
        let used = 0;
        // Keep newest messages first within budget.
        for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const cost = this.countTokens(`${item.role}: ${item.content}`);
            if (used + cost > budgetTokens)
                continue;
            kept.push(item);
            used += cost;
        }
        kept.reverse();
        return kept;
    }
    _createTokenizer(modelName) {
        try {
            return (0, js_tiktoken_1.encodingForModel)(modelName);
        }
        catch {
            try {
                return (0, js_tiktoken_1.getEncoding)('o200k_base');
            }
            catch {
                return (0, js_tiktoken_1.getEncoding)('cl100k_base');
            }
        }
    }
}
exports.ContextWindowManager = ContextWindowManager;
//# sourceMappingURL=contextWindowManager.js.map