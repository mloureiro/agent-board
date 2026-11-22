import type { Command } from 'commander';
import { EFFORTS, MODEL_ALIASES, PRIORITIES, STATUSES, TASK_ACTORS } from '@agent-board/shared';
import { EVENT_TYPES } from '../events/diff.mts';
import { DIR_SETTINGS, TOP_KEYS } from '../config/config.mts';
import { shellQuote } from '../output/text.mts';
import { WORKER_UNITS } from '../setup/units.mts';

export const SHELLS = ['bash', 'zsh', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

interface CommandModel {
  name: string;
  summary: string;
  flags: string[];
  // What the positional words complete to, in order.
  positionals: (
    | 'task'
    | 'status'
    | 'schedule-action'
    | 'schedule'
    | 'dirs-action'
    | 'dirs-key'
    | 'config-action'
    | 'config-key'
    | 'task-action'
    | 'task-key'
    | 'agents-action'
    | 'command'
    | 'shell'
    | 'unit'
    | 'log-target'
  )[];
}

export interface CompletionModel {
  commands: CommandModel[];
  globalFlags: string[];
  // Flags that take a separate value word, so the word after them is not a positional.
  valueFlags: string[];
  flagValues: Record<string, string[]>;
  // Flags whose value is a task id.
  taskFlags: string[];
  fileFlags: string[];
  // Value flags whose value is free text: nothing completes after them.
  freeFlags: string[];
}

const FLAG_VALUES: Record<string, string[]> = {
  '--status': [...STATUSES],
  '--priority': [...PRIORITIES],
  '--model': MODEL_ALIASES.map((alias) => alias.value),
  '--effort': [...EFFORTS],
  '--type': [...EVENT_TYPES],
  '--actor': [...TASK_ACTORS],
};

function positionalsOf(command: Command): CommandModel['positionals'] {
  if (command.name() === 'help') return ['command'];
  if (command.name() === 'completion') return ['shell'];
  if (command.name() === 'schedules') return ['schedule-action', 'schedule'];
  if (command.name() === 'dirs') return ['dirs-action', 'dirs-key'];
  if (command.name() === 'config') return ['config-action', 'config-key'];
  if (command.name() === 'agents') return ['agents-action'];
  if (command.name() === 'restart') return ['unit'];
  if (command.name() === 'logs') return ['log-target'];
  if (command.name() === 'move') return ['task', 'status'];
  if (command.name() === 'task') return ['task', 'task-action', 'task-key'];
  return command.registeredArguments[0]?.name() === 'task' ? ['task'] : [];
}

// The visible commands and flags of the program, so a new command or flag completes without a second list.
export function completionModel(program: Command): CompletionModel {
  const help = program.createHelp();
  const longFlags = (command: Command): { flag: string; takesValue: boolean }[] =>
    help
      .visibleOptions(command)
      .flatMap((option) =>
        option.long ? [{ flag: option.long, takesValue: option.required || option.optional }] : [],
      );
  const commands = help.visibleCommands(program).map((command): CommandModel => ({
    name: command.name(),
    summary: command.summary() || command.description(),
    flags: longFlags(command).map(({ flag }) => flag),
    positionals: positionalsOf(command),
  }));
  const all = [program, ...help.visibleCommands(program)];
  const valueFlags = [
    ...new Set(
      all.flatMap((command) =>
        longFlags(command)
          .filter((entry) => entry.takesValue)
          .map((entry) => entry.flag),
      ),
    ),
  ];
  const taskFlags: string[] = valueFlags.filter((flag) => flag === '--parent' || flag === '--task');
  const fileFlags: string[] = valueFlags.filter(
    (flag) => flag === '--file' || flag === '--token-file' || flag === '--data-key-file',
  );
  const flagValues = Object.fromEntries(Object.entries(FLAG_VALUES).filter(([flag]) => valueFlags.includes(flag)));
  return {
    commands,
    globalFlags: longFlags(program).map(({ flag }) => flag),
    valueFlags,
    flagValues,
    taskFlags,
    fileFlags,
    freeFlags: valueFlags.filter(
      (flag) => !(flag in flagValues) && !taskFlags.includes(flag) && !fileFlags.includes(flag),
    ),
  };
}

const words = (list: readonly string[]): string => list.join(' ');

type Kind = CommandModel['positionals'][number];

// The words each positional offers, as a shell snippet's alternatives.
function positionalWords(kind: Kind, model: CompletionModel): string | undefined {
  switch (kind) {
    case 'status':
      return words(STATUSES);
    case 'schedule-action':
      return 'pause resume rm edit';
    case 'dirs-action':
      return 'list add rm set unset';
    case 'dirs-key':
      return words(DIR_SETTINGS);
    case 'config-action':
      return 'show get set unset edit path';
    case 'config-key':
      return words(TOP_KEYS);
    case 'task-action':
      return 'set unset';
    case 'task-key':
      return 'priority model effort lane auto-done icon labels dir prompt';
    case 'agents-action':
      return 'list show export add rm';
    case 'command':
      return words(model.commands.map((command) => command.name));
    case 'shell':
      return words(SHELLS);
    case 'unit':
    case 'log-target':
      return words(WORKER_UNITS);
    default:
      return undefined;
  }
}

function bash(model: CompletionModel): string {
  const flagCases = model.commands
    .map((command) => `      ${command.name}) __board_reply < <(compgen -W "${words(command.flags)}" -- "$cur") ;;`)
    .join('\n');
  const valueCases = [
    ...Object.entries(model.flagValues).map(
      ([flag, values]) => `    ${flag}) __board_reply < <(compgen -W "${words(values)}" -- "$cur"); return ;;`,
    ),
    ...model.taskFlags.map(
      (flag) => `    ${flag}) __board_reply < <(compgen -W "$(__board_ids tasks)" -- "$cur"); return ;;`,
    ),
    ...model.fileFlags.map((flag) => `    ${flag}) __board_files; return ;;`),
    ...(model.freeFlags.length > 0 ? [`    ${model.freeFlags.join('|')}) return ;;`] : []),
  ].join('\n');
  const positionalCases = model.commands
    .filter((command) => command.positionals.length > 0)
    .map((command) => {
      const lines = command.positionals.map((kind, index) => {
        const guard =
          kind === 'schedule'
            ? ' && [[ " pause resume rm edit " == *" $first "* ]]'
            : kind === 'dirs-key'
              ? ' && [[ " set unset " == *" $first "* ]]'
              : kind === 'config-key'
                ? ' && [[ " get set unset " == *" $first "* ]]'
                : '';
        const candidates =
          kind === 'task'
            ? '$(__board_ids tasks)'
            : kind === 'schedule'
              ? '$(__board_ids schedules)'
              : kind === 'log-target'
                ? `${positionalWords(kind, model)} $(__board_ids tasks)`
                : positionalWords(kind, model);
        return `        if (( pos == ${index} ))${guard}; then __board_reply < <(compgen -W "${candidates}" -- "$cur"); fi`;
      });
      return `      ${command.name})\n${lines.join('\n')} ;;`;
    })
    .join('\n');
  return `# bash completion for board; generated by "board completion bash"
__board_ids() { board __complete "$1" 2>/dev/null | cut -f1; }

# Reads the candidates, one per line, into COMPREPLY (a line may hold a space).
__board_reply() {
  COMPREPLY=()
  local line
  while IFS= read -r line; do COMPREPLY+=("$line"); done
}

__board_files() {
  compopt -o filenames 2>/dev/null
  __board_reply < <(compgen -f -- "\${cur//\\\\/}")
}

_board() {
  # COMP_WORDS splits at ":" (COMP_WORDBREAKS), which would cut a task link or 09:30 in two; join the pieces again.
  local -a words=()
  local i word merge=0
  for ((i = 0; i <= COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    if [[ "$word" == ":" ]]; then
      words[\${#words[@]}-1]+="$word"; merge=1
    elif ((merge)); then
      words[\${#words[@]}-1]+="$word"; merge=0
    else
      words+=("$word")
    fi
  done
  local last=$((\${#words[@]} - 1))
  (( last >= 1 )) || return 0
  local cur="\${words[last]}" prev="\${words[last-1]}"
  local cmd="" first="" pos=0 skip=0
  COMPREPLY=()
  for ((i = 1; i < last; i++)); do
    word="\${words[i]}"
    if ((skip)); then skip=0; continue; fi
    case "$word" in
      ${model.valueFlags.join('|')}) skip=1; continue ;;
      -*) continue ;;
    esac
    if [[ -z "$cmd" ]]; then cmd="$word"; else
      pos=$((pos + 1))
      [[ $pos -eq 1 ]] && first="$word"
    fi
  done
  case "$prev" in
${valueCases}
  esac
  if [[ -z "$cmd" ]]; then
    __board_reply < <(compgen -W "${words(model.commands.map((command) => command.name))} ${words(model.globalFlags)}" -- "$cur")
    return 0
  fi
  if [[ "$cur" == -* ]]; then
    case "$cmd" in
${flagCases}
    esac
    return 0
  fi
  case "$cmd" in
${positionalCases}
  esac
}
complete -F _board board
`;
}

function zsh(model: CompletionModel): string {
  const commandList = model.commands
    .map((command) => `    ${shellQuote(`${command.name}:${command.summary.replaceAll(':', '\\:')}`)}`)
    .join('\n');
  const flagCases = model.commands
    .map((command) => `      (${command.name}) compadd -- ${words(command.flags)} ;;`)
    .join('\n');
  const valueCases = [
    ...Object.entries(model.flagValues).map(([flag, values]) => `    (${flag}) compadd -- ${words(values)}; return ;;`),
    ...model.taskFlags.map((flag) => `    (${flag}) __board_ids tasks; return ;;`),
    ...model.fileFlags.map((flag) => `    (${flag}) _files; return ;;`),
    ...(model.freeFlags.length > 0 ? [`    (${model.freeFlags.join('|')}) return ;;`] : []),
  ].join('\n');
  const positionalCases = model.commands
    .filter((command) => command.positionals.length > 0)
    .map((command) => {
      const lines = command.positionals.map((kind, index) => {
        const guard =
          kind === 'schedule'
            ? ' && [[ $first == (pause|resume|rm|edit) ]]'
            : kind === 'dirs-key'
              ? ' && [[ $first == (set|unset) ]]'
              : kind === 'config-key'
                ? ' && [[ $first == (get|set|unset) ]]'
                : '';
        const offer =
          kind === 'task'
            ? '__board_ids tasks'
            : kind === 'schedule'
              ? '__board_ids schedules'
              : kind === 'log-target'
                ? `compadd -- ${positionalWords(kind, model)}; __board_ids tasks`
                : `compadd -- ${positionalWords(kind, model)}`;
        return `        if (( pos == ${index} ))${guard}; then ${offer}; fi`;
      });
      return `      (${command.name})\n${lines.join('\n')} ;;`;
    })
    .join('\n');
  return `#compdef board
# zsh completion for board; generated by "board completion zsh"
__board_ids() {
  local -a ids
  local line id
  for line in \${(f)"$(board __complete "$1" 2>/dev/null)"}; do
    id=\${line%%$'\\t'*}
    ids+=("\${id//:/\\\\:}:\${line#*$'\\t'}")
  done
  _describe -t ids "$1" ids
}

_board() {
  local cur=\${words[CURRENT]} prev=\${words[CURRENT-1]} cmd="" first="" pos=0 skip=0 i word
  local -a commands
  commands=(
${commandList}
  )
  for ((i = 2; i < CURRENT; i++)); do
    word=\${words[i]}
    if ((skip)); then skip=0; continue; fi
    case $word in
      (${model.valueFlags.join('|')}) skip=1; continue ;;
      (-*) continue ;;
    esac
    if [[ -z $cmd ]]; then cmd=$word; else
      pos=$((pos + 1))
      (( pos == 1 )) && first=$word
    fi
  done
  case $prev in
${valueCases}
  esac
  if [[ -z $cmd ]]; then
    _describe -t commands command commands
    compadd -- ${words(model.globalFlags)}
    return
  fi
  if [[ $cur == -* ]]; then
    case $cmd in
${flagCases}
    esac
    return
  fi
  case $cmd in
${positionalCases}
  esac
}

if [ "$funcstack[1]" = "_board" ]; then
  _board "$@"
else
  compdef _board board
fi
`;
}

const fishQuote = (text: string): string => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

function fish(model: CompletionModel): string {
  const lines: string[] = [];
  const names = model.commands.map((command) => command.name);
  const taskCommands = model.commands
    .filter((command) => command.positionals[0] === 'task')
    .map((command) => command.name);
  lines.push(
    '# fish completion for board; generated by "board completion fish"',
    'function __board_ids; board __complete $argv[1] 2>/dev/null; end',
    '# the words typed so far that are not flags or the values of flags: the command, then its arguments',
    'function __board_positionals',
    '  set -l skip 0',
    '  for token in (commandline -opc)[2..-1]',
    '    if test $skip -eq 1; set skip 0; continue; end',
    '    switch $token',
    `      case ${model.valueFlags.join(' ')}`,
    '        set skip 1',
    "      case '-*'",
    "      case '*'",
    '        echo $token',
    '    end',
    '  end',
    'end',
    '# true while the word being typed is the value of a flag',
    'function __board_value_pending',
    `  contains -- (commandline -opc)[-1] ${model.valueFlags.join(' ')}`,
    'end',
    '# true when $argv[1] words (the command included) are typed and the command is one of the others',
    'function __board_at',
    '  __board_value_pending; and return 1',
    '  set -l positionals (__board_positionals)',
    '  test (count $positionals) -eq $argv[1]; and contains -- "$positionals[1]" $argv[2..-1]',
    'end',
    'function __board_dirs_key',
    '  __board_value_pending; and return 1',
    '  set -l positionals (__board_positionals)',
    '  test (count $positionals) -eq 2; and test "$positionals[1]" = dirs; and contains -- "$positionals[2]" set unset',
    'end',
    'function __board_config_key',
    '  __board_value_pending; and return 1',
    '  set -l positionals (__board_positionals)',
    '  test (count $positionals) -eq 2; and test "$positionals[1]" = config; and contains -- "$positionals[2]" get set unset',
    'end',
    'function __board_schedule_id',
    '  __board_value_pending; and return 1',
    '  set -l positionals (__board_positionals)',
    '  test (count $positionals) -eq 2; and test "$positionals[1]" = schedules; and contains -- "$positionals[2]" pause resume rm edit',
    'end',
    'complete -c board -f',
  );
  for (const flag of model.globalFlags) lines.push(`complete -c board -n '__fish_use_subcommand' -l ${flag.slice(2)}`);
  for (const command of model.commands)
    lines.push(`complete -c board -n '__fish_use_subcommand' -a ${command.name} -d ${fishQuote(command.summary)}`);
  for (const command of model.commands) {
    for (const flag of command.flags) {
      const values = model.flagValues[flag];
      const takesValue = model.valueFlags.includes(flag);
      const extra = values
        ? ` -x -a ${fishQuote(words(values))}`
        : model.taskFlags.includes(flag)
          ? ` -x -a '(__board_ids tasks)'`
          : model.fileFlags.includes(flag)
            ? ' -r -F'
            : takesValue
              ? ' -x'
              : '';
      lines.push(`complete -c board -n '__fish_seen_subcommand_from ${command.name}' -l ${flag.slice(2)}${extra}`);
    }
  }
  lines.push(`complete -c board -n '__board_at 1 ${taskCommands.join(' ')}' -a '(__board_ids tasks)'`);
  lines.push(`complete -c board -n '__board_at 1 restart logs' -a ${fishQuote(words(WORKER_UNITS))}`);
  lines.push(`complete -c board -n '__board_at 1 logs' -a '(__board_ids tasks)'`);
  lines.push(`complete -c board -n '__board_at 2 move' -a ${fishQuote(words(STATUSES))}`);
  lines.push(`complete -c board -n '__board_at 1 schedules' -a 'pause resume rm edit'`);
  lines.push(`complete -c board -n '__board_schedule_id' -a '(__board_ids schedules)'`);
  lines.push(`complete -c board -n '__board_at 1 dirs' -a 'list add rm set unset'`);
  lines.push(`complete -c board -n '__board_dirs_key' -a ${fishQuote(words(DIR_SETTINGS))}`);
  lines.push(`complete -c board -n '__board_at 1 config' -a 'show get set unset edit path'`);
  lines.push(`complete -c board -n '__board_config_key' -a ${fishQuote(words(TOP_KEYS))}`);
  lines.push(`complete -c board -n '__board_at 2 task' -a 'set unset'`);
  lines.push(
    `complete -c board -n '__board_at 3 task' -a 'priority model effort lane auto-done icon labels dir prompt'`,
  );
  lines.push(`complete -c board -n '__board_at 1 help' -a ${fishQuote(words(names))}`);
  lines.push(`complete -c board -n '__board_at 1 completion' -a ${fishQuote(words(SHELLS))}`);
  return `${lines.join('\n')}\n`;
}

export function renderCompletion(shell: Shell, model: CompletionModel): string {
  if (shell === 'bash') return bash(model);
  if (shell === 'zsh') return zsh(model);
  return fish(model);
}
