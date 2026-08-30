import type { AgentEvent } from '../types/agent';
import { formatToolLine } from './tool-label';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';

export interface StreamParser {
  /** 喂一段 stdout; 内部按行缓冲, 半行会留到下次。 */
  write(chunk: string): void;
  /** stdout 结束时调用, 冲刷没有结尾换行的最后一行。 */
  end(): void;
}

/**
 * 解析 claude --output-format stream-json 的 NDJSON 输出。
 * 认不出的行 (非 JSON / 未知 type) 一律忽略 —— CLI 升级加新事件时不能把 bot 打挂。
 */
export function createStreamParser(
  onEvent: (event: AgentEvent) => void,
): StreamParser {
  let buffer = '';

  const emit = (event: AgentEvent): void => {
    try {
      onEvent(event);
    } catch {
      // 回调是渲染侧的事; 渲染失败不该中断解析
    }
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let payload: Record<string, unknown> | null;
    try {
      payload = asRecord(JSON.parse(trimmed));
    } catch {
      return;
    }
    if (!payload) return;

    switch (str(payload.type)) {
      case 'system': {
        const sessionId = str(payload.session_id);
        if (str(payload.subtype) === 'init' && sessionId) {
          emit({ type: 'session', sessionId });
        }
        return;
      }

      case 'assistant': {
        const content = asRecord(payload.message)?.content;
        if (!Array.isArray(content)) return;
        for (const raw of content) {
          const block = asRecord(raw);
          if (!block) continue;
          const blockType = str(block.type);
          if (blockType === 'text') {
            const text = str(block.text);
            if (text) emit({ type: 'text', text });
          } else if (blockType === 'tool_use') {
            const name = str(block.name);
            if (name) emit({ type: 'tool', line: formatToolLine(name, block.input) });
          }
        }
        return;
      }

      case 'result': {
        emit({
          type: 'result',
          ok: payload.is_error !== true,
          text: str(payload.result),
          sessionId: str(payload.session_id),
        });
        return;
      }

      default:
        return;
    }
  };

  return {
    write(chunk: string): void {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    },
    end(): void {
      if (buffer.length > 0) {
        const rest = buffer;
        buffer = '';
        handleLine(rest);
      }
    },
  };
}
