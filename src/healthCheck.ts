import * as vscode from 'vscode';
import { AzureOpenAIClient } from './azureClient';

export async function runHealthCheck(client: AzureOpenAIClient): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Azure Codex: Running health check…' },
    async (progress) => {
      // Reload on-demand so changes to workspace .env are picked up immediately.
      client.reloadConfig();

      const targets = client.getResolvedTargets();
      const results: string[] = [];

      progress.report({ message: 'Checking configuration…' });
      if (!client.isConfigured()) {
        vscode.window.showErrorMessage(client.getConfigError());
        return;
      }

      progress.report({ message: 'Pinging chat model…' });
      try {
        await client.pingChat();
        results.push(`Chat: OK (${targets.chat.deployment})`);
      } catch (e: any) {
        results.push(`Chat: FAILED (${targets.chat.deployment}) (${e?.message || String(e)})`);
      }

      progress.report({ message: 'Pinging embeddings…' });
      try {
        const dims = await client.pingEmbeddings();
        results.push(`Embeddings: OK (${targets.embeddings.deployment}, dim=${dims})`);
      } catch (e: any) {
        results.push(`Embeddings: FAILED (${targets.embeddings.deployment}) (${e?.message || String(e)})`);
      }

      const allOk = results.every((r) => r.includes(': OK'));
      if (allOk) {
        vscode.window.showInformationMessage(`Azure Codex health check passed: ${results.join(' · ')}`);
      } else {
        vscode.window.showWarningMessage(
          `Azure Codex health check: ${results.join(' · ')}\n` +
            `Chat endpoint: ${targets.chat.endpoint}\n` +
            `Embeddings endpoint: ${targets.embeddings.endpoint}`
        );
      }
    }
  );
}
