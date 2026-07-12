import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly args: string[],
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number | null
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    captureStdout?: boolean;
    captureStderr?: boolean;
    timeoutMs?: number;
  } = {}
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [
        "ignore",
        options.captureStdout ? "pipe" : "ignore",
        options.captureStderr ? "pipe" : "ignore"
      ],
      detached: process.platform !== "win32"
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const killProcessTree = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already have exited.
        }
      }
      child.kill(signal);
    };
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          killProcessTree("SIGTERM");
          forceKillTimer = setTimeout(() => killProcessTree("SIGKILL"), 1_000);
          forceKillTimer.unref();
          reject(
            new CommandError(
              `Command timed out after ${options.timeoutMs}ms`,
              command,
              args,
              stdout,
              stderr,
              null
            )
          );
        }, options.timeoutMs)
      : undefined;
    timeout?.unref();

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(
        new CommandError(
          error.message,
          command,
          args,
          stdout,
          stderr,
          null
        )
      );
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    }

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (exitCode === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new CommandError(
          `Command failed with exit code ${exitCode}`,
          command,
          args,
          stdout,
          stderr,
          exitCode
        )
      );
    });
  });
}
