import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === metaUrl;
}

export function parseModelPhaseArguments(args, resumeError) {
  const positionals = [];
  let resumeArgument = null;
  let dryRun = false;
  let allowRemoteModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--allow-remote-model') allowRemoteModel = true;
    else if (argument === '--resume') resumeArgument = args[++index] ?? '';
    else if (argument.startsWith('--resume=')) resumeArgument = argument.slice('--resume='.length);
    else positionals.push(argument);
  }
  if (resumeArgument === '') throw new Error(resumeError);
  return { positionals, resumeArgument, dryRun, allowRemoteModel };
}

export function parseOrganizationArguments(args, { allowOperation = false } = {}) {
  const execute = args.includes('--execute');
  const operationArgument = allowOperation
    ? args.find((argument) => argument.startsWith('--operation='))
    : null;
  const operation = operationArgument?.slice('--operation='.length) ?? 'copy';
  const positionals = args.filter((argument) => (
    argument !== '--execute' && (!allowOperation || !argument.startsWith('--operation='))
  ));
  return { execute, operation, positionals };
}
