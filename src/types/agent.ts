export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'tool'; line: string }
  | { type: 'text'; text: string }
  | { type: 'result'; ok: boolean; text: string; sessionId: string };

export interface AgentResult {
  ok: boolean;
  /** 给用户看的正文 (成功是答案, 失败是可读的失败原因)。 */
  text: string;
  /** 本轮 claude 会话 id; 空串表示没解析到, 不要写进 session store。 */
  sessionId: string;
}

export interface RunAgentInput {
  prompt: string;
  resumeSessionId?: string;
}

export type RunAgent = (
  input: RunAgentInput,
  onEvent: (event: AgentEvent) => void,
) => Promise<AgentResult>;
