import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { ChannelMessage, SystemMessage, Team } from './types';

const HISTORY_LIMIT = 100;

/**
 * In-memory message channel for a single team.
 * Agents on the same team can broadcast messages and read history.
 * QA and Red Team channels are completely separate — agents cannot
 * post to or read from the other team's channel.
 */
export class TeamChannel extends EventEmitter {
  readonly team: Team;
  private history: ChannelMessage[] = [];

  constructor(team: Team) {
    super();
    this.team = team;
    this.setMaxListeners(50);
  }

  post(
    from: string,
    content: string,
    tags?: string[],
    image?: string,
    extras?: Partial<Pick<ChannelMessage, 'threadId' | 'replyTo' | 'finding' | 'review'>>
  ): ChannelMessage {
    const message: ChannelMessage = {
      id: randomUUID(),
      from,
      content,
      timestamp: Date.now(),
      tags,
      image,
      ...extras,
    };

    this.history.push(message);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
    }

    this.emit('message', message);
    return message;
  }

  subscribe(callback: (msg: ChannelMessage) => void): () => void {
    this.on('message', callback);
    return () => this.off('message', callback);
  }

  getHistory(limit?: number): ChannelMessage[] {
    if (limit === undefined) return [...this.history];
    return this.history.slice(-limit);
  }

  getRecent(sinceTimestamp: number): ChannelMessage[] {
    return this.history.filter((m) => m.timestamp > sinceTimestamp);
  }
}

/**
 * System-level broadcast channel used by the Runner to pause/resume all agents.
 * Not team-scoped — both teams subscribe to this.
 */
export class SystemChannel extends EventEmitter {
  private static instance: SystemChannel;

  static getInstance(): SystemChannel {
    if (!SystemChannel.instance) {
      SystemChannel.instance = new SystemChannel();
      SystemChannel.instance.setMaxListeners(100);
    }
    return SystemChannel.instance;
  }

  broadcast(msg: SystemMessage): void {
    this.emit('system', msg);
  }

  subscribe(callback: (msg: SystemMessage) => void): () => void {
    this.on('system', callback);
    return () => this.off('system', callback);
  }
}

/**
 * Factory — returns the singleton channel for each team.
 */
const channels = new Map<string, TeamChannel>();

export function getTeamChannel(team: Team): TeamChannel {
  if (!channels.has(team)) {
    channels.set(team, new TeamChannel(team));
  }
  return channels.get(team)!;
}

export function resetChannels(): void {
  channels.clear();
}
