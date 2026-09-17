/** Plain-text catalogues and constrained theme values. Renderers must HTML-escape text(). */
export type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & {
    other: string;
};
export type Catalogue = Record<string, string | PluralMessage>;
export const englishCatalogue: Readonly<Catalogue> = Object.freeze({
    "users.exportAll": "Export all matching accounts as CSV",
    "users.exportLimits": "Complete export: at most 5,000 accounts, 4 MiB and 5 seconds. Narrow filters if the limit is exceeded.",
    "abuse.required": "Challenge required. Return to the form and try again.",
    "abuse.title": "Verification required",
    "abuse.retry": "Try again",
    "adminOps.title": "Account administration",
    "adminOps.bulkInfo": "Apply role assignment or resend verification to at most 50 accounts. Delivery must succeed before changes apply.",
    "adminOps.ids": "Account IDs (comma-separated, maximum 50)",
    "adminOps.actionLabel": "Action",
    "adminOps.roles": "Roles (comma-separated)",
    "adminOps.reason": "Reason",
    "adminOps.confirm": "Type {value} to confirm",
    "adminOps.bulkConfirm": "Type ACTION COUNT (for example ASSIGN-ROLES 2)",
    "adminOps.apply": "Deliver notices and apply",
    "adminOps.info": "Actions require fresh administrator authentication and a reason. Notification delivery occurs before changes apply.",
    "adminOps.password": "Password configured",
    "adminOps.totp": "Authenticator configured",
    "adminOps.yes": "Yes",
    "adminOps.no": "No",
    "adminOps.passkey": "Passkey",
    "adminOps.secondFactor": "Enrolled second factor",
    "adminOps.factorCase": "Reset factors through a two-administrator case",
    "adminOps.email": "Requested new email address",
    "adminOps.completed": "Account administration completed",
    "adminOps.affected": "{count} accounts updated",
    "adminOps.action.verifyEmail": "Verify email by human review",
    "adminOps.action.forcePasswordReset": "Invalidate password and send setup link",
    "adminOps.action.scheduleDeletion": "Schedule deletion with cancellation notice",
    "adminOps.action.cancelDeletion": "Cancel scheduled deletion",
    "adminOps.action.removePasskey": "Remove passkey",
    "adminOps.action.removeExternal": "Remove external sign-in method",
    "adminOps.action.requestEmailChange": "Request email change with 24-hour delay",
    "adminOps.action.assignRoles": "Assign roles",
    "adminOps.action.resendVerification": "Resend verification",

    "users.filter.storedMethod": "Stored credential method",
    "users.filter.anyStoredMethod": "Any stored credential method",
    "users.filter.search": "Search email, masked email, name or account ID",
    "users.filter.anyStatus": "Any status",
    "users.filter.active": "Active",
    "users.filter.locked": "Locked",
    "users.filter.pendingDelete": "Pending deletion",
    "users.filter.external": "External identity",

    "users.filter.method": "Sign-in method",
    "users.filter.verification": "Email verification",
    "users.filter.anyVerification": "Any verification",
    "users.filter.verified": "Verified",
    "users.filter.unverified": "Unverified",
    "users.filter.locale": "Locale",
    "users.filter.createdFrom": "Created from UTC",
    "users.filter.createdTo": "Created to UTC",
    "users.filter.seenFrom": "Last seen from UTC",
    "users.filter.seenTo": "Last seen to UTC",
    "users.filter.sort": "Sort by",
    "users.filter.direction": "Direction",
    "users.filter.ascending": "Ascending",
    "users.filter.descending": "Descending",
    "users.filter.displayName": "Display name",
    "users.filter.lastSeen": "Last seen",
    "users.filter.apply": "Apply filters",
    "users.filter.activityCaveat": "Last seen uses retained device and session activity; it is not a complete activity history.",

    "mfa.passkeySignIn": "Passkey sign-in",
    "mfa.primaryOrder": "If your account uses a second factor, confirm it before choosing your sign-in passkey.",

    "manualRecovery.title": "Manual account recovery",
    "manualRecovery.restoreTitle": "Restore account access",
    "manualRecovery.restoreIntro": "This link was approved by two administrators after a manual identity review. Choose a new password, then enroll a second factor. Existing sign-in methods and sessions will be revoked.",
    "manualRecovery.replace": "Replace credentials and enroll a second factor",
    "manualRecovery.intro": "Internal human review only. Do not enter passwords, tokens, identity document images or other unnecessary sensitive data. A distinct authorized administrator must independently review the evidence. References are plain text and are never fetched.",
    "manualRecovery.account": "Account",
    "manualRecovery.address": "Approved replacement address",
    "manualRecovery.status": "Status",
    "manualRecovery.evidence": "Evidence assessment",
    "manualRecovery.reference": "Internal evidence reference",
    "manualRecovery.none": "None",
    "manualRecovery.note": "Internal case note",
    "manualRecovery.addNote": "Add note",
    "manualRecovery.closure": "Closure reason",
    "manualRecovery.close": "Close without restoring access",
    "manualRecovery.approval": "Independent approval reason",
    "manualRecovery.confirmation": "Type RESTORE to confirm",
    "manualRecovery.approve": "Approve and send restoration link",
    "manualRecovery.accountId": "Account ID",
    "manualRecovery.verifiedAddress": "Human-verified replacement email",
    "manualRecovery.boundedEvidence": "Evidence assessment (maximum 2000 characters)",
    "manualRecovery.reason": "Reason",
    "manualRecovery.create": "Open case for independent review",
    "manualRecovery.newPassword": "New password",
    "manualRecovery.state.review": "Awaiting independent review",
    "manualRecovery.state.delivery": "Awaiting delivery",
    "manualRecovery.state.ready": "Ready for restoration",
    "manualRecovery.state.redeemed": "Restored",
    "manualRecovery.state.cancelled": "Cancelled",

    "page.secondFactors": "Second factors",
    "page.trustedDevices": "Remembered devices",
    "mfa.distinctKey": "A second-factor passkey must be different from the passkey used for primary sign-in.",
    "mfa.setupPasskey": "Set up a passkey second factor",
    "mfa.enablePasskey": "Enable passkey second factor",
    "mfa.disablePasskey": "Disable passkey second factor",
    "mfa.invalidSetting": "Invalid factor setting",
    "device.rememberExplanation": "Remembering a device requires a real second factor. Sensitive actions still require fresh verification.",
    "device.label": "Device label",
    "device.remember": "Remember this device",
    "device.forget": "Forget device",

"recovery.title":"Recover your authenticator",
"recovery.intro":"This optional email recovery process requires proof from your verified email address, a 24-hour cancellation period, and enrollment of a new authenticator. Existing authentication methods remain unchanged until recovery completes.",
"recovery.send":"Send recovery instructions",
"recovery.cancelTitle":"Cancel authenticator recovery",
"recovery.cancel":"Cancel recovery",
"recovery.confirmTitle":"Confirm authenticator recovery",
"recovery.confirmInfo":"Confirming email possession starts a 24-hour waiting period. Return in this same browser after the waiting period. Completing recovery signs out all sessions and requires enrollment of a new authenticator before application access.",
"recovery.confirm":"Confirm email and show recovery time",
"recovery.complete":"Complete recovery after waiting period",
"recovery.waitTitle":"Authenticator recovery waiting period",
"recovery.waitInfo":"Recovery becomes available at {time}. Keep the email and return using this browser. You can cancel using the separate link in that email.",
"recovery.lost":"Lost your authenticator?",

    "action.exportAudit": "Export audit range as JSON",
    "mfa.usePasskey": "Use a passkey as your second factor",
    "mfa.passkeyConfirmed": "Passkey confirmed. Continue signing in.",

    "page.health": "Service health",
    "health.component": "Component",
    "health.status": "Status",
    "health.updated": "Last checked",
    "health.version": "Runtime version",
    "health.routes": "Routes",
    "health.unavailable": "No operator health integration is configured.",
    "health.runtime": "Runtime",
    "health.readiness": "Readiness",
    "health.healthy": "Healthy",
    "health.degraded": "Degraded",
    "health.unavailableStatus": "Unavailable",
    "health.unknown": "Unknown",
    "health.sender": "Email delivery",
    "health.provider": "Identity provider",
    "health.alerts": "Alerts",

    "signup.pending": "Your request has been received. If eligible, an administrator will review it before you can sign in.",
    "signup.checkEmail": "Check your email for a signup code. Enter it to continue.",
    "signup.createPasskey": "Create a passkey",
    "signup.restart": "Start again",
    "signup.browserRequired": "Signup browser binding required",
    "signup.restartRequired": "Restart signup",
    "signup.previousStep": "Complete the previous signup step",
    "signup.verifiedRequired": "Complete verified signup first",

    "notice.emailCodeEligible": "If this account is eligible, a sign-in code will be sent.",
    "notice.passwordResetEligible": "If this account is eligible, a reset message will be sent.",
    "notice.verificationEligible": "If this account is eligible, a verification message will be sent.",
    "action.selectAccount": "Select {account}",
    "error.httpInvalidRequestEncoding": "Invalid request encoding",
    "error.httpInvalidJSONBody": "Invalid JSON body",
    "error.httpExpectedAnObject": "Expected an object",
    "error.httpUseJSONOrFormData": "Use JSON or form data",
    "error.httpTooManyFields": "Too many fields",
    "error.httpInvalidRequestField": "Invalid request field",
    "error.httpInvalidCookies": "Invalid cookies",
    "error.httpDuplicateSessionCookie": "Duplicate session cookie",
    "error.httpInvalidSessionCookie": "Invalid session cookie",
    "error.httpSameOriginRequestRequired": "Same-origin request required",
    "error.httpInvalidCSRFToken": "Invalid CSRF token",
    "error.httpExportExceedsOnePage": "Export exceeds one page",
    "error.httpDuplicateFilter": "Duplicate filter",
    "error.httpUseAUTCDateAndTimeEndingInZ": "Use a UTC date and time ending in Z",
    "error.httpInvalidAuditTime": "Invalid audit time",
    "error.httpInvalidTimeRange": "Invalid time range",
    "error.httpInvalidEncoding": "Invalid encoding",
    "error.httpInvalidJSON": "Invalid JSON",
    "error.httpInvalidSelection": "Invalid selection",
    "error.httpUseOneSelectionFormat": "Use one selection format",
    "error.httpSelectBetweenOneAndFiftyDistinctAccounts": "Select between one and fifty distinct accounts",
    "message.accountState": "Email: {email}. Authenticator: {authenticator}.",
    "state.verified": "verified",
    "state.unverified": "not yet verified",
    "state.enabled": "enabled",
    "state.disabled": "not enabled",
    "message.sessionStarted": "Started {created}; expires {expires}",
    "message.deletionGrace": "Deletion signs out all sessions immediately. A cancellation link will be emailed, valid for {days} days before permanent removal. Confirm your identity first.",
    "message.adminTotals": "{users} accounts; {locked} locked; {pending} pending deletion; {sessions} sessions; {waitlist} waiting for approval.",
    "message.sessionsOnPage": { "one": "{count} session on this page.", "other": "{count} sessions on this page." },
    "message.bulkUpdated": { "one": "{count} account updated.", "other": "{count} accounts updated." },
    "message.sessionAccountDetail": "Account {account}; started {created}; expires {expires}",
    "message.caseSummary": "{action} for {account} \u2014 {status}",
    "common.yes": "Yes",
    "common.no": "No",
    "provider.link": "Link {provider}",
    "provider.signIn": "Sign in with {provider}",
    "number.value": "{value}",
    "error.serviceUnavailable": "Service unavailable",
    "error.passkeyUnavailable": "Passkeys are unavailable in this browser. Use another sign-in method.",
    "error.passkeyFailed": "Passkey request failed",
    "error.passkeyCancelled": "Passkey ceremony cancelled",
    "field.booleanHint": "true or false",
    "message.acceptTerms": "I accept terms version {version}",
    "error.invalidNumericMetadata": "Invalid numeric metadata",
    "error.invalidBooleanMetadata": "Invalid boolean metadata",
    "error.emailDeliveryIsNotConfigured": "Email delivery is not configured",
    "error.verifyYourEmailBeforeEnrollingAnAuthenticator": "Verify your email before enrolling an authenticator",
    "action.continue": "Continue",
    "copy.emailSignIn": "Email sign in",
    "error.invalidInvitation": "Invalid invitation",
    "error.notFound": "Not found",
    "copy.leaveEmpty": "Leave empty",
    "error.invalidEmailFlow": "Invalid email flow",
    "error.aSingleTokenIsRequired": "A single token is required",
    "action.confirmOperation": "Confirm",
    "copy.confirmOnlyAnAccountYouCreatedVerificationConfirmsThisEmailAddressItDoesNotSetOrResetAPassword": "Confirm only an account you created. Verification confirms this email address; it does not set or reset a password.",
    "page.completeAccountEnrollment": "Complete account enrollment",
    "copy.applicationAccessRemainsBlockedUntilAllRequiredEnrollmentStepsAreComplete": "Application access remains blocked until all required enrollment steps are complete.",
    "copy.verifyYourEmailFirst": "Verify your email first",
    "copy.emailDeliveryIsUnavailableContactTheSiteOperator": "Email delivery is unavailable. Contact the site operator.",
    "copy.enrollAnAuthenticator": "Enroll an authenticator",
    "copy.ifYourRecentSignInHasExpired": "if your recent sign-in has expired.",
    "copy.youAreViewingThisAccountAsASupportAdministratorAccountSecurityChangesAreDisabledEndImpersonationToSignInAsYour": "You are viewing this account as a support administrator. Account security changes are disabled. End impersonation to sign in as yourself.",
    "action.requestEmailChange24HourCoolingPeriod": "Request email change (24-hour cooling period)",
    "action.revokeThisSession": "Revoke this session",
    "page.signInMethods": "Sign-in methods",
    "copy.passkeys": "Passkeys",
    "action.removePasskey": "Remove passkey",
    "copy.linkedProviders": "Linked providers",
    "action.unlinkProvider": "Unlink provider",
    "copy.theLastSignInMethodCannotBeRemoved": "The last sign-in method cannot be removed.",
    "error.enterAnEmailAddress": "Enter an email address",
    "error.securityChangesAreDisabledDuringImpersonation": "Security changes are disabled during impersonation",
    "error.emailDeliveryRequired": "Email delivery required",
    "error.emailDeliveryFailedChangeCancelled": "Email delivery failed; change cancelled",
    "error.emailDeliveryIsRequiredForDeletionRecovery": "Email delivery is required for deletion recovery",
    "error.deletionConfirmationRequired": "Deletion confirmation required",
    "copy.addThisKeyToYourAuthenticator": "Add this key to your authenticator:",
    "copy.storeTheseCodesSecurelyEachCanBeUsedOnce": "Store these codes securely. Each can be used once.",
    "copy.continueToYourAccount": "Continue to your account",
    "error.invalidAuthenticationFlow": "Invalid authentication flow",
    "error.authenticationFlowBelongsToAnotherBrowser": "Authentication flow belongs to another browser",
    "error.requestBodyTooLarge": "Request body too large",
    "error.jSONRequired": "JSON required",
    "error.invalidAuthenticationPayload": "Invalid authentication payload",
    "error.confirmYourIdentityFirst": "Confirm your identity first",
    "error.pOSTRequired": "POST required",
    "error.invalidProviderResponse": "Invalid provider response",
    "error.gETOrPOSTRequired": "GET or POST required",
    "error.formCallbackRequired": "Form callback required",
    "error.invalidProviderState": "Invalid provider state",
    "error.providerFlowMismatch": "Provider flow mismatch",
    "error.invalidIdentityIssuer": "Invalid identity issuer",
    "error.anExistingLinkedAccountIsRequired": "An existing linked account is required",
    "page.completeYourAccount": "Complete your account",
    "error.identityChangedDuringSignIn": "Identity changed during sign in",
    "error.invalidEnrollment": "Invalid enrollment",
    "error.identityChangedDuringEnrollment": "Identity changed during enrollment",
    "error.unknownAuthenticationField": "Unknown authentication field",
    "error.browserFlowRequired": "Browser flow required",
    "error.flowIDRequired": "Flow ID required",
    "error.invalidChallenge": "Invalid challenge",
    "error.invalidCredential": "Invalid credential",
    "error.accountChangedDuringCeremony": "Account changed during ceremony",
    "error.passkeyAuthenticationFailed": "Passkey authentication failed",
    "error.passkeyBelongsToAnotherAccount": "Passkey belongs to another account",
    "error.invalidSecondFactor": "Invalid second factor",
    "action.startTenMinuteSupportImpersonation": "Start ten-minute support impersonation",
    "copy.selectASectionOnlyPermittedOperationsAreShownConfigurationRemainsInVersionControlledProjectFiles": "Select a section. Only permitted operations are shown. Configuration remains in version-controlled project files.",
    "copy.authenticationActivityLast30UTCDays": "Authentication activity: last 30 UTC days",
    "copy.recordedAccountCreationsSuccessfulSignInsAndFailedSignInsTheseFiguresDescribeAuthenticationActivityDeploymentH": "Recorded account creations, successful sign-ins and failed sign-ins. These figures describe authentication activity; deployment health is not measured here.",
    "copy.dailyAuthenticationCounts": "Daily authentication counts",
    "copy.uTCDay": "UTC day",
    "copy.signUps": "Sign-ups",
    "copy.signIns": "Sign-ins",
    "copy.failedSignIns": "Failed sign-ins",
    "copy.authenticationMethodsOverTheSame30Days": "Authentication methods over the same 30 days",
    "copy.method": "Method",
    "copy.recentEvents": "Recent events",
    "page.supportCases": "Support cases",
    "action.closeWithoutApplying": "Close without applying",
    "action.approveAndApply": "Approve and apply",
    "action.createCaseForASecondAdministrator": "Create case for a second administrator",
    "action.approveAccount": "Approve account",
    "action.sendInvitation": "Send invitation",
    "error.accountNotFound": "Account not found",
    "page.accountDetails": "Account details",
    "copy.email": "Email",
    "copy.status": "Status",
    "copy.emailVerified": "Email verified",
    "copy.authenticatorEnabled": "Authenticator enabled",
    "copy.created": "Created",
    "copy.language": "Language",
    "copy.termsVersion": "Terms version",
    "copy.recentAccountActivity": "Recent account activity",
    "copy.viewAccountAudit": "View account audit",
    "action.createAccountAndSendSetupLink": "Create account and send setup link",
    "copy.filterUsers": "Filter users",
    "action.exportThisPageAsCSV": "Export this page as CSV",
    "copy.exportThisFilteredPageOnlyAtMost50AccountsEmailAddressesStayMasked": "Export this filtered page only, at most 50 accounts. Email addresses stay masked.",
    "copy.bulkAction": "Bulk action",
    "copy.lock": "Lock",
    "copy.unlock": "Unlock",
    "field.typeLOCKUNLOCKOrREVOKESESSIONSFollowedByASpaceAndTheSelectedCount": "Type LOCK, UNLOCK or REVOKE-SESSIONS followed by a space and the selected count",
    "copy.selectAccountsInTheTableAllSelectedAccountsMustBePermittedOtherwiseNoneAreChanged": "Select accounts in the table. All selected accounts must be permitted; otherwise none are changed.",
    "copy.applyBulkAction": "Apply bulk action",
    "copy.accountsEmailAddressesMasked": "Accounts (email addresses masked)",
    "copy.select": "Select",
    "copy.actions": "Actions",
    "copy.roleDefinitionsAreReadOnlyHere": "Role definitions are read-only here.",
    "action.revokeAllSessions": "Revoke all sessions",
    "field.fromUTC20260101T0000Z": "From UTC (2026-01-01T00:00Z)",
    "field.toUTC20260102T0000Z": "To UTC (2026-01-02T00:00Z)",
    "copy.filterAudit": "Filter audit",
    "copy.recentSecurityEvents": "Recent security events",
    "copy.time": "Time",
    "copy.action": "Action",
    "copy.actor": "Actor",
    "copy.subject": "Subject",
    "error.aReasonIsRequired": "A reason is required",
    "error.confirmYourIdentityBeforeThisAction": "Confirm your identity before this action",
    "error.invalidBulkAction": "Invalid bulk action",
    "error.typedConfirmationMustMatchTheActionAndSelectedCount": "Typed confirmation must match the action and selected count",
    "page.bulkUpdateCompleted": "Bulk update completed",
    "error.setupDeliveryUnavailable": "Setup delivery unavailable",
    "error.invalidCaseAction": "Invalid case action",
    "error.impersonationNotificationIsRequired": "Impersonation notification is required",
    "error.invitationDeliveryUnavailable": "Invitation delivery unavailable",
    "error.invalidStatus": "Invalid status",
    "field.currentPassword": "Current password",
    "field.currentPasswordOptional": "Current password (if configured)",
    "field.displayName": "Display name",
    "field.invitation": "Invitation token",
    "field.newEmail": "New email address",
    "field.passwordMinimum": "Password (at least 15 characters)",
    "field.passwordOptional": "Password (if configured)",
    "field.locale": "Preferred language",
    "field.recoveryAlternative": "Recovery code (instead of authenticator code)",
    "field.totpOptional": "Authenticator code (if enabled)",
    "field.emailCode": "Six-digit email code",
    "field.deleteConfirmation": "Type DELETE to confirm",
    "field.accountId": "Account ID",
    "field.caseAction": "Action: reset-factors, lock, unlock or roles",
    "field.approvalReason": "Approval reason",
    "field.caseNote": "Case note",
    "field.closureReason": "Closure reason",
    "field.emailFilter": "Email contains",
    "field.role": "Role name",
    "field.roles": "Role names separated by commas",
    "field.caseRoles": "Roles (for roles action)",
    "field.status": "Status: active, locked or pending-delete",
    "page.passwordReset": "Reset password",
    "page.newPassword": "Choose a new password",
    "page.emailVerification": "Verify email",
    "page.emailCode": "Sign in by email",
    "page.enterEmailCode": "Enter your email code",
    "page.deletionCancellation": "Cancel account deletion",
    "page.totpSetup": "Set up authenticator",
    "page.recoveryCodes": "Save your recovery codes",
    "page.supportImpersonation": "Support impersonation",
    "page.registrationRequest": "Request an account",
    "page.verifyEmailChange": "Verify email change",
    "page.cancelEmailChange": "Cancel email change",
    "page.secondFactor": "Confirm second factor",
    "page.users": "Users",
    "page.roles": "Roles",
    "page.audit": "Audit",
    "page.cases": "Cases",
    "page.registrations": "Registration requests",
    "page.updateCompleted": "Update completed",
    "page.completeRegistration": "Complete registration",
    "action.sendEmailCode": "Send sign-in code",
    "action.keepAccount": "Keep my account",
    "action.sendVerification": "Send verification email",
    "action.setupTotp": "Set up authenticator",
    "action.disableTotp": "Disable authenticator",
    "action.confirmTotp": "Confirm authenticator",
    "action.updateProfile": "Update profile",
    "action.changePassword": "Change password and sign out all sessions",
    "action.exportData": "Export account data",
    "action.scheduleDeletion": "Schedule account deletion",
    "action.signOutAll": "Sign out all sessions",
    "action.endImpersonation": "End impersonation",
    "action.requestAccount": "Request account",
    "action.completeSignIn": "Complete sign in",
    "action.sendReset": "Send reset link",
    "action.findSessions": "Find sessions",
    "action.revokeSessions": "Revoke sessions",
    "action.assignRoles": "Assign roles",
    "action.lock": "Lock account",
    "action.unlock": "Unlock account",
    "action.addPasskey": "Add a passkey",
    "action.signInPasskey": "Sign in with a passkey",
    "action.changeEmail": "Change email address",
    "action.approveCase": "Approve case",
    "action.closeCase": "Close case",
    "action.addNote": "Add note",
    "action.search": "Search",
    "nav.overview": "Overview",
    "nav.users": "Users",
    "nav.roles": "Roles",
    "nav.audit": "Audit",
    "nav.cases": "Cases",
    "nav.registration": "Registration",
    "nav.forgotPassword": "Forgot password",
    "message.operationCompleted": "The operation completed.",
    "message.registrationReceived": "Registration request received.",
    "message.noSession": "Sign in required",
    "message.permissionRequired": "Permission required",
    'page.signIn': 'Sign in', 'page.register': 'Create account', 'page.account': 'Your account', 'page.sessions': 'Your sessions', 'page.stepUp': 'Confirm your identity', 'page.error': 'Request could not be completed', 'page.admin': 'Administration',
    'field.email': 'Email address', 'field.password': 'Password', 'field.newPassword': 'New password', 'field.reason': 'Reason', 'field.totp': 'Authenticator code', 'field.recoveryCode': 'Recovery code',
    'action.signIn': 'Sign in', 'action.register': 'Create account', 'action.signOut': 'Sign out', 'action.confirm': 'Confirm identity', 'action.resetPassword': 'Reset password', 'action.save': 'Save changes', 'action.next': 'Next page',
    'nav.account': 'Account', 'nav.sessions': 'Sessions', 'nav.security': 'Security', 'nav.admin': 'Administration', 'nav.skip': 'Skip to content',
    'message.sessionCount': Object.freeze({ one: '{count} session', other: '{count} sessions' }),
    'message.accessDenied': 'Access denied', 'message.requestFailed': 'Request could not be completed', 'message.csrfRequired': 'Reload the page before submitting again.',
});
export interface ThemeVariables {
    '--auth-background'?: string;
    '--auth-foreground'?: string;
    '--auth-accent'?: string;
    '--auth-border'?: string;
    '--auth-radius'?: string;
}
export interface PresentationOptions {
    catalogues?: Record<string, Catalogue>;
    defaultLocale?: string;
    theme?: ThemeVariables;
    logo?: string;
    favicon?: string;
}
export interface LocalePreferences {
    accountLocale?: string;
    queryLocale?: string;
    acceptLanguage?: string;
}
export interface PresentationContext {
    readonly locale: string;
    readonly lang: string;
    readonly dir: 'ltr' | 'rtl';
    readonly cssVariables: string;
    readonly logo?: string;
    readonly favicon?: string;
    textSource(sourceEnglish: string): string;
    text(key: string, values?: Readonly<Record<string, string | number>>): string;
}
export interface Presentation {
    readonly locales: readonly string[];
    resolve(preferences?: LocalePreferences): PresentationContext;
}
const englishKeys = new Map(Object.entries(englishCatalogue).filter((entry): entry is [
    string,
    string
] => typeof entry[1] === 'string').map(([key, value]) => [value, key]));
const pluralKeys = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
function canonical(value: string): string {
    if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value))
        throw new Error('Invalid catalogue locale');
    try {
        return Intl.getCanonicalLocales(value)[0]!;
    }
    catch {
        throw new Error('Invalid catalogue locale');
    }
}
function asset(value: string | undefined): string | undefined {
    if (value === undefined)
        return;
    // No query, fragment, scheme, escaped separator, traversal, HTML or CSS syntax.
    if (typeof value !== 'string' || value.length > 512 || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.split('/').some(part => part === '.' || part === '..'))
        throw new Error('Presentation assets require a safe local path');
    return value;
}
function themeCss(theme: ThemeVariables = {}): string {
    if (!theme || typeof theme !== 'object' || Array.isArray(theme) || Object.keys(theme).length > 5)
        throw new Error('Invalid presentation theme');
    return Object.entries(theme).map(([name, value]) => {
        if (typeof value !== 'string')
            throw new Error('Invalid theme value');
        if (name === '--auth-radius') {
            if (!/^(?:0|(?:[0-9]|[12][0-9]|3[0-2])px)$/.test(value))
                throw new Error('Invalid theme radius');
        }
        else if (!['--auth-background', '--auth-foreground', '--auth-accent', '--auth-border'].includes(name) || !/^#[0-9a-fA-F]{6}$/.test(value))
            throw new Error('Theme colors must be six-digit hex');
        return `${name}:${value}`;
    }).sort().join(';');
}
function copyCatalogue(input: Catalogue): Catalogue {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 512)
        throw new Error('Catalogue exceeds key limit');
    const output: Catalogue = Object.create(null) as Catalogue;
    let bytes = 0;
    const message = (value: unknown): string => {
        if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
            throw new Error('Invalid catalogue message');
        bytes += new TextEncoder().encode(value).length;
        if (bytes > 65536)
            throw new Error('Catalogue exceeds byte limit');
        for (const match of value.matchAll(/\{([^{}]*)\}/g))
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(match[1]!))
                throw new Error('Invalid catalogue placeholder');
        return value;
    };
    for (const [key, value] of Object.entries(input)) {
        if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(key) || key.length > 128)
            throw new Error('Invalid catalogue key');
        if (typeof value === 'string')
            output[key] = message(value);
        else {
            if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'other') || Object.keys(value).some(form => !pluralKeys.has(form)))
                throw new Error('Plural catalogue requires valid categories and other');
            const forms: Record<string, string> = Object.create(null) as Record<string, string>;
            for (const [form, text] of Object.entries(value))
                forms[form] = message(text);
            output[key] = Object.freeze(forms) as PluralMessage;
        }
    }
    return Object.freeze(output);
}
const rtlLanguages = new Set(['ar', 'arc', 'dv', 'fa', 'he', 'ks', 'ku', 'nqo', 'ps', 'sd', 'syr', 'ug', 'ur', 'yi']);
const rtlScripts = new Set(['Arab', 'Hebr', 'Thaa', 'Nkoo', 'Adlm', 'Rohg', 'Syrc']);
export function createPresentation(options: PresentationOptions = {}): Presentation {
    const catalogues = new Map<string, Catalogue>([['en', copyCatalogue(englishCatalogue)]]);
    if (options.catalogues && (!options.catalogues || typeof options.catalogues !== 'object' || Array.isArray(options.catalogues) || Object.keys(options.catalogues).length > 16))
        throw new Error('Too many catalogues');
    const supplied = new Set<string>();
    for (const [requested, input] of Object.entries(options.catalogues ?? {})) {
        const locale = canonical(requested);
        if (supplied.has(locale))
            throw new Error('Duplicate catalogue locale');
        supplied.add(locale);
        catalogues.set(locale, copyCatalogue({ ...englishCatalogue, ...copyCatalogue(input) }));
    }
    const defaultLocale = canonical(options.defaultLocale ?? 'en');
    if (!catalogues.has(defaultLocale))
        throw new Error('Default locale has no catalogue');
    const cssVariables = themeCss(options.theme), logo = asset(options.logo), favicon = asset(options.favicon), locales = Object.freeze([...catalogues.keys()]);
    function match(value: string | undefined): string | undefined {
        if (!value)
            return;
        let requested: string;
        try {
            requested = canonical(value);
        }
        catch {
            return;
        }
        while (requested) {
            if (catalogues.has(requested))
                return requested;
            const index = requested.lastIndexOf('-');
            if (index < 0)
                break;
            requested = requested.slice(0, index);
        }
        const language = new Intl.Locale(value).language;
        return locales.find(locale => new Intl.Locale(locale).language === language);
    }
    return Object.freeze({ locales, resolve(preferences: LocalePreferences = {}): PresentationContext {
            let locale = match(preferences.accountLocale) || match(preferences.queryLocale);
            if (!locale && typeof preferences.acceptLanguage === 'string' && preferences.acceptLanguage.length <= 2048) {
                const ranges = preferences.acceptLanguage.split(',').slice(0, 32).map((part, index) => { const parsed = /^\s*([A-Za-z0-9-]+|\*)\s*(?:;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/.exec(part); return parsed ? { value: parsed[1]!, quality: Number(parsed[2] ?? 1), index } : undefined; }).filter((range): range is {
                    value: string;
                    quality: number;
                    index: number;
                } => Boolean(range && range.quality > 0)).sort((a, b) => b.quality - a.quality || a.index - b.index);
                for (const range of ranges) {
                    locale = range.value === '*' ? defaultLocale : match(range.value);
                    if (locale)
                        break;
                }
            }
            locale ??= defaultLocale;
            const selected = locale, info = new Intl.Locale(selected).maximize(), dir: 'rtl' | 'ltr' = info.script ? rtlScripts.has(info.script) ? 'rtl' : 'ltr' : rtlLanguages.has(info.language) ? 'rtl' : 'ltr', plural = new Intl.PluralRules(selected), numbers = new Intl.NumberFormat(selected), catalogue = catalogues.get(selected)!;
            return Object.freeze({ locale: selected, lang: selected, dir, cssVariables, ...(logo ? { logo } : {}), ...(favicon ? { favicon } : {}), textSource(sourceEnglish: string): string {
                    if (typeof sourceEnglish !== 'string' || sourceEnglish.length > 2048)
                        throw new Error('Invalid source text');
                    const key = englishKeys.get(sourceEnglish);
                    return key ? this.text(key) : sourceEnglish;
                }, text(key: string, values: Readonly<Record<string, string | number>> = {}): string {
                    if (!Object.hasOwn(catalogue, key))
                        throw new Error('Unknown catalogue key');
                    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 16)
                        throw new Error('Too many catalogue values');
                    for (const [name, value] of Object.entries(values))
                        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(name) || !(typeof value === 'string' && value.length <= 1024 || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12))
                            throw new Error('Invalid catalogue value');
                    const entry = catalogue[key]!;
                    let template: string;
                    if (typeof entry === 'string')
                        template = entry;
                    else {
                        if (typeof values.count !== 'number')
                            throw new Error('Plural message requires a numeric count');
                        template = entry[plural.select(values.count)] ?? entry.other;
                    }
                    const output = template.replace(/\{([a-zA-Z][a-zA-Z0-9_]{0,31})\}/g, (_whole, name: string) => {
                        if (!Object.hasOwn(values, name))
                            throw new Error('Missing catalogue value');
                        const value = values[name]!;
                        return typeof value === 'number' ? numbers.format(value) : value;
                    });
                    if (output.length > 8192)
                        throw new Error('Catalogue output exceeds limit');
                    return output;
                } });
        } });
}
