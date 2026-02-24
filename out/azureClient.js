"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureOpenAIClient = void 0;
const vscode = __importStar(require("vscode"));
const axios_1 = __importDefault(require("axios"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const SYSTEM_PROMPT = `You are Azure Codex, an expert AI coding assistant integrated into VS Code and backed by Azure OpenAI.

Your capabilities:
- Write, explain, debug, and refactor code in any programming language
- Analyze code for bugs, security issues, and performance problems
- Generate unit tests and documentation
- Help with architecture and design patterns
- Assist with DevOps, cloud, and infrastructure code

Guidelines:
- Always provide code in properly formatted markdown code blocks with language tags
- Be concise but thorough — prioritize working, production-ready code
- When fixing bugs, explain what was wrong and why
- When writing code, add brief inline comments for clarity
- If you're unsure about something, say so and provide alternatives

Workspace editing protocol:
- If you want the extension to write/update a file, output a code block with language \`file\` in this exact format:
  \`\`\`file
  path: relative/path/to/file.ext
  <full file contents here>
  \`\`\`
  - Prefer diff-based edits when possible by emitting an \`edit\` block:
    \`\`\`edit
    path: relative/path/to/file.ext
    <<<<<<< SEARCH
    <exact snippet to find>
    =======
    <replacement snippet>
    >>>>>>> REPLACE
    \`\`\`
    Use multiple SEARCH/REPLACE blocks for multiple changes. Each SEARCH must match exactly once.
	- If you want to delete a file, output:
	  \`\`\`delete
	  path: relative/path/to/file.ext
	  \`\`\`
	- The user can click "Apply" on those blocks to make the changes in their workspace. The extension also supports undoing the last applied change.
	- If you need additional files to proceed, request them with:
	  \`\`\`request
	  paths:
	  - src/fileA.ts
	  - src/fileB.ts
	  \`\`\`
	  The user can click "Fetch" to add them to pinned context. Request only the minimal set of files needed.

Minimal-change rules (MUST FOLLOW when the user asks for small changes):
- Do NOT rewrite the full file. Use \`\`\`edit\`\`\` blocks that touch only the requested lines.
- Do NOT change existing logic unless explicitly asked.
- Do NOT duplicate functions or return statements.
- Ensure syntax is valid (no broken strings, no duplicated/embedded returns).
- If the user says "ONLY fix syntax error" / "ONLY add seed support" / "ONLY add schema validation", do exactly that and nothing else.

Local file handling rules (MUST FOLLOW when the user provides a path/filename):
- Assume the file is already available in the workspace.
- Do NOT fetch from external sources and do NOT regenerate the file.
- If a file path is provided, use it directly.
- If only a filename is provided, search workspace folders first.
- Prefer showing minimal Python snippets to: print current working directory, list files, locate the file, load it with the correct library, and confirm load (shape/columns).
- Do NOT create or overwrite files unless the user explicitly asks.

Output quality:
- Prefer making changes by emitting \`\`\`file\`\`\` blocks (full file content) instead of asking the user to manually edit.
- After any code/file changes, end with a short "Next improvements" list (tests, linting, validation, edge cases, refactors). Avoid repeating the full code there.`;
class AzureOpenAIClient {
    constructor() {
        this.reloadConfig();
    }
    reloadConfig() {
        const config = vscode.workspace.getConfiguration('azureCodex');
        const dotEnv = this._readDotEnvFromWorkspace();
        const envGet = (key) => {
            const v = dotEnv[key] ?? process.env[key];
            return typeof v === 'string' ? v : '';
        };
        const endpointFromEnv = envGet('AZURE_OPENAI_ENDPOINT') ||
            envGet('AZURE_OPENAI_API_ENDPOINT') ||
            envGet('AZURE_OPENAI_BASE_URL');
        const apiKeyFromEnv = envGet('AZURE_OPENAI_API_KEY') || envGet('AZURE_OPENAI_KEY') || envGet('OPENAI_API_KEY');
        const deploymentFromEnv = envGet('AZURE_OPENAI_DEPLOYMENT') || envGet('AZURE_OPENAI_DEPLOYMENT_NAME');
        const apiVersionFromEnv = envGet('AZURE_OPENAI_API_VERSION');
        const embeddingsDeploymentFromEnv = envGet('AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT') || envGet('AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME');
        const embeddingsApiVersionFromEnv = envGet('AZURE_OPENAI_EMBEDDINGS_API_VERSION');
        const embeddingsEndpointFromEnv = envGet('AZURE_OPENAI_EMBEDDINGS_ENDPOINT') || envGet('AZURE_OPENAI_EMBEDDINGS_BASE_URL');
        const embeddingsApiKeyFromEnv = envGet('AZURE_OPENAI_EMBEDDINGS_API_KEY') || envGet('AZURE_OPENAI_EMBEDDINGS_KEY');
        this.endpoint = (config.get('endpoint', '') || endpointFromEnv).replace(/\/$/, '');
        this.apiKey = config.get('apiKey', '') || apiKeyFromEnv;
        this.deploymentName = config.get('deploymentName', '') || deploymentFromEnv || 'gpt-5-2-codex-max';
        this.embeddingsEndpoint =
            (config.get('embeddingsEndpoint', '') || embeddingsEndpointFromEnv || this.endpoint).replace(/\/$/, '');
        this.embeddingsApiKey = config.get('embeddingsApiKey', '') || embeddingsApiKeyFromEnv || this.apiKey;
        this.embeddingsDeploymentName =
            config.get('embeddingsDeploymentName', '') || embeddingsDeploymentFromEnv || this.deploymentName;
        this.apiVersion = config.get('apiVersion', '') || apiVersionFromEnv || '2025-04-01-preview';
        this.embeddingsApiVersion =
            config.get('embeddingsApiVersion', '') || embeddingsApiVersionFromEnv || '2023-05-15';
        this.maxTokens = config.get('maxTokens', 4096);
        this.temperature = config.get('temperature', 0.2);
        this.autocompleteMaxTokens = config.get('autocompleteMaxTokens', 96);
        this.httpClient = axios_1.default.create({
            baseURL: this.endpoint,
            headers: {
                'api-key': this.apiKey,
                Authorization: this.apiKey ? `Bearer ${this.apiKey}` : undefined,
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });
        this.embeddingsHttpClient = axios_1.default.create({
            baseURL: this.embeddingsEndpoint,
            headers: {
                'api-key': this.embeddingsApiKey,
                Authorization: this.embeddingsApiKey ? `Bearer ${this.embeddingsApiKey}` : undefined,
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });
    }
    getResolvedTargets() {
        return {
            chat: {
                endpoint: this.endpoint,
                deployment: this.deploymentName,
                apiVersion: this.apiVersion
            },
            embeddings: {
                endpoint: this.embeddingsEndpoint,
                deployment: this.embeddingsDeploymentName,
                apiVersion: this.embeddingsApiVersion
            }
        };
    }
    isConfigured() {
        return !!(this.endpoint && this.apiKey);
    }
    isEmbeddingsConfigured() {
        return !!(this.embeddingsEndpoint && this.embeddingsApiKey && this.embeddingsDeploymentName);
    }
    async pingChat(options) {
        if (!this.isConfigured())
            throw new Error(this.getConfigError());
        // Reuse the same code path as the real chat UI to avoid schema drift.
        await this.chatToText([], 'ping', options);
    }
    async pingEmbeddings(options) {
        const [e] = await this.embed(['ping'], options);
        return Array.isArray(e) ? e.length : 0;
    }
    getConfigError() {
        if (!this.endpoint)
            return 'Azure OpenAI endpoint is not configured. Set azureCodex.endpoint in VS Code settings or AZURE_OPENAI_ENDPOINT in your workspace .env.';
        if (!this.apiKey)
            return 'Azure OpenAI API key is not configured. Set azureCodex.apiKey in VS Code settings or AZURE_OPENAI_API_KEY in your workspace .env.';
        return '';
    }
    async chat(history, userMessage, callbacks, options) {
        if (!this.isConfigured()) {
            callbacks.onError(this.getConfigError());
            return;
        }
        const conversation = [...history, { role: 'user', content: userMessage }];
        const preferResponses = this._shouldPreferResponsesApi();
        const model = options?.model || this.deploymentName;
        try {
            if (preferResponses) {
                await this._chatResponsesWithRetries(conversation, callbacks, options, model);
            }
            else {
                await this._chatCompletionsWithRetries(conversation, callbacks, options, model);
            }
        }
        catch (error) {
            if (this._isCanceled(error)) {
                callbacks.onError('Canceled');
                return;
            }
            const primaryError = await this._formatAxiosError(error);
            if (!preferResponses && this._shouldFallbackToResponses(error, primaryError)) {
                try {
                    await this._chatResponsesWithRetries(conversation, callbacks, options, model);
                    return;
                }
                catch (fallbackError) {
                    const fallbackMsg = await this._formatAxiosError(fallbackError);
                    callbacks.onError(`Azure OpenAI Error: ${fallbackMsg}`);
                    return;
                }
            }
            if (preferResponses && this._shouldFallbackToChatCompletions(error, primaryError)) {
                try {
                    await this._chatCompletionsWithRetries(conversation, callbacks, options, model);
                    return;
                }
                catch (fallbackError) {
                    const fallbackMsg = await this._formatAxiosError(fallbackError);
                    callbacks.onError(`Azure OpenAI Error: ${fallbackMsg}`);
                    return;
                }
            }
            callbacks.onError(`Azure OpenAI Error: ${primaryError}`);
        }
    }
    async chatToText(history, userMessage, options) {
        let out = '';
        await this.chat(history, userMessage, {
            onToken: (t) => (out += t),
            onDone: () => { },
            onError: (e) => {
                throw new Error(String(e || 'Unknown error'));
            }
        }, options);
        return out;
    }
    async embed(texts, options) {
        if (!this.isEmbeddingsConfigured()) {
            throw new Error('Embeddings are not configured. Set azureCodex.embeddingsEndpoint/embeddingsApiKey/embeddingsDeploymentName ' +
                'or AZURE_OPENAI_EMBEDDINGS_ENDPOINT/AZURE_OPENAI_EMBEDDINGS_API_KEY/AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT in .env.');
        }
        // Help catch the common misconfig where embeddings deployment was never set.
        if (this.embeddingsDeploymentName === this.deploymentName && /\bgpt-?5\b|\bcodex\b/i.test(this.deploymentName)) {
            throw new Error(`Embeddings deployment is set to "${this.embeddingsDeploymentName}" which looks like a chat model. ` +
                `Set AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT to an embeddings model (e.g. text-embedding-3-large).`);
        }
        const input = texts.map((t) => String(t ?? '').slice(0, 16000));
        const body = { model: this.embeddingsDeploymentName, input };
        try {
            const res = await this.embeddingsHttpClient.post(this._embeddingsUrl(), body, { signal: options?.signal });
            const out = res?.data?.data;
            if (!Array.isArray(out))
                throw new Error('Unexpected embeddings response shape.');
            const embeddings = out.map((d) => d?.embedding);
            if (embeddings.length !== input.length)
                throw new Error('Embeddings response length mismatch.');
            for (const e of embeddings) {
                if (!Array.isArray(e))
                    throw new Error('Unexpected embeddings response shape.');
            }
            return embeddings;
        }
        catch (error) {
            if (this._isCanceled(error))
                throw error;
            const msg = await this._formatAxiosError(error);
            // If the newer v1 embeddings route fails (common across Azure resource configs),
            // fall back to the legacy deployments/{deployment}/embeddings endpoint.
            try {
                const res = await this.embeddingsHttpClient.post(this._legacyEmbeddingsUrl(), { input }, { signal: options?.signal });
                const out = res?.data?.data;
                if (!Array.isArray(out))
                    throw new Error('Unexpected embeddings response shape.');
                const embeddings = out.map((d) => d?.embedding);
                if (embeddings.length !== input.length)
                    throw new Error('Embeddings response length mismatch.');
                for (const e of embeddings) {
                    if (!Array.isArray(e))
                        throw new Error('Unexpected embeddings response shape.');
                }
                return embeddings;
            }
            catch (legacyError) {
                if (this._isCanceled(legacyError))
                    throw legacyError;
                const legacyMsg = await this._formatAxiosError(legacyError);
                throw new Error(`Embeddings failed. v1: ${msg} | legacy: ${legacyMsg}`);
            }
        }
    }
    async completeInline(args, callbacks, options) {
        const lang = String(args.language || 'text');
        const prefix = String(args.prefix || '').slice(-6000);
        const suffix = String(args.suffix || '').slice(0, 2000);
        const input = [
            {
                role: 'system',
                content: 'You are an autocomplete engine. Return only the completion text to insert at the cursor. ' +
                    'Do not wrap in code fences. Do not include explanations.'
            },
            {
                role: 'user',
                content: `Language: ${lang}\n` +
                    `Prefix (cursor at end):\n${prefix}\n\n` +
                    `Suffix (text after cursor):\n${suffix}\n\n` +
                    `Return the best completion to insert at the cursor.`
            }
        ];
        const url = this._responsesUrl();
        const model = options?.model || this.deploymentName;
        const body = {
            model,
            input: input.map((m) => ({ role: m.role, content: this._toResponsesContent(m.content) })),
            max_output_tokens: this.autocompleteMaxTokens,
            stream: true,
            temperature: 0.0
        };
        const response = await this.httpClient.post(url, body, {
            responseType: 'stream',
            headers: { Accept: 'text/event-stream' },
            signal: options?.signal
        });
        await this._consumeSseStream(response.data, callbacks, (json) => {
            const type = json?.type;
            if (typeof type === 'string' && type.endsWith('.delta') && typeof json?.delta === 'string') {
                if (type.includes('output_text') || type.includes('text'))
                    return json.delta;
            }
            return null;
        });
    }
    _shouldPreferResponsesApi() {
        const versionDate = this._parseApiVersionDate(this.apiVersion);
        const isV1Endpoint = /\/openai\/v1\/?$/.test(this.endpoint);
        const looksLikeGpt5Deployment = /\bgpt-?5(\.|-|$)/i.test(this.deploymentName) || /\bcodex\b/i.test(this.deploymentName);
        return isV1Endpoint || looksLikeGpt5Deployment || (versionDate !== null && versionDate >= Date.parse('2025-01-01T00:00:00Z'));
    }
    _parseApiVersionDate(apiVersion) {
        const match = apiVersion.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!match)
            return null;
        const [_, y, m, d] = match;
        const parsed = Date.parse(`${y}-${m}-${d}T00:00:00Z`);
        return Number.isFinite(parsed) ? parsed : null;
    }
    _responsesUrl() {
        // Works with endpoints like:
        // - https://{resource}.openai.azure.com
        // - https://{resource}.cognitiveservices.azure.com
        // - https://{resource}.openai.azure.com/openai/v1
        if (/\/openai\/v1\/?$/.test(this.endpoint))
            return `/responses`;
        return `/openai/v1/responses`;
    }
    _embeddingsUrl() {
        if (/\/openai\/v1\/?$/.test(this.endpoint))
            return `/embeddings`;
        return `/openai/v1/embeddings`;
    }
    _legacyEmbeddingsUrl() {
        return `/openai/deployments/${this.embeddingsDeploymentName}/embeddings?api-version=${this.embeddingsApiVersion}`;
    }
    _shouldFallbackToLegacyEmbeddings(error, formattedError) {
        const status = error?.response?.status;
        const msg = formattedError.toLowerCase();
        if (status === 404)
            return true;
        if (status !== 400)
            return false;
        return msg.includes('unrecognized request url') || msg.includes('invalid url') || msg.includes('unknown field') || msg.includes('not found');
    }
    async _chatResponsesWithRetries(conversation, callbacks, options, model) {
        try {
            await this._chatResponses(conversation, callbacks, { includeTemperature: true }, options, model);
            return;
        }
        catch (error) {
            if (this._isCanceled(error))
                throw error;
            const msg = await this._formatAxiosError(error);
            if (this._isUnsupportedParamError(msg, 'temperature')) {
                await this._chatResponses(conversation, callbacks, { includeTemperature: false }, options, model);
                return;
            }
            throw error;
        }
    }
    async _chatResponses(conversation, callbacks, options, requestOptions, model) {
        const url = this._responsesUrl();
        const input = conversation.map((m) => ({ role: m.role, content: this._toResponsesContent(m.content) }));
        const body = {
            model,
            instructions: SYSTEM_PROMPT,
            input,
            max_output_tokens: this.maxTokens,
            stream: true
        };
        if (options.includeTemperature)
            body.temperature = this.temperature;
        const response = await this.httpClient.post(url, body, {
            responseType: 'stream',
            headers: { Accept: 'text/event-stream' },
            signal: requestOptions?.signal
        });
        await this._consumeSseStream(response.data, callbacks, (json) => {
            // OpenAI/Azure Responses streaming events usually carry text deltas like:
            // { "type": "response.output_text.delta", "delta": "..." }
            const type = json?.type;
            if (typeof type === 'string' && type.endsWith('.delta') && typeof json?.delta === 'string') {
                if (type.includes('output_text') || type.includes('text'))
                    return json.delta;
            }
            return null;
        });
    }
    async _chatCompletionsWithRetries(conversation, callbacks, options, model) {
        try {
            await this._chatCompletions(conversation, callbacks, { includeTemperature: true }, options, model);
            return;
        }
        catch (error) {
            if (this._isCanceled(error))
                throw error;
            const msg = await this._formatAxiosError(error);
            if (this._isUnsupportedParamError(msg, 'temperature')) {
                await this._chatCompletions(conversation, callbacks, { includeTemperature: false }, options, model);
                return;
            }
            throw error;
        }
    }
    async _chatCompletions(conversation, callbacks, options, requestOptions, model) {
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...conversation.map((m) => ({ role: m.role, content: this._toChatCompletionsContent(m.content) }))
        ];
        const url = `/openai/deployments/${model}/chat/completions?api-version=${this.apiVersion}`;
        const body = {
            messages,
            max_tokens: this.maxTokens,
            stream: true
        };
        if (options.includeTemperature)
            body.temperature = this.temperature;
        const response = await this.httpClient.post(url, body, {
            responseType: 'stream',
            headers: { Accept: 'text/event-stream' },
            signal: requestOptions?.signal
        });
        await this._consumeSseStream(response.data, callbacks, (json) => {
            const content = json?.choices?.[0]?.delta?.content;
            return typeof content === 'string' ? content : null;
        });
    }
    async _consumeSseStream(stream, callbacks, extractToken) {
        return await new Promise((resolve, reject) => {
            let buffer = '';
            const meta = {};
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]')
                        continue;
                    if (!trimmed.startsWith('data: '))
                        continue;
                    const payload = trimmed.slice(6);
                    try {
                        const json = JSON.parse(payload);
                        const token = extractToken(json);
                        if (token)
                            callbacks.onToken(token);
                        // Capture common end-of-stream metadata when available.
                        const fr = json?.choices?.[0]?.finish_reason;
                        if (typeof fr === 'string' && fr)
                            meta.finishReason = fr;
                        const type = json?.type;
                        if (typeof type === 'string' && type === 'response.completed') {
                            const status = json?.response?.status;
                            if (typeof status === 'string' && status === 'incomplete')
                                meta.incomplete = true;
                            const incompleteDetails = json?.response?.incomplete_details;
                            if (incompleteDetails)
                                meta.incomplete = true;
                        }
                    }
                    catch (_) {
                        // skip malformed chunks
                    }
                }
            });
            stream.on('end', () => {
                callbacks.onDone(meta);
                resolve();
            });
            stream.on('error', (err) => reject(err));
        });
    }
    _isCanceled(error) {
        const code = error?.code || error?.name;
        if (code === 'ERR_CANCELED' || code === 'CanceledError' || code === 'AbortError')
            return true;
        const msg = String(error?.message || '').toLowerCase();
        return msg.includes('canceled') || msg.includes('cancelled') || msg.includes('aborted');
    }
    async _formatAxiosError(error) {
        const status = error?.response?.status;
        const requestId = error?.response?.headers?.['x-request-id'] ||
            error?.response?.headers?.['apim-request-id'] ||
            error?.response?.headers?.['x-ms-request-id'];
        let message = await this._extractErrorMessage(error);
        if (!message)
            message = error?.message || 'Unknown error';
        const prefixParts = [];
        if (typeof status === 'number')
            prefixParts.push(`HTTP ${status}`);
        if (requestId)
            prefixParts.push(`requestId=${requestId}`);
        const prefix = prefixParts.length ? `${prefixParts.join(' ')}: ` : '';
        return `${prefix}${message}`;
    }
    async _extractErrorMessage(error) {
        const data = error?.response?.data;
        // When using responseType:'stream', Axios gives an IncomingMessage even for non-2xx.
        if (data && typeof data === 'object' && typeof data.on === 'function') {
            const text = await this._readStreamToString(data);
            const parsed = this._tryParseJson(text);
            return (parsed?.error?.message ||
                parsed?.message ||
                (typeof text === 'string' ? text.trim().slice(0, 2000) : ''));
        }
        if (typeof data === 'string') {
            const parsed = this._tryParseJson(data);
            return parsed?.error?.message || parsed?.message || data.trim().slice(0, 2000);
        }
        if (data && typeof data === 'object') {
            return data?.error?.message || data?.message || JSON.stringify(data);
        }
        return '';
    }
    _tryParseJson(text) {
        try {
            return JSON.parse(text);
        }
        catch {
            return null;
        }
    }
    async _readStreamToString(stream) {
        return await new Promise((resolve, reject) => {
            let out = '';
            stream.on('data', (chunk) => (out += chunk.toString()));
            stream.on('end', () => resolve(out));
            stream.on('error', reject);
        });
    }
    _isUnsupportedParamError(message, paramName) {
        const m = message.toLowerCase();
        const p = paramName.toLowerCase();
        return (m.includes(`unsupported parameter: '${p}'`) ||
            m.includes(`unsupported parameter: "${p}"`) ||
            m.includes(`unknown field: '${p}'`) ||
            m.includes(`unknown field: "${p}"`) ||
            m.includes(`unrecognized request argument: ${p}`) ||
            m.includes(`'${p}' is not supported`) ||
            m.includes(`"${p}" is not supported`));
    }
    _toResponsesContent(content) {
        if (typeof content === 'string')
            return content;
        if (!Array.isArray(content))
            return String(content);
        return content.map((p) => {
            const type = String(p?.type || '');
            if (type === 'text')
                return { type: 'input_text', text: p.text ?? '' };
            if (type === 'image_url') {
                const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
                return { type: 'input_image', image_url: url ?? '' };
            }
            if (type === 'input_text')
                return { type: 'input_text', text: p.text ?? '' };
            if (type === 'input_image')
                return { type: 'input_image', image_url: p.image_url ?? '' };
            return p;
        });
    }
    _toChatCompletionsContent(content) {
        if (typeof content === 'string')
            return content;
        if (!Array.isArray(content))
            return String(content);
        return content.map((p) => {
            const type = String(p?.type || '');
            if (type === 'input_text')
                return { type: 'text', text: p.text ?? '' };
            if (type === 'input_image')
                return { type: 'image_url', image_url: { url: p.image_url ?? '' } };
            if (type === 'text')
                return { type: 'text', text: p.text ?? '' };
            if (type === 'image_url') {
                const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
                return { type: 'image_url', image_url: { url: url ?? '' } };
            }
            return p;
        });
    }
    _shouldFallbackToResponses(error, formattedError) {
        const status = error?.response?.status;
        const msg = formattedError.toLowerCase();
        if (status === 404)
            return true;
        if (status !== 400)
            return false;
        return (msg.includes('chatcompletion') ||
            msg.includes('chat completions') ||
            msg.includes('operation does not work with the specified model') ||
            msg.includes('not supported for this model') ||
            msg.includes('unrecognized request url') ||
            msg.includes('invalid url'));
    }
    _shouldFallbackToChatCompletions(error, formattedError) {
        const status = error?.response?.status;
        const msg = formattedError.toLowerCase();
        if (status === 404)
            return true;
        if (status !== 400)
            return false;
        return (msg.includes('responses') ||
            msg.includes('/responses') ||
            msg.includes('unrecognized request url') ||
            msg.includes('invalid url') ||
            msg.includes('invalid request') ||
            msg.includes('unknown field') ||
            msg.includes('unsupported api version'));
    }
    _readDotEnvFromWorkspace() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || !folders.length)
            return {};
        const envPath = path.join(folders[0].uri.fsPath, '.env');
        if (!fs.existsSync(envPath))
            return {};
        try {
            const raw = fs.readFileSync(envPath, 'utf8');
            return this._parseDotEnv(raw);
        }
        catch {
            return {};
        }
    }
    _parseDotEnv(raw) {
        const out = {};
        const lines = String(raw || '').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const noExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
            const eq = noExport.indexOf('=');
            if (eq === -1)
                continue;
            const key = noExport.slice(0, eq).trim();
            let value = noExport.slice(eq + 1).trim();
            if (!key)
                continue;
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            out[key] = value;
        }
        return out;
    }
}
exports.AzureOpenAIClient = AzureOpenAIClient;
//# sourceMappingURL=azureClient.js.map