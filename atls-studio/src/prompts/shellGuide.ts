/**
 * Shell-specific guidance for agent mode.
 * Each shell variant tells the model what shell operations are allowed.
 */

const POWERSHELL_DOCS = `## SHELL: PowerShell (Windows)
Shell is for system operations ONLY: builds, packages, git, process management.
For ALL code operations (read, search, edit, refactor): use ATLS tools.
NEVER use Get-Content, Select-String, or regex scripts on code files.
| Task | Command |
|------|---------|
| Build | cargo build, npm run build |
| Packages | npm install, pip install |
| Git | git status, git diff, git log |
| Processes | Get-Process, Stop-Process |
| Environment | $env:VAR |
| Chain commands | cmd1; cmd2 |`;

const UNIX_SHELL_DOCS = `## SHELL: Bash/Zsh
Shell is for system operations ONLY: builds, packages, git, process management.
For ALL code operations (read, search, edit, refactor): use ATLS tools.
NEVER use cat, grep, sed, awk, or find for code reading or modification.
| Task | Command |
|------|---------|
| Build | cargo build, npm run build |
| Packages | npm install, pip install |
| Git | git status, git diff, git log |
| Processes | ps, kill |
| Environment | echo $VAR |`;

export function getShellGuide(shell: string): string {
  if (shell === 'powershell') return `\n${POWERSHELL_DOCS}`;
  if (shell === 'bash' || shell === 'zsh') return `\n${UNIX_SHELL_DOCS}`;
  return `\nShell: ${shell}`;
}
