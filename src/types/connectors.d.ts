declare module "@hasna/connectors" {
  export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
  }

  export interface RunConnectorOperationArgs {
    connector: string;
    operation: string;
    input?: Record<string, unknown> & {
      args?: Array<string | number | boolean>;
    };
    profile?: string;
    timeoutMs?: number;
    parseJson?: boolean;
  }

  export interface ConnectorOperationResult<T = unknown> extends RunResult {
    connector: string;
    operation: string;
    profile?: string;
    data?: T;
  }

  export function runConnectorOperation<T = unknown>(
    args: RunConnectorOperationArgs,
  ): Promise<ConnectorOperationResult<T>>;

  export function runConnectorCommand(
    name: string,
    args: string[],
    timeoutMs?: number,
  ): Promise<RunResult>;
}
