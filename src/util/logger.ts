export interface Log {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string | Error, ...args: unknown[]): void;
}

/** Structural subset of `vscode.LogOutputChannel`, so this module stays free of the `vscode` runtime. */
export interface LogSink extends Log {
  show(preserveFocus?: boolean): void;
}

export function scoped(log: Log, scope: string): Log {
  const prefix = `[${scope}] `;
  return {
    debug: (m, ...a) => log.debug(prefix + m, ...a),
    info: (m, ...a) => log.info(prefix + m, ...a),
    warn: (m, ...a) => log.warn(prefix + m, ...a),
    error: (m, ...a) => log.error(m instanceof Error ? m : prefix + m, ...a),
  };
}

export const nullLog: Log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
