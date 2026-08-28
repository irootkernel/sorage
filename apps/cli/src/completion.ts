import type { Command } from "commander";

/**
 * Shell completion generation (CLI-015): the scripts are derived from the live
 * commander tree at runtime, so a command, option, or description change can never
 * drift out of the completion surface. Both scripts are print-only: sourcing them
 * defines the completion function, and registering it happens only when the shell's
 * completion machinery is actually present, which is what lets the script load in a
 * clean shell without compinit or bash-completion installed.
 */

interface CommandSummary {
  path: string;
  description: string;
}

function escapeSingleQuotes(text: string): string {
  return text.replaceAll("'", "'\\''");
}

function walkCommands(command: Command, prefix: string, summaries: CommandSummary[]): void {
  for (const child of command.commands) {
    if (child.name() === "help") continue;
    const path = prefix === "" ? child.name() : `${prefix} ${child.name()}`;
    summaries.push({ path, description: child.description() });
    walkCommands(child, path, summaries);
  }
}

function optionSpecs(command: Command): string[] {
  return command.options.map((option) => option.long ?? option.short ?? "").filter((spec) => spec !== "");
}

function zshCompletionScript(root: Command, cliName: string): string {
  const summaries: CommandSummary[] = [];
  walkCommands(root, "", summaries);
  const commandEntries = summaries
    .map((summary) => `    '${escapeSingleQuotes(summary.path)}:${escapeSingleQuotes(summary.description)}'`)
    .join("\n");
  const rootOptions = optionSpecs(root)
    .map((spec) => `      '${escapeSingleQuotes(spec)}'`)
    .join("\n");
  return `#compdef ${cliName}

_${cliName}() {
  local -a commands
  commands=(
${commandEntries}
  )
  _describe -t commands 'command' commands
  _arguments \\
${rootOptions}
}

if (( $+functions[compdef] )); then
  compdef _${cliName} ${cliName}
fi
`;
}

function bashCompletionScript(root: Command, cliName: string): string {
  const summaries: CommandSummary[] = [];
  walkCommands(root, "", summaries);
  const uniqueCommands = [...new Set(summaries.map((summary) => summary.path.split(" ")[0]))].sort();
  const options = optionSpecs(root).sort();
  return `_${cliName}() {
  local cur commands option_words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  commands="${uniqueCommands.join(" ")}"
  option_words="${options.join(" ")}"
  if [[ "\${COMP_CWORD}" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
  else
    COMPREPLY=( $(compgen -W "\${option_words}" -- "\${cur}") )
  fi
  return 0
}

complete -F _${cliName} ${cliName}
`;
}

/** Builds the completion script of one shell from the live command tree; null for an unsupported shell. */
export function buildCompletionScript(root: Command, shell: string, cliName: string): string | null {
  if (shell === "zsh") return zshCompletionScript(root, cliName);
  if (shell === "bash") return bashCompletionScript(root, cliName);
  return null;
}
