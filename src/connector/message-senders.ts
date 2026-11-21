import {createHash} from 'node:crypto';
import type {Json, TeamMember} from '../shared/types.js';

/** A message a team member sent from the phone, as the connector recorded it when sending. */
export interface SenderRecord {turnId: string | null; kind: 'start' | 'steer' | 'text'; textHash: string | null; sender: TeamMember}

/** Compares message text as sent and as stored in a transcript, ignoring line endings and outer spaces. */
export const textKey = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex');

/**
 * Codex: messages are tied to the turn the send started or joined. When a turn's user messages and
 * the recorded sends line up one to one they are matched in order; otherwise only the message that
 * started the turn is named, since others in it may have come from the desktop.
 */
export function markCodexSenders(turns: Json[], records: SenderRecord[]) {
  for (const turn of turns) {
    const sent = records.filter(record => record.turnId === turn.id);
    if (!sent.length) continue;
    const users = (turn.items || []).filter((item: Json) => item.role === 'user');
    if (sent.length === users.length) users.forEach((item: Json, index: number) => {item.sender = sent[index].sender;});
    else {
      const start = sent.find(record => record.kind === 'start');
      if (start && users[0]) users[0].sender = start.sender;
    }
  }
}

/**
 * Claude Code and Antigravity: a transcript message is matched to a recorded send with the same text,
 * newest first, so repeated short messages pair with the latest sends and a transcript that only
 * shows its last part still lines up. Returns the sender per message ID.
 */
export function sendersByText(messages: {id: string; text: string}[], records: SenderRecord[]): Map<string, TeamMember> {
  const senders = new Map<string, TeamMember>();
  const left = records.filter(record => record.textHash).reverse();
  for (const message of [...messages].reverse()) {
    const key = textKey(message.text), index = left.findIndex(record => record.textHash === key);
    if (index < 0) continue;
    senders.set(message.id, left[index].sender);
    left.splice(index, 1);
  }
  return senders;
}

/** The text of a Claude Code transcript entry the user typed; tool results are not messages. */
export function claudeUserText(entry: Json): string | undefined {
  if (entry?.type !== 'user' || entry.parent_tool_use_id) return undefined;
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((block: Json) => block?.type === 'tool_result')) return undefined;
  return content.filter((block: Json) => block?.type === 'text' && typeof block.text === 'string').map((block: Json) => block.text).join('\n');
}
