import * as vscode from 'vscode';

export type ChatModelMode = 'smart' | 'fast';

export class ModelRouter {
  getChatDeployment(defaultDeployment: string): string {
    const cfg = vscode.workspace.getConfiguration('azureCodex');
    const mode = (cfg.get<string>('chatModelMode', 'smart') || 'smart').toLowerCase() as ChatModelMode;
    const fast = cfg.get<string>('chatFastDeploymentName', '').trim();
    const smart = cfg.get<string>('chatSmartDeploymentName', '').trim();
    if (mode === 'fast' && fast) return fast;
    if (mode === 'smart' && smart) return smart;
    return defaultDeployment;
  }

  getAgentDeployment(defaultDeployment: string): string {
    const cfg = vscode.workspace.getConfiguration('azureCodex');
    const agent = cfg.get<string>('agentDeploymentName', '').trim();
    return agent || this.getChatDeployment(defaultDeployment);
  }

  getAutocompleteDeployment(defaultDeployment: string): string {
    const cfg = vscode.workspace.getConfiguration('azureCodex');
    const ac = cfg.get<string>('autocompleteDeploymentName', '').trim();
    const fast = cfg.get<string>('chatFastDeploymentName', '').trim();
    return ac || fast || defaultDeployment;
  }
}

