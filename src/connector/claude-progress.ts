import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {NextStep, PlanStep} from '../shared/types.js';

const str = (value: unknown) => typeof value === 'string' ? value : '';
const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const MAX_PLAN_STEPS = 50;

/** The plan tools: Claude Code's TodoWrite, and the desktop app's update_plan, which can also change the last plan by step number. */
export const isPlanTool = (name: unknown) => name === 'TodoWrite' || name === 'mcp__ccd_turn__update_plan';

/**
 * The plan after one call of a plan tool, or undefined when the call does not describe one.
 * update_plan either lists every step (`items`) or changes the last plan: `done` and `start` are 1-based step numbers,
 * `advance` completes the step under way and starts the next.
 */
export function applyPlan(previous: PlanStep[] | undefined, name: unknown, input: Record<string, unknown> | undefined): PlanStep[] | undefined {
  const list = name === 'TodoWrite' ? input?.todos : input?.items;
  if (Array.isArray(list)) {
    const steps = list.slice(0, MAX_PLAN_STEPS).flatMap((item: any) => {
      const text = (str(item?.content) || str(item?.step)).trim();
      return text ? [{text: text.slice(0, 300), status: (PLAN_STATUSES.has(item?.status) ? item.status : 'pending') as PlanStep['status']}] : [];
    });
    return steps.length ? steps : undefined;
  }
  if (name !== 'mcp__ccd_turn__update_plan' || !previous?.length) return undefined;
  const steps = previous.map(step => ({...step}));
  const at = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= steps.length ? steps[Number(value) - 1] : undefined;
  if (input?.advance === true) {
    const index = steps.findIndex(step => step.status === 'in_progress');
    if (index >= 0) steps[index].status = 'completed';
    const next = steps.find((step, position) => position > index && step.status === 'pending');
    if (next) next.status = 'in_progress';
  }
  if (Array.isArray(input?.done)) for (const value of input.done) {const step = at(value);if (step) step.status = 'completed';}
  const start = at(input?.start);
  if (start) {
    for (const step of steps) if (step.status === 'in_progress') step.status = 'pending';
    start.status = 'in_progress';
  }
  return steps;
}

/** The desktop app's closing card for a turn: a recap, a question for the user, and answers to offer as buttons. */
export const isNextStepTool = (name: unknown) => name === 'mcp__ccd_turn__wrap_up';
/** Answers that name only an app action, worded as the desktop app's buttons are. */
const ACTION_LABELS: Record<string, string> = {commit: '提交', create_pr: '创建 PR', merge: '合并', verify: '验证', push: '推送'};
const MAX_NEXT_ACTIONS = 4;

export function nextStep(input: Record<string, unknown> | undefined): NextStep | undefined {
  const recap = str(input?.recap).trim().slice(0, 2000), ask = str(input?.ask).trim().slice(0, 500);
  const actions = (Array.isArray(input?.actions) ? input.actions : []).flatMap((action: any) => {
    const label = (str(action?.label) || ACTION_LABELS[str(action?.action)] || str(action?.action)).trim().slice(0, 100);
    return label ? [{label, ...(str(action?.action) ? {action: str(action.action).slice(0, 40)} : {})}] : [];
  }).slice(0, MAX_NEXT_ACTIONS);
  if (!recap && !ask && !actions.length) return undefined;
  return {recap, ask, actions, ...(input?.blocked === true ? {blocked: true} : {})};
}

/** The time Claude Code wrote a transcript entry, found by its uuid in the raw transcript. */
export function entryTimestamp(transcript: string, uuid: string): string {
  const at = uuid ? transcript.lastIndexOf(`"uuid":"${uuid}"`) : -1;
  if (at < 0) return '';
  const start = transcript.lastIndexOf('\n', at) + 1, end = transcript.indexOf('\n', at);
  try {
    const value = JSON.parse(transcript.slice(start, end < 0 ? undefined : end))?.timestamp;
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
  } catch {return '';}
}

/** What a Claude Code process reports about the session it holds: a turn under way, blocked on a dialog, or done. */
export type PeerStatus = {status: 'busy' | 'waiting' | 'idle'; waitingFor?: string; updatedAt: number};

function processAlive(pid: number) {
  try {process.kill(pid, 0);return true;} catch (error) {return (error as NodeJS.ErrnoException).code === 'EPERM';}
}

/**
 * Each running Claude Code process (the desktop app, a terminal, an IDE) keeps `<config>/sessions/<pid>.json` with the
 * session it holds and its status. A file whose process has exited can be left behind; it is ignored.
 */
export async function readPeerStatuses(root: string, alive = processAlive): Promise<Map<string, PeerStatus>> {
  const dir = join(root, 'sessions'), statuses = new Map<string, PeerStatus>();
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => /^\d+\.json$/.test(name));
  await Promise.all(names.map(async name => {
    let entry: any;
    try {entry = JSON.parse(await readFile(join(dir, name), 'utf8'));} catch {return;}
    const status = entry?.status;
    if (typeof entry?.sessionId !== 'string' || !['busy', 'waiting', 'idle'].includes(status) || !Number.isSafeInteger(entry.pid) || !alive(entry.pid)) return;
    const updatedAt = Number(entry.statusUpdatedAt ?? entry.updatedAt) || 0, known = statuses.get(entry.sessionId);
    // Two processes can hold a session for a moment (a resume); the latest report wins.
    if (known && known.updatedAt > updatedAt) return;
    statuses.set(entry.sessionId, {status, ...(typeof entry.waitingFor === 'string' && entry.waitingFor ? {waitingFor: entry.waitingFor.slice(0, 100)} : {}), updatedAt});
  }));
  return statuses;
}
