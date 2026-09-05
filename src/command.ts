export class CommandError extends Error {}

const errorContextLimit = 16 * 1024;

export class Runner {
  #active = new Set<ReturnType<typeof Bun.spawn>>();

  async run(
    arguments_: string[],
    timeoutSeconds = 120,
    signal?: AbortSignal,
    environment?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }> {
    const process = this.spawn(arguments_, environment);
    const stdoutStream = pipe(process.stdout, "stdout");
    const stderrStream = pipe(process.stderr, "stderr");
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(process);
    }, timeoutSeconds * 1000);
    const abort = () => terminateProcess(process);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        streamText(stdoutStream),
        boundedText(stderrStream, errorContextLimit),
        process.exited,
      ]);
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
      if (timedOut) throw new CommandError(`${arguments_[0]} timed out after ${timeoutSeconds}s`);
      if (exitCode !== 0) throw new CommandError(`${arguments_[0]} failed: ${context(stderr || stdout) || `exit ${exitCode}`}`);
      return { stdout, stderr };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.#active.delete(process);
    }
  }

  async json(arguments_: string[], timeoutSeconds = 120, signal?: AbortSignal): Promise<unknown> {
    const { stdout } = await this.run(arguments_, timeoutSeconds, signal);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new CommandError(`${arguments_[0]} returned invalid JSON`);
    }
  }

  async lines(
    arguments_: string[],
    options: { signal: AbortSignal; onLine: (line: string) => void | Promise<void>; maxLineBytes?: number },
  ): Promise<void> {
    const process = this.spawn(arguments_);
    const stdoutStream = pipe(process.stdout, "stdout");
    const stderrStream = pipe(process.stderr, "stderr");
    const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    const abort = () => terminateProcess(process);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const stderrPromise = boundedText(stderrStream, errorContextLimit);
    try {
      const reader = stdoutStream.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        if (new TextEncoder().encode(buffered).byteLength > maxLineBytes && !buffered.includes("\n")) {
          terminateProcess(process);
          throw new CommandError(`${arguments_[0]} emitted a line larger than ${maxLineBytes} bytes`);
        }
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, "");
          buffered = buffered.slice(newline + 1);
          if (new TextEncoder().encode(line).byteLength > maxLineBytes) {
            terminateProcess(process);
            throw new CommandError(`${arguments_[0]} emitted a line larger than ${maxLineBytes} bytes`);
          }
          await options.onLine(line);
        }
      }
      buffered += decoder.decode();
      if (buffered) await options.onLine(buffered.replace(/\r$/, ""));
      const [exitCode, stderr] = await Promise.all([process.exited, stderrPromise]);
      if (options.signal.aborted) return;
      if (exitCode !== 0) throw new CommandError(`${arguments_[0]} failed: ${context(stderr) || `exit ${exitCode}`}`);
      throw new CommandError(`${arguments_[0]} exited unexpectedly`);
    } catch (error) {
      terminateProcess(process);
      throw error;
    } finally {
      options.signal.removeEventListener("abort", abort);
      this.#active.delete(process);
      await stderrPromise;
    }
  }

  terminate(): void {
    for (const process of this.#active) terminateProcess(process);
  }

  private spawn(arguments_: string[], environment?: Record<string, string>): ReturnType<typeof Bun.spawn> {
    try {
      const child = Bun.spawn(arguments_, {
        stdout: "pipe", stderr: "pipe", stdin: "ignore",
        ...(environment ? { env: { ...process.env, ...environment } } : {}),
      });
      this.#active.add(child);
      return child;
    } catch (error) {
      throw new CommandError(`failed to run ${arguments_[0]}: ${String(error)}`);
    }
  }
}

function terminateProcess(process: ReturnType<typeof Bun.spawn>): void {
  process.kill("SIGTERM");
  const timer = setTimeout(() => process.kill("SIGKILL"), 5000);
  timer.unref();
  void process.exited.finally(() => clearTimeout(timer));
}

function pipe(value: number | ReadableStream<Uint8Array> | undefined, name: string): ReadableStream<Uint8Array> {
  if (value instanceof ReadableStream) return value;
  throw new CommandError(`failed to open child ${name}`);
}

async function boundedText(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
    if (result.length > limit) result = result.slice(-limit);
  }
  return result + decoder.decode();
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function context(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > errorContextLimit ? `...${trimmed.slice(-errorContextLimit)}` : trimmed;
}
