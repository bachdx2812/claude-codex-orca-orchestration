'use strict';
/**
 * operator-commands.cjs — pure parser for every prompt-driven switch (no fs, no state).
 *
 * A UserPromptSubmit payload also carries agent mail, task notifications, reminders, worker
 * briefs and pasted blocks, any of which may quote or negate a flag. So a switch is
 * honoured only when the WHOLE one-line message is known flags (or a designation phrase),
 * and a claim is released only by a prompt that is a task notification from end to end.
 * When in doubt, nothing changes.
 */

const GATE_FLAGS = { '--no-orchestrate': true, '--orchestrate': false }; // value = bypass
const ROUTING_FLAGS = ['--exec-sonnet', '--exec-codex', '--exec-auto'];
const RETIRED_FLAGS = ['--exec-kimi', '--exec-deepseek'];
const RELEASE_TARGET = /^(?!-)[A-Za-z0-9_#:.-]+$/;
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip ASCII blanks only: an invisible Unicode suffix must keep a message from matching.
 * Index loops, because a `\s+$` regex is quadratic on a long pasted run of blanks. */
function trimBlanks(text) {
  const blank = ' \t\r\n';
  let start = 0;
  let end = text.length;
  while (start < end && blank.includes(text[start])) start += 1;
  while (end > start && blank.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** The operator's one-line message without its optional final "." or "!", else null. */
function operatorLine(payload) {
  if (payload.source !== undefined && payload.source !== 'user') return null;
  if (payload.agent_id !== undefined || typeof payload.prompt !== 'string') return null;
  const text = trimBlanks(payload.prompt.normalize('NFC'));
  if (LINE_BREAK.test(text)) return null;
  const line = text.replace(/[.!]$/, '');
  return line && line === trimBlanks(line) ? line : null;
}

function isDesignationPhrase(line, alias) {
  const a = escapeRegex(alias);
  return new RegExp(`^(?:use|dùng|dung)[ \\t]+(?:${a}|claude-${a}(?:-\\d+)*)$`, 'i').test(line);
}

/**
 * Parse a UserPromptSubmit payload as an operator command. Returns null unless the whole
 * message is one, else:
 *   bypass     true | false | null (no gate flag; last one wins)
 *   routing    { flag, value } | null (last routing flag wins; value only for --code-model)
 *   bareCodeModel, retired[], releases[] ("all" or claim ids)
 *   designates the operator designated the escalation model
 */
function parseOperatorCommand(payload, escalationAlias) {
  const line = operatorLine(payload);
  if (!line) return null;
  const alias = String(escalationAlias || 'fable').toLowerCase();
  const command = {
    bypass: null, routing: null, bareCodeModel: false, retired: [], releases: [], designates: false,
  };
  if (isDesignationPhrase(line, alias)) return { ...command, designates: true };

  const tokens = line.split(/[ \t]+/);
  let aliasFlag = false;
  let spacedModel = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const eq = tokens[i].indexOf('=');
    const name = (eq < 0 ? tokens[i] : tokens[i].slice(0, eq)).toLowerCase();
    const takesValue = name === '--code-model' || name === '--release-claims';
    if (eq >= 0 && !takesValue) return null;
    if (takesValue) {
      const spaced = eq < 0;
      const value = spaced ? tokens[i += 1] : tokens[i].slice(eq + 1);
      if (name === '--release-claims') {
        if (!value || !RELEASE_TARGET.test(value)) return null;
        command.releases.push(value);
      } else if (!value) {
        command.bareCodeModel = true;
      } else {
        command.routing = { flag: name, value };
        spacedModel = spaced ? value.toLowerCase() : null;
      }
    } else if (Object.prototype.hasOwnProperty.call(GATE_FLAGS, name)) {
      command.bypass = GATE_FLAGS[name];
    } else if (ROUTING_FLAGS.includes(name)) {
      command.routing = { flag: name, value: null };
      spacedModel = null;
    } else if (name === `--exec-${alias}`) {
      aliasFlag = true;
    } else if (RETIRED_FLAGS.includes(name)) {
      command.retired.push(name);
    } else {
      return null;
    }
  }
  // Only the winning --code-model counts: a superseded one grants nothing.
  return { ...command, designates: aliasFlag || spacedModel === alias };
}

/** Known flags appearing as standalone tokens anywhere in `prompt` (for the notice only). */
function mentionedFlags(prompt, escalationAlias) {
  const alias = String(escalationAlias || 'fable').toLowerCase();
  const known = [...Object.keys(GATE_FLAGS), ...ROUTING_FLAGS, ...RETIRED_FLAGS,
    `--exec-${alias}`, '--code-model', '--release-claims'];
  return known.filter((flag) =>
    new RegExp(`(?:^|\\s)${escapeRegex(flag)}(?=$|\\s|=|[.,;:!?](?:\\s|$))`, 'i').test(prompt));
}

/**
 * The tool-use id a genuine task notification reports as finished, else null. The prompt
 * must be the notification from start to end, and only the first <tool-use-id> of its
 * header counts: ids quoted in the summary, note or result may belong to running siblings.
 */
function finishedToolUseId(payload) {
  if (payload.source !== undefined || payload.agent_id !== undefined) return null;
  if (typeof payload.prompt !== 'string') return null;
  const text = trimBlanks(payload.prompt);
  if (!text.startsWith('<task-notification>') || !text.endsWith('</task-notification>')) return null;
  const header = text.slice(0, text.search(/<summary>|<result>|<note>|<\/task-notification>/));
  const tag = header.match(/<tool-use-id>([^<]*)<\/tool-use-id>/);
  const id = tag ? tag[1].trim() : '';
  return /^(?:toolu|agent)_[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

module.exports = { parseOperatorCommand, mentionedFlags, finishedToolUseId };
