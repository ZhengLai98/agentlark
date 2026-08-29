import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pino, { type Logger } from 'pino';

/** spec 规定的日志落点。 */
export const LOG_FILE = resolve(process.cwd(), 'runtime/logs/bot.log');

/** 同时写 stdout 与 runtime/logs/bot.log。 */
export function createLogger(level: string): Logger {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  return pino(
    { level },
    pino.multistream([
      { level: level as pino.Level, stream: process.stdout },
      {
        level: level as pino.Level,
        stream: createWriteStream(LOG_FILE, { flags: 'a' }),
      },
    ]),
  );
}

export type { Logger };
