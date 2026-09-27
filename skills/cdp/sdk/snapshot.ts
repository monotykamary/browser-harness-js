import { createHash } from 'node:crypto';
import type { Accessibility } from './generated.ts';

export type AXNode = Accessibility.AXNode;
export type SnapshotOptions = {
  interactive?: boolean;
  maxDepth?: number;
  maxChars?: number;
  /** Read one frame or one subtree. Ref and selector are mutually exclusive. */
  frameId?: string;
  ref?: string;
  selector?: string;
};
export type SnapshotFrame = { frameId: string; sessionId: string; key: string; url: string };
export type SnapshotRef = {
  frame: SnapshotFrame;
  backendNodeId: number;
  identity: string;
  role: string;
  name: string;
  context?: string;
};
export type PageSnapshot = {
  id: string;
  url: string;
  title: string;
  tree: string;
  diff: string;
  truncated: boolean;
  omissions: string[];
};
export class SnapshotLimitError extends Error {
  constructor(message: string) { super(`${message}; narrow the snapshot with ref, selector, frameId or maxDepth`); }
}

const ACTIONS = new Set(['button', 'link', 'textbox', 'searchbox', 'spinbutton', 'checkbox', 'radio',
  'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'switch',
  'tab', 'treeitem', 'gridcell', 'scrollbar', 'canvas']);
const NOISE = new Set(['none', 'generic', 'paragraph', 'LabelText', 'Legend']);
const FRAGMENTS = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);
const SENSITIVE = /\b(password|passwd|passcode|pin|secret|token|ssn|cvv|cvc|card[\s_-]*number|account[\s_-]*number)\b/i;
const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const roleOf = (node: AXNode) => String(node.role?.value ?? 'generic');
export const nameOf = (node: AXNode) => normalize(node.name?.value);
const properties = (node: AXNode): Record<string, unknown> => Object.fromEntries(
  (node.properties ?? []).map(p => [p.name, p.value?.value]),
);

/** Identity excludes focus/layout churn but includes the complete, untruncated semantic state. */
export function nodeIdentity(node: AXNode): string {
  const p = properties(node);
  return createHash('sha256').update(JSON.stringify([roleOf(node), node.name?.value, node.value?.value,
    node.description?.value, ...['checked', 'selected', 'expanded', 'disabled', 'readonly', 'required'].map(k => p[k])])).digest('hex');
}

export function snapshotLimits(options: SnapshotOptions): { maxDepth: number; maxChars: number } {
  const maxDepth = options.maxDepth ?? 50;
  const maxChars = options.maxChars ?? 50_000;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 100) throw new Error('maxDepth must be 0..100');
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 1_000_000) throw new Error('maxChars must be 1..1000000');
  if (options.ref !== undefined && options.selector !== undefined) throw new Error('Choose ref or selector, not both');
  return { maxDepth, maxChars };
}

/** Internal CDP-native projection. Handles forests, ignored roots and repeated/cyclic node IDs. */
export function renderAX(
  nodes: AXNode[], options: SnapshotOptions,
  reference: (node: AXNode, context?: string) => string,
  rootBackendId?: number,
): { tree: string; truncated: boolean } {
  const { maxDepth, maxChars } = snapshotLimits(options);
  if (nodes.length > 50_000) throw new SnapshotLimitError('AX input exceeds 50000 nodes');
  const byId = new Map<string, AXNode>();
  for (const node of nodes) if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
  const childIds = new Set([...byId.values()].flatMap(n => (n.childIds ?? []).filter(id => id !== n.nodeId && byId.has(id))));
  const roots = rootBackendId === undefined
    ? [...byId.values()].filter(n => !childIds.has(n.nodeId))
    : [...byId.values()].filter(n => n.backendDOMNodeId === rootBackendId);
  if (rootBackendId !== undefined && roots.length !== 1) throw new Error('Snapshot subtree is missing or ambiguous');
  if (nodes.length && !roots.length) throw new Error('AX tree has no root');
  type View = { node: AXNode; role: string; name: string; children: View[]; text?: string; sensitive: boolean };
  const visited = new Set<string>();
  const build = (node: AXNode, depth: number): View[] => {
    if (visited.has(node.nodeId)) return [];
    if (depth > 512) throw new SnapshotLimitError('AX nesting exceeds 512');
    visited.add(node.nodeId);
    const role = roleOf(node), name = nameOf(node), p = properties(node);
    if (FRAGMENTS.has(role)) return [];
    const sensitive = p.protected === true ||
      (['textbox', 'searchbox', 'spinbutton'].includes(role) && SENSITIVE.test(`${name} ${node.description?.value ?? ''}`));
    const children = sensitive ? [] : (node.childIds ?? []).flatMap(id => {
      const child = byId.get(id);
      return child ? build(child, depth + 1) : [];
    });
    if (node.ignored) return children;
    const actionable = ACTIONS.has(role) || p.focusable === true || !!p.editable;
    if (role === 'StaticText') return !options.interactive && name ? [{ node, role, name, text: name, children: [], sensitive }] : [];
    if (options.interactive && !actionable && !children.length) return [];
    const meaningful = !NOISE.has(role) || !!name || actionable;
    if (!meaningful) return children;
    // Suppress text only when its replacement is actually emitted. Never suppress text
    // behind a dropped table/cell/generic wrapper, and never flatten away table relations.
    if (name && children.length && children.every(c => c.text !== undefined) &&
        normalize(children.map(c => c.text).join(' ')) === name) children.length = 0;
    return [{ node, role, name, children, sensitive }];
  };
  const views = roots.flatMap(root => build(root, 0));
  const lines: string[] = [];
  let chars = 0, truncated = false;
  const push = (line: string) => {
    chars += line.length + 1;
    if (chars > maxChars) throw new SnapshotLimitError(`Snapshot exceeds ${maxChars} characters`);
    lines.push(line);
  };
  const emit = (view: View, depth: number, context?: string) => {
    const { node, role, name, sensitive } = view;
    const indent = '  '.repeat(depth);
    if (view.text !== undefined) { push(`${indent}- text: ${JSON.stringify(view.text)}`); return; }
    const p = properties(node);
    const parts = [role];
    if (name) parts.push(JSON.stringify(name));
    if (node.backendDOMNodeId) parts.push(`[ref=${reference(node, context)}]`);
    for (const key of ['focused', 'disabled', 'required', 'readonly', 'multiline', 'scrollable']) {
      if (p[key] === true) parts.push(`[${key}]`);
    }
    for (const key of ['checked', 'pressed', 'selected', 'expanded']) {
      if (p[key] !== undefined) parts.push(`[${key}=${p[key]}]`);
    }
    if (p.level !== undefined) parts.push(`[level=${p.level}]`);
    if (p.valuemin !== undefined) parts.push(`[min=${p.valuemin}]`);
    if (p.valuemax !== undefined) parts.push(`[max=${p.valuemax}]`);
    if (p.invalid !== undefined && p.invalid !== 'false' && p.invalid !== false) parts.push(`[invalid=${p.invalid}]`);
    // CDP places control values on AXNode, not in AXNode.properties.
    const value = sensitive ? '[redacted]' : node.value?.value;
    if (value !== undefined && value !== null) parts.push(`value=${JSON.stringify(value)}`);
    if (node.description?.value && !sensitive) parts.push(`description=${JSON.stringify(normalize(node.description.value))}`);
    push(`${indent}- ${parts.join(' ')}`);
    if (depth === maxDepth && view.children.length) { truncated = true; return; }
    const childContext = name && !ACTIONS.has(role) ? `${role}: ${name}` : context;
    for (const child of view.children) emit(child, depth + 1, childContext);
  };
  for (const view of views) emit(view, 0);
  if (truncated) push(`[snapshot truncated: maxDepth=${maxDepth}]`);
  return { tree: lines.join('\n'), truncated };
}

/** Bounded linear-space diff, keyed by private DOM/frame identities rather than printed refs. */
export function snapshotDiff(previous: string | undefined, next: string, keys: Map<string, string>, previousKeys: Map<string, string>): string {
  if (previous === undefined) return next;
  const lines = (text: string, refs: Map<string, string>) => text.split('\n').map(raw => ({ raw,
    key: raw.replace(/\[ref=([^\]]+)\]/g, (_all, ref: string) => `[node=${refs.get(ref) ?? ref}]`),
  }));
  const before = lines(previous, previousKeys), after = lines(next, keys);
  const counts = (items: { key: string }[]) => {
    const result = new Map<string, number>();
    for (const item of items) result.set(item.key, (result.get(item.key) ?? 0) + 1);
    return result;
  };
  const removed = counts(after), added = counts(before);
  const output: string[] = [];
  for (const item of before) {
    const count = removed.get(item.key) ?? 0;
    if (count) removed.set(item.key, count - 1); else output.push(`- ${item.raw}`);
  }
  for (const item of after) {
    const count = added.get(item.key) ?? 0;
    if (count) added.set(item.key, count - 1); else output.push(`+ ${item.raw}`);
  }
  // Multisets alone miss reorder-only changes. Surface the new order explicitly.
  if (!output.length && before.map(i => i.key).join('\n') !== after.map(i => i.key).join('\n')) return `[order changed]\n${next}`;
  return output.join('\n') || '(no changes)';
}
