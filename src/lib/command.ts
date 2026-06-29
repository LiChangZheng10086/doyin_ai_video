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
      ]
    });

    let stdout = "";
    let stderr = "";

    child.on("error", (error) => {
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
