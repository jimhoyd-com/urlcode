export { MailError } from './types.ts';
export type {
  MailContribution, MailEnvelope, MailErrorCode, MailExports, MailMessage, MailSlotKind, MailTemplate, MailTransport, MailTransportContext,
  SesCredentials, SesEmailCommand, SesEmailInput, SesTransportOptions,
} from './types.ts';
export { consoleTransport, outboxTransport, recordingTransport, sesTransport } from './transports.ts';
export { createMail, mailAuthoring, mailConfigSchema } from './mail.ts';
export type { MailOptions } from './mail.ts';
export type { MailHostOptions } from './extension.ts';
