import * as vscode from 'vscode';
import { AzureOpenAIClient } from './azureClient';
import { runHealthCheck } from './healthCheck';

function normalizeEndpoint(value: string): string {
  const v = String(value || '').trim();
  if (!v) return '';
  return v.replace(/\/+$/, '');
}

export async function configureEmbeddingsSettings(client: AzureOpenAIClient): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('azureCodex');

  const endpoint = normalizeEndpoint(
    (await vscode.window.showInputBox({
      prompt: 'Embeddings endpoint (base resource URL)',
      placeHolder: 'https://<resource>.openai.azure.com',
      value: normalizeEndpoint(cfg.get<string>('embeddingsEndpoint', ''))
    })) ?? ''
  );
  if (!endpoint) return;

  const deploymentName =
    (await vscode.window.showInputBox({
      prompt: 'Embeddings deployment name',
      placeHolder: 'text-embedding-3-large',
      value: cfg.get<string>('embeddingsDeploymentName', '') || 'text-embedding-3-large'
    })) || '';
  if (!deploymentName.trim()) return;

  const apiVersion =
    (await vscode.window.showInputBox({
      prompt: 'Embeddings api-version (legacy deployments embeddings endpoint)',
      placeHolder: '2023-05-15',
      value: cfg.get<string>('embeddingsApiVersion', '') || '2023-05-15'
    })) || '';
  if (!apiVersion.trim()) return;

  const apiKey =
    (await vscode.window.showInputBox({
      prompt: 'Embeddings API key (stored in VS Code settings)',
      password: true,
      value: cfg.get<string>('embeddingsApiKey', '')
    })) || '';
  if (!apiKey.trim()) return;

  const target = vscode.ConfigurationTarget.Global;
  await cfg.update('embeddingsEndpoint', endpoint, target);
  await cfg.update('embeddingsDeploymentName', deploymentName.trim(), target);
  await cfg.update('embeddingsApiVersion', apiVersion.trim(), target);
  await cfg.update('embeddingsApiKey', apiKey.trim(), target);

  client.reloadConfig();

  const picked = await vscode.window.showInformationMessage(
    'Azure Codex: Saved embeddings settings to your user settings.',
    'Run Health Check'
  );
  if (picked === 'Run Health Check') {
    await runHealthCheck(client);
  }
}
