import { spawn } from 'node:child_process';
import { SystemError } from '../setup/system.mts';

// The installed binary runs the rest of the update: it is the new one by now, so the steps are its own.
export function resumeInstalledBinary(execPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, ['self-update', '--resume'], { stdio: 'inherit' });
    child.once('error', (error) => reject(new SystemError(`cannot run ${execPath}: ${error.message}`)));
    child.once('close', (code) => resolve(code ?? 1));
  });
}
