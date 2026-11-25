/**
 * Versioned notification templates.
 *
 * Versioned for the same reason prompts are: a message that cannot be reproduced cannot be
 * explained, and "what exactly were they told" is a question that gets asked about a release
 * approval years later. The rendered subject and body are stored on the notification too, so the
 * evidence does not depend on this file staying unchanged — the version says which wording produced
 * it, and the record says what it actually said.
 *
 * ## What a notification may contain
 *
 * References, never contents. A notification names the journey, the step and what is being asked
 * for, and it does not carry agreement text, amounts, party names, evidence or any model output.
 * Two reasons, and the second is the one people forget: email is the least controlled channel the
 * platform has, forwarded and retained outside it; and a notification that embedded the figures
 * would become a second, unversioned account of the agreement competing with the authoritative one.
 *
 * So every template is deliberately dull. The action lives in the product, behind authorization —
 * the email's job is to say that something is waiting, not to be the thing that is waiting.
 */

export type NotificationTemplate = {
  id: string;
  version: number;
  /** Variables the template requires. Rendering refuses when one is missing. */
  requiredVariables: readonly string[];
  subject: string;
  body: string;
};

export type NotificationTemplateId =
  | 'human-task-raised'
  | 'flow-suspended'
  | 'flow-failed'
  | 'flow-completed';

const SIGN_OFF = 'Sign in to AssuraPay to act on this. This message carries no agreement details.';

/**
 * Why the action is a path and not a link.
 *
 * A notification should lead somewhere, and `human-task-raised` now names the exact page that holds
 * the decision — `/approvals?task=…`, which marks that approval in the recipient's own inbox. It is a
 * path rather than a URL because this deployment has no configured public base address, and
 * inventing a host would produce a link that either goes nowhere or, worse, goes somewhere wrong.
 * Making it absolute is a configuration change: state the public address the way
 * `ASSURAPAY_DATABASE_SSL` is stated, with no default, and render it in front of this path.
 */

export const NOTIFICATION_TEMPLATES: Record<NotificationTemplateId, NotificationTemplate> =
  Object.freeze({
    'human-task-raised': {
      id: 'human-task-raised',
      version: 1,
      requiredVariables: ['recipientName', 'stepTitle', 'requiredRole', 'flowReference', 'actionPath'],
      subject: 'Action required: {{stepTitle}}',
      body: [
        'Hello {{recipientName}},',
        '',
        'A step in an AssuraPay execution journey is waiting for a decision from someone holding',
        'the {{requiredRole}} role.',
        '',
        'Step: {{stepTitle}}',
        'Journey reference: {{flowReference}}',
        'Where to act: {{actionPath}}',
        '',
        SIGN_OFF,
      ].join('\n'),
    },
    'flow-suspended': {
      id: 'flow-suspended',
      version: 1,
      requiredVariables: ['recipientName', 'flowReference', 'reason'],
      subject: 'Execution journey suspended: {{flowReference}}',
      body: [
        'Hello {{recipientName}},',
        '',
        'An AssuraPay execution journey you started has been suspended and will not advance until',
        'it is resumed.',
        '',
        'Journey reference: {{flowReference}}',
        'Reason recorded: {{reason}}',
        '',
        SIGN_OFF,
      ].join('\n'),
    },
    'flow-failed': {
      id: 'flow-failed',
      version: 1,
      requiredVariables: ['recipientName', 'flowReference'],
      subject: 'Execution journey failed: {{flowReference}}',
      body: [
        'Hello {{recipientName}},',
        '',
        'An AssuraPay execution journey you started has failed and has stopped advancing. No',
        'payment or settlement state has been changed by this failure.',
        '',
        'Journey reference: {{flowReference}}',
        '',
        SIGN_OFF,
      ].join('\n'),
    },
    'flow-completed': {
      id: 'flow-completed',
      version: 1,
      requiredVariables: ['recipientName', 'flowReference'],
      subject: 'Execution journey completed: {{flowReference}}',
      body: [
        'Hello {{recipientName}},',
        '',
        'An AssuraPay execution journey you started has completed every step.',
        '',
        'Journey reference: {{flowReference}}',
        '',
        SIGN_OFF,
      ].join('\n'),
    },
  });

export class NotificationTemplateError extends Error {
  constructor(detail: string) {
    super(`NOTIFICATION_TEMPLATE_INVALID: ${detail}`);
    this.name = 'NotificationTemplateError';
  }
}

/**
 * Renders a template, refusing anything it cannot fill.
 *
 * A missing variable is an error rather than an empty string or an unfilled `{{marker}}`. Both
 * alternatives produce a message that goes out looking broken, and the second leaks the template's
 * internals to whoever receives it.
 */
export function renderTemplate(
  id: NotificationTemplateId,
  variables: Record<string, string>,
): { subject: string; body: string } {
  const template = NOTIFICATION_TEMPLATES[id];
  if (!template) throw new NotificationTemplateError(`unknown template ${id}`);

  for (const required of template.requiredVariables)
    if (typeof variables[required] !== 'string' || !variables[required].trim())
      throw new NotificationTemplateError(`${id} requires ${required}`);

  const fill = (text: string) =>
    text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const value = variables[name];
      if (value === undefined) throw new NotificationTemplateError(`${id} references unknown ${name}`);
      return value;
    });

  return { subject: fill(template.subject), body: fill(template.body) };
}
