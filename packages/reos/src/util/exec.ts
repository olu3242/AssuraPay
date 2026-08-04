import { spawnSync } from 'node:child_process';

export type CommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ok: boolean;
};

/**
 * Runs a command synchronously. REOS stages are sequential by design: a stage
 * must observe a settled repository before the next stage reads it, so there is
 * no concurrency to gain here.
 */
export function runCommand(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string> } ,
): CommandResult {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 900_000,
    maxBuffer: 64 * 1024 * 1024,
    // pnpm and npm resolve through shims on Windows, which require a shell.
    shell: process.platform === 'win32',
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });

  return {
    command: [executable, ...args].join(' '),
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ok: result.status === 0,
  };
}

/** Last `count` non-empty lines of combined output, for compact reports. */
export function outputTail(result: CommandResult, count = 20): string[] {
  return `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count);
}
