import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { TeamChannel, SystemChannel } from '../core/channel';
import type { ChannelMessage, SystemMessage, Finding } from '../core/types';
import type { OllamaClient } from '../core/llm';
import { ensureIdentity, initIdentities, getIdentityMap, type BotIdentity } from './identity';

export interface ReportCard {
  id: string;
  title: string;
  severity: string;
  type: string;
  team: string;
  filename: string;
  timestamp: number;
}

export interface SystemMessageEnvelope {
  id: string;
  event: string;
  detail?: string;
  timestamp: number;
}

export interface DmEntry {
  id: string;
  /** Displayed text — AI summary when the original was long, original otherwise */
  line: string;
  /** Original full content when message exceeded the threshold */
  fullText?: string;
  /** True while the LLM is generating a summary */
  summarizing?: boolean;
  timestamp: number;
}

export interface WebChannelMessage extends ChannelMessage {
  /** UI-only summarized content for long messages */
  displayContent?: string;
  /** Original full content exposed only to the web UI attachment */
  fullContent?: string;
  /** True while the LLM summary is being generated */
  summarizing?: boolean;
}

export type WebBridgeEvent =
  | { type: 'channel_message'; channel: string; message: WebChannelMessage }
  | { type: 'channel_message_summary'; channel: string; id: string; summary: string }
  | { type: 'system_message'; payload: SystemMessageEnvelope }
  | { type: 'agent_log'; agentId: string; id: string; line: string; fullText?: string; summarizing?: boolean; timestamp: number }
  | { type: 'agent_log_summary'; agentId: string; id: string; summary: string }
  | { type: 'report_filed'; card: ReportCard }
  | { type: 'agent_registered'; agent: BotIdentity };

const CHANNEL_HISTORY_LIMIT = 100;
const DM_HISTORY_LIMIT = 200;
const LONG_MSG_THRESHOLD = 1000;

export class WebBridge extends EventEmitter {
  private static instance: WebBridge | null = null;

  private channelHistory: Record<string, WebChannelMessage[]> = { qa: [], red: [], devops: [] };
  private systemHistory: SystemMessageEnvelope[] = [];
  private dmHistory: Record<string, DmEntry[]> = {};
  private reports: ReportCard[] = [];
  private filePathMap = new Map<string, string>();
  private unsubscribers: Array<() => void> = [];
  private llm: OllamaClient | null = null;
  private llmModel = 'unknown';

  /** Allowed origins for /api/preview — updated after DevOps configure() */
  allowedPreviewOrigins: string[] = ['localhost', '127.0.0.1'];

  private constructor() {
    super();
    this.setMaxListeners(100);
    initIdentities();
  }

  static init(): WebBridge {
    WebBridge.instance = new WebBridge();
    return WebBridge.instance;
  }

  static getInstance(): WebBridge {
    if (!WebBridge.instance) throw new Error('WebBridge not initialized');
    return WebBridge.instance;
  }

  static getInstanceIfExists(): WebBridge | null {
    return WebBridge.instance;
  }

  static reset(): void {
    WebBridge.instance?.unsubscribers.forEach((fn) => fn());
    WebBridge.instance = null;
  }

  setLlm(llm: OllamaClient): void {
    this.llm = llm;
  }

  setLlmModel(model: string): void {
    this.llmModel = model;
  }

  attach(
    devopsChannel: TeamChannel,
    qaChannel: TeamChannel,
    redChannel: TeamChannel,
    systemChannel: SystemChannel,
  ): void {
    const bindChannel = (ch: TeamChannel, name: string) => {
      const unsub = ch.subscribe((msg) => {
        this.channelHistory[name] = this.channelHistory[name] ?? [];
        const webMsg = this.prepareChannelMessage(name, msg);
        this.channelHistory[name].push(webMsg);
        if (this.channelHistory[name].length > CHANNEL_HISTORY_LIMIT) {
          this.channelHistory[name].shift();
        }
        this.ensureIdentity(msg.from);
        this.emit('event', { type: 'channel_message', channel: name, message: webMsg } satisfies WebBridgeEvent);
      });
      this.unsubscribers.push(unsub);
    };

    bindChannel(devopsChannel, 'devops');
    bindChannel(qaChannel, 'qa');
    bindChannel(redChannel, 'red');

    const unsubSys = systemChannel.subscribe((msg: SystemMessage) => {
      const envelope: SystemMessageEnvelope = {
        id: randomUUID(),
        event: msg.event,
        detail: msg.detail,
        timestamp: Date.now(),
      };
      this.systemHistory.push(envelope);
      if (this.systemHistory.length > 50) this.systemHistory.shift();
      this.emit('event', { type: 'system_message', payload: envelope } satisfies WebBridgeEvent);
    });
    this.unsubscribers.push(unsubSys);
  }

  private prepareChannelMessage(channel: string, msg: ChannelMessage): WebChannelMessage {
    const isLong = msg.content.length > LONG_MSG_THRESHOLD;
    const webMsg: WebChannelMessage = {
      ...msg,
      displayContent: isLong ? `${msg.content.slice(0, 280).trimEnd()}…` : msg.content,
      fullContent: isLong ? msg.content : undefined,
      summarizing: isLong && this.llm !== null,
    };

    if (isLong && this.llm) {
      const capturedLlm = this.llm;
      capturedLlm.complete(
        `Summarize this team channel message in 1-2 concise sentences. Preserve the key finding, action, or request:\n\n${msg.content.slice(0, 4000)}`
      ).then((summary) => {
        const stored = this.channelHistory[channel]?.find((entry) => entry.id === msg.id);
        if (stored) {
          stored.displayContent = summary.trim();
          stored.summarizing = false;
        }
        this.emit('event', { type: 'channel_message_summary', channel, id: msg.id, summary: summary.trim() } satisfies WebBridgeEvent);
      }).catch(() => {
        const stored = this.channelHistory[channel]?.find((entry) => entry.id === msg.id);
        if (stored) stored.summarizing = false;
      });
    }

    return webMsg;
  }

  ensureIdentity(agentId: string): BotIdentity {
    const identity = ensureIdentity(agentId);
    this.emit('event', { type: 'agent_registered', agent: identity } satisfies WebBridgeEvent);
    return identity;
  }

  agentLog(agentId: string, line: string): void {
    this.ensureIdentity(agentId);
    if (!this.dmHistory[agentId]) this.dmHistory[agentId] = [];

    const id = randomUUID();
    const timestamp = Date.now();
    const isLong = line.length > LONG_MSG_THRESHOLD;

    const entry: DmEntry = {
      id,
      line: isLong ? line.slice(0, 280) + '…' : line,
      fullText: isLong ? line : undefined,
      summarizing: isLong && this.llm !== null,
      timestamp,
    };

    this.dmHistory[agentId].push(entry);
    if (this.dmHistory[agentId].length > DM_HISTORY_LIMIT) {
      this.dmHistory[agentId].shift();
    }

    this.emit('event', {
      type: 'agent_log',
      agentId,
      id: entry.id,
      line: entry.line,
      fullText: entry.fullText,
      summarizing: entry.summarizing,
      timestamp,
    } satisfies WebBridgeEvent);

    if (isLong && this.llm) {
      const capturedLlm = this.llm;
      capturedLlm.complete(
        `Summarize this AI agent action log in 1-2 concise sentences. Focus on what the agent did or discovered:\n\n${line.slice(0, 3000)}`
      ).then((summary) => {
        const stored = this.dmHistory[agentId]?.find((e) => e.id === id);
        if (stored) {
          stored.line = summary.trim();
          stored.summarizing = false;
        }
        this.emit('event', { type: 'agent_log_summary', agentId, id, summary: summary.trim() } satisfies WebBridgeEvent);
      }).catch(() => {
        const stored = this.dmHistory[agentId]?.find((e) => e.id === id);
        if (stored) stored.summarizing = false;
      });
    }
  }

  reportFiled(finding: Finding, filePath: string): void {
    const filename = filePath.split('/').pop() ?? filePath.split('\\').pop() ?? filePath;
    this.filePathMap.set(filename, filePath);

    const card: ReportCard = {
      id: randomUUID(),
      title: finding.title,
      severity: finding.severity,
      type: finding.type,
      team: String(finding.team),
      filename,
      timestamp: Date.now(),
    };
    this.reports.push(card);
    this.emit('event', { type: 'report_filed', card } satisfies WebBridgeEvent);
  }

  resolveReportPath(filename: string): string | undefined {
    return this.filePathMap.get(filename);
  }

  getInitState() {
    return {
      agents: Array.from(getIdentityMap().values()),
      channels: { ...this.channelHistory, system: this.systemHistory },
      dms: { ...this.dmHistory },
      reports: [...this.reports],
      meta: { llmModel: this.llmModel },
    };
  }
}
