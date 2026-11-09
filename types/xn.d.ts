/* 小暖的类型形状。运行时不加载，只给编辑器和 jsconfig 看。
 * 没有引入 TypeScript 构建：页面仍是纯静态，类型只是文档与补全。 */

interface XnMessage {
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string;
  ts?: number;
  pending?: boolean;
  error?: string;
  incomplete?: boolean;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface XnSession {
  id: string;
  ts: number;
  title?: string;
  messages: XnMessage[];
}

interface XnConfig {
  version: number;
  brand: string;
  labels: Record<string, string>;
  nav: Array<{ id: string; show: boolean }>;
  style: { accent: string; radius: number; fontSize: number; theme: string; density: string };
  tutor: {
    provider: { id: string; base: string };
    ownProvider: { id: string; base: string };
    baseUrl: string;
    model: string;
    temperature: number;
    stream: boolean;
    historyTurns: number;
    systemPrompt: string;
    emoLLM: boolean | 'auto';
  };
  feedback: { endpoint: string };
  limits: { sessions: number; messagesPerSession: number; notesPage: number };
}

interface XnState {
  key: string;
  admin: boolean;
  cfg: XnConfig;
  sessions: XnSession[];
  currentId: string;
  notes: Array<{ id: string; title: string; body: string; tag?: string; ts: number; updated: number }>;
  goals: { date: string; items: Array<{ id: string; text: string; done: boolean }> };
  feedback: Array<Record<string, unknown>>;
  timer: { min: number; left: number; running: boolean; endsAt: number; done: number; date: string };
  sending: boolean;
  view: string;
  web: boolean;
  lastEmo: { emo: string; intensity: number; source: string } | null;
  cloudRepo: { owner: string; name: string; locked: boolean; serverToken: boolean } | null;
  gatewayKey: string;
}

interface XnApiResult {
  text: string;
  reasoning: string;
}

interface XnRawResult {
  content: string;
  reasoning: string;
  toolCalls: unknown[] | null;
}

interface XnNamespace {
  state: XnState;
  ready?: boolean;
  t(key: string, vars?: Record<string, string | number>): string;
  switchView(id: string): void;
  sendMessage(text?: string): Promise<void>;
  boot(): Promise<void>;
  api: {
    chatText(messages: XnMessage[], opts?: Record<string, unknown>): Promise<string>;
    chatRaw(messages: XnMessage[], opts?: Record<string, unknown>): Promise<XnRawResult>;
    streamChat(messages: XnMessage[], opts?: Record<string, unknown>): Promise<XnApiResult & { aborted: boolean; incomplete: boolean }>;
    isProxy(): boolean;
    fitMessages(messages: XnMessage[], budget?: number): XnMessage[];
  };
  models: {
    label(id: string): string;
    isCloud(id: string): boolean;
    groups(provider: string, current: string): Array<{ label: string; items: Array<{ id: string; name: string; note: string }> }>;
    runtime(): { gatewayBase: string; gatewayModel: string; gatewayReady: boolean };
  };
  views: Record<string, { init?(): void; onShow?(): void; render?(): void }>;
  store: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): boolean;
    sessionGet<T>(key: string, fallback: T): T;
    sessionSet(key: string, value: unknown): boolean;
  };
}

declare const XN: XnNamespace;
interface Window { XN: XnNamespace; }
