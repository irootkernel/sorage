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
  options: string[];
}

function escapeSingleQuotes(text: string): string {
  return text.replaceAll("'", "'\\''");
}

function isHiddenCommand(command: Command): boolean {
  return (command as { _hidden?: boolean })._hidden === true;
}

function optionSpecs(command: Command): string[] {
  return command.options
    .filter((option) => !option.hidden)
    .map((option) => option.long ?? option.short ?? "")
    .filter((spec) => spec !== "");
}

function walkCommands(command: Command, prefix: string, inheritedOptions: string[], summaries: CommandSummary[]): void {
  for (const child of command.commands) {
    if (child.name() === "help" || isHiddenCommand(child)) continue;
    const path = prefix === "" ? child.name() : `${prefix} ${child.name()}`;
    const options = [...new Set([...inheritedOptions, ...optionSpecs(child)])];
    summaries.push({ path, description: child.description(), options });
    walkCommands(child, path, options, summaries);
  }
}

function zshCompletionScript(root: Command, cliName: string): string {
  const summaries: CommandSummary[] = [];
  walkCommands(root, "", [], summaries);
  const commandEntries = summaries
    .map((summary) => `    '${escapeSingleQuotes(summary.path)}:${escapeSingleQuotes(summary.description)}'`)
    .join("\n");
  const rootSpecs = optionSpecs(root);
  const rootOptions = rootSpecs.map((spec) => `      '${escapeSingleQuotes(spec)}'`).join("\n");
  const formatZshArguments = (specs: string[]): string =>
    [...new Set([...rootSpecs, ...specs])].map((spec) => `'${escapeSingleQuotes(spec)}'`).join(" ");
  const twoWordCases = summaries
    .filter((summary) => summary.options.length > 0 && summary.path.includes(" "))
    .map(
      (summary) =>
        `    '${escapeSingleQuotes(summary.path)}') _arguments ${formatZshArguments(summary.options)}; return ;;`,
    )
    .join("\n");
  const oneWordCases = summaries
    .filter((summary) => summary.options.length > 0 && !summary.path.includes(" "))
    .map((summary) => `    ${summary.path}) _arguments ${formatZshArguments(summary.options)}; return ;;`)
    .join("\n");
  const twoWordBlock = twoWordCases === "" ? "" : `  case "$words[2] $words[3]" in\n${twoWordCases}\n  esac\n`;
  return `#compdef ${cliName}

_${cliName}() {
  local -a commands
  commands=(
${commandEntries}
  )
  _describe -t commands 'command' commands
${twoWordBlock}  case "$words[2]" in
${oneWordCases}
  esac
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
  walkCommands(root, "", [], summaries);
  const uniqueCommands = [...new Set(summaries.map((summary) => summary.path.split(" ")[0]))].sort();
  const options = optionSpecs(root).sort();
  const rootOptionSet = new Set(options);
  const extraOptions = (specs: string[]): string[] => specs.filter((spec) => !rootOptionSet.has(spec));
  const twoWordCases = summaries
    .map((summary) => ({ path: summary.path, extra: extraOptions(summary.options) }))
    .filter((summary) => summary.extra.length > 0 && summary.path.includes(" "))
    .map(
      (summary) =>
        `    '${escapeSingleQuotes(summary.path)}') option_words="$option_words ${summary.extra.join(" ")}" ;;`,
    )
    .join("\n");
  const oneWordCases = summaries
    .map((summary) => ({ path: summary.path, extra: extraOptions(summary.options) }))
    .filter((summary) => summary.extra.length > 0 && !summary.path.includes(" "))
    .map((summary) => `      ${summary.path}) option_words="$option_words ${summary.extra.join(" ")}" ;;`)
    .join("\n");
  return `_${cliName}() {
  local cur commands option_words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  commands="${uniqueCommands.join(" ")}"
  option_words="${options.join(" ")}"
  case "\${COMP_WORDS[1]} \${COMP_WORDS[2]}" in
${twoWordCases}
    *)
      case "\${COMP_WORDS[1]}" in
${oneWordCases}
      esac
      ;;
  esac
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
