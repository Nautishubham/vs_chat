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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectStackDetector = void 0;
const vscode = __importStar(require("vscode"));
const STACK_FILES = [
    'package.json',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
    'requirements.txt',
    'pyproject.toml',
    'Pipfile',
    'poetry.lock',
    'go.mod',
    'Gemfile',
    'pom.xml',
    'Cargo.toml',
    'pubspec.yaml',
    'composer.json',
    'build.gradle',
    'build.gradle.kts',
    'CMakeLists.txt',
    '.nvmrc',
    '.python-version'
];
class ProjectStackDetector {
    constructor() {
        this._cacheKey = '';
        this._cacheValue = null;
    }
    async detect(workspaceRoot) {
        const key = workspaceRoot.toString();
        if (this._cacheValue && this._cacheKey === key)
            return this._cacheValue;
        const present = await this._readIndicators(workspaceRoot);
        const packageJson = await this._tryReadJson(workspaceRoot, 'package.json');
        const pyProject = await this._tryReadText(workspaceRoot, 'pyproject.toml');
        const reqTxt = await this._tryReadText(workspaceRoot, 'requirements.txt');
        const goMod = await this._tryReadText(workspaceRoot, 'go.mod');
        const cargoToml = await this._tryReadText(workspaceRoot, 'Cargo.toml');
        const gemfile = await this._tryReadText(workspaceRoot, 'Gemfile');
        let language = 'Unknown';
        let languageVersion = 'unknown';
        let framework = 'None';
        let frameworkVersion = 'unknown';
        let packageManager = 'unknown';
        let testRunner = 'unknown';
        let linter = 'unknown';
        let formatter = 'unknown';
        let buildTool = 'unknown';
        let buildCommand = 'unknown';
        let devCommand = 'unknown';
        let testCommand = 'unknown';
        let entryPoints = [];
        if (packageJson) {
            language = 'TypeScript/JavaScript';
            packageManager = this._detectNodePackageManager(present);
            const engines = packageJson.engines || {};
            languageVersion = String(engines.node || this._extractTsVersion(packageJson) || 'unknown');
            const deps = {
                ...(packageJson.dependencies || {}),
                ...(packageJson.devDependencies || {})
            };
            const scripts = (packageJson.scripts || {});
            const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
            if (has('next')) {
                framework = 'Next.js';
                frameworkVersion = String(deps.next || 'unknown');
            }
            else if (has('react')) {
                framework = 'React';
                frameworkVersion = String(deps.react || 'unknown');
            }
            else if (has('vue')) {
                framework = 'Vue';
                frameworkVersion = String(deps.vue || 'unknown');
            }
            else if (has('@angular/core')) {
                framework = 'Angular';
                frameworkVersion = String(deps['@angular/core'] || 'unknown');
            }
            else if (has('express')) {
                framework = 'Express';
                frameworkVersion = String(deps.express || 'unknown');
            }
            testRunner = this._pickFirst([
                has('vitest') || scripts.test?.includes('vitest') ? 'Vitest' : '',
                has('jest') || has('@jest/core') || scripts.test?.includes('jest') ? 'Jest' : '',
                has('mocha') || scripts.test?.includes('mocha') ? 'Mocha' : '',
                scripts.test ? 'npm script:test' : ''
            ]);
            linter = this._pickFirst([
                has('eslint') ? 'ESLint' : '',
                has('tslint') ? 'TSLint' : '',
                scripts.lint ? 'npm script:lint' : ''
            ]);
            formatter = this._pickFirst([
                has('prettier') ? 'Prettier' : '',
                scripts.format ? 'npm script:format' : ''
            ]);
            buildTool = this._pickFirst([
                has('typescript') ? 'TypeScript (tsc)' : '',
                has('vite') ? 'Vite' : '',
                has('webpack') ? 'Webpack' : '',
                scripts.build ? 'npm scripts' : ''
            ]);
            buildCommand = this._pickScriptCommand(packageManager, scripts, ['build', 'compile', 'vscode:prepublish']);
            devCommand = this._pickScriptCommand(packageManager, scripts, ['dev', 'start', 'watch']);
            testCommand = this._pickScriptCommand(packageManager, scripts, ['test']);
            entryPoints = this._detectNodeEntryPoints(packageJson, scripts);
        }
        else if (pyProject || reqTxt || present.has('.python-version')) {
            language = 'Python';
            languageVersion = (await this._tryReadText(workspaceRoot, '.python-version'))?.trim() || 'unknown';
            packageManager = pyProject?.includes('[tool.poetry]') ? 'poetry' : 'pip';
            framework = this._detectPythonFramework(pyProject || reqTxt || '');
            frameworkVersion = 'unknown';
            testRunner = /pytest/i.test(pyProject || reqTxt || '') ? 'pytest' : 'unittest';
            linter = /ruff|flake8|pylint/i.test(pyProject || reqTxt || '') ? 'ruff/flake8/pylint' : 'unknown';
            formatter = /black|autopep8|yapf/i.test(pyProject || reqTxt || '') ? 'black/autopep8/yapf' : 'unknown';
            buildTool = 'python';
            buildCommand = 'python -m build';
            devCommand = 'python main.py';
            testCommand = testRunner === 'pytest' ? 'pytest' : 'python -m unittest';
            entryPoints = ['main.py', 'app.py', 'manage.py'];
        }
        else if (goMod) {
            language = 'Go';
            framework = 'Go modules';
            packageManager = 'go';
            testRunner = 'go test';
            linter = 'golangci-lint/gofmt';
            formatter = 'gofmt';
            buildTool = 'go';
            buildCommand = 'go build ./...';
            devCommand = 'go run .';
            testCommand = 'go test ./...';
            entryPoints = ['main.go'];
        }
        else if (cargoToml) {
            language = 'Rust';
            framework = 'Cargo';
            packageManager = 'cargo';
            testRunner = 'cargo test';
            linter = 'clippy';
            formatter = 'rustfmt';
            buildTool = 'cargo';
            buildCommand = 'cargo build';
            devCommand = 'cargo run';
            testCommand = 'cargo test';
            entryPoints = ['src/main.rs', 'src/lib.rs'];
        }
        else if (gemfile) {
            language = 'Ruby';
            framework = 'Ruby/Bundler';
            packageManager = 'bundler';
            testRunner = 'rspec';
            linter = 'rubocop';
            formatter = 'rubocop';
            buildTool = 'ruby';
            buildCommand = 'bundle exec rake build';
            devCommand = 'bundle exec ruby app.rb';
            testCommand = 'bundle exec rspec';
            entryPoints = ['app.rb', 'config.ru'];
        }
        if (!entryPoints.length) {
            entryPoints = ['README.md'];
        }
        const stack = {
            language,
            languageVersion,
            framework,
            frameworkVersion,
            packageManager,
            testRunner,
            linter,
            formatter,
            buildTool,
            buildCommand,
            devCommand,
            testCommand,
            entryPoints,
            indicators: [...present],
            summary: `🔍 Detected: ${language} / ${framework}${frameworkVersion !== 'unknown' ? ` ${frameworkVersion}` : ''} / ${packageManager} / ${testRunner} / ${linter} — ready`
        };
        this._cacheKey = key;
        this._cacheValue = stack;
        return stack;
    }
    async _readIndicators(workspaceRoot) {
        const present = new Set();
        for (const file of STACK_FILES) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceRoot, file));
                present.add(file);
            }
            catch {
                // ignore
            }
        }
        return present;
    }
    async _tryReadText(workspaceRoot, relPath) {
        try {
            const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceRoot, relPath));
            return Buffer.from(raw).toString('utf8');
        }
        catch {
            return null;
        }
    }
    async _tryReadJson(workspaceRoot, relPath) {
        const text = await this._tryReadText(workspaceRoot, relPath);
        if (!text)
            return null;
        try {
            return JSON.parse(text);
        }
        catch {
            return null;
        }
    }
    _detectNodePackageManager(indicators) {
        if (indicators.has('pnpm-lock.yaml'))
            return 'pnpm';
        if (indicators.has('yarn.lock'))
            return 'yarn';
        if (indicators.has('bun.lockb') || indicators.has('bun.lock'))
            return 'bun';
        if (indicators.has('package-lock.json'))
            return 'npm';
        return 'npm';
    }
    _pickScriptCommand(packageManager, scripts, names) {
        const script = names.find((name) => typeof scripts[name] === 'string' && scripts[name].trim());
        if (!script)
            return 'unknown';
        if (packageManager === 'yarn')
            return `yarn ${script}`;
        if (packageManager === 'pnpm')
            return `pnpm ${script}`;
        if (packageManager === 'bun')
            return `bun run ${script}`;
        return `npm run ${script}`;
    }
    _detectNodeEntryPoints(packageJson, scripts) {
        const out = [];
        if (typeof packageJson.main === 'string' && packageJson.main.trim())
            out.push(String(packageJson.main));
        if (typeof packageJson.module === 'string' && packageJson.module.trim())
            out.push(String(packageJson.module));
        if (scripts.dev)
            out.push('src/** (via dev script)');
        if (scripts.start)
            out.push('src/** (via start script)');
        if (scripts.watch)
            out.push('src/** (via watch script)');
        if (!out.length)
            out.push('src/index.ts');
        return Array.from(new Set(out));
    }
    _detectPythonFramework(text) {
        const t = text.toLowerCase();
        if (t.includes('django'))
            return 'Django';
        if (t.includes('fastapi'))
            return 'FastAPI';
        if (t.includes('flask'))
            return 'Flask';
        return 'Python';
    }
    _pickFirst(values) {
        for (const value of values) {
            if (value && value.trim())
                return value;
        }
        return 'unknown';
    }
    _extractTsVersion(packageJson) {
        const deps = {
            ...(packageJson?.dependencies || {}),
            ...(packageJson?.devDependencies || {})
        };
        return String(deps.typescript || deps['@types/node'] || 'unknown');
    }
}
exports.ProjectStackDetector = ProjectStackDetector;
//# sourceMappingURL=projectStackDetector.js.map