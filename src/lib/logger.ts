import chalk from "chalk";

let _quiet = false;
let _verbose = false;

export function setLogLevel(quiet: boolean, verbose: boolean): void {
  _quiet = quiet;
  _verbose = verbose;
}

export const log = {
  info: (...args: unknown[]) => { if (!_quiet) console.log(...args); },
  debug: (...args: unknown[]) => { if (_verbose) console.log(chalk.gray("[debug]"), ...args); },
  error: (...args: unknown[]) => { console.error(chalk.red(...args.map(String))); },
  success: (...args: unknown[]) => { if (!_quiet) console.log(chalk.green(...args.map(String))); },
  warn: (...args: unknown[]) => { if (!_quiet) console.log(chalk.yellow(...args.map(String))); },
};
