/**
 * Outgoing email. SMTP when SMTP_HOST is configured; otherwise an outbox that keeps messages in
 * memory and logs them, so local development and tests can follow verification and reset links.
 */
import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { ApiConfig } from '../config.ts';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export class OutboxMailer implements Mailer {
  readonly sent: Email[] = [];

  constructor(private readonly log?: FastifyBaseLogger) {}

  async send(email: Email): Promise<void> {
    this.sent.push(email);
    // Dev only: the link is needed to finish sign-up locally. Never used when SMTP is configured.
    this.log?.info({ to: email.to, subject: email.subject, body: email.text }, 'email (outbox, SMTP not configured)');
  }

  /** Latest message to `to`. */
  last(to: string): Email | undefined {
    return [...this.sent].reverse().find((e) => e.to === to);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  constructor(private readonly config: ApiConfig['smtp']) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      requireTLS: config.port !== 465,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async send(email: Email): Promise<void> {
    await this.transport.sendMail({ from: this.config.from ?? this.config.user, to: email.to, subject: email.subject, text: email.text });
  }
}

export function createMailer(config: ApiConfig, log?: FastifyBaseLogger): Mailer {
  return config.smtp.host ? new SmtpMailer(config.smtp) : new OutboxMailer(log);
}
