'use node';

import { render } from '@react-email/render';
import { v } from 'convex/values';
import { createElement, type ComponentType } from 'react';
import { internalAction } from './_generated/server';
import { sendEmail, type Template } from './lib/email';
import { TEMPLATES } from './lib/mailRegistry';

/**
 * Account emails go through the scheduler so they can be queued from any
 * Better Auth call: HTTP sign-ups run in an action, but seed:createAdmin runs
 * in a mutation, which can't fetch. Rendering react-email needs Node.
 */
export const send = internalAction({
  args: {
    to: v.string(),
    template: v.optional(v.string()),
    props: v.optional(v.any()),
    // Queued before emails became templates: sent as they were built.
    subject: v.optional(v.string()),
    html: v.optional(v.string()),
    text: v.optional(v.string()),
    replyTo: v.optional(v.string())
  },
  handler: async (_ctx, email) => {
    if (email.html !== undefined && email.subject !== undefined) {
      return await sendEmail({ to: email.to, subject: email.subject, html: email.html, text: email.text ?? '' });
    }
    // Each entry's props match its own component, which the union of all five can't express.
    const entry = TEMPLATES[email.template as Template] as unknown as AnyEntry | undefined;
    if (!entry) throw new Error(`Unknown email template "${email.template}"`);
    const props = email.props as object;
    const html = await render(createElement(entry.component, props));
    await sendEmail({ to: email.to, subject: entry.subject(props), html, text: entry.text(props), replyTo: email.replyTo });
  }
});

type AnyEntry = { component: ComponentType<object>; subject: (props: object) => string; text: (props: object) => string };
