/**
 * Declared response shapes for the JSON form-endpoint contract in `docs/JSON-API.md` (`@1`),
 * so an HTTP suite's assertion and the type it asserts against agree in one place.
 *
 * Shapes reuse auth's own source types (`AuthUser`, `AuthRestriction`, `SignupState['step']`, and
 * the passkey provider's own option types) rather than mirroring them: a contract change in
 * `src/` then breaks the tests at compile time instead of passing against a stale copy here.
 *
 * Fields typed `?: undefined` are the *negative* half of the contract — a response that must
 * never carry them (a session token, a passkey's public key, signup flow internals). Declaring
 * them absent rather than omitting them keeps the "did not leak" assertions compiling while
 * making the type itself reject any handler that starts returning a value there.
 */
import type { AuthRestriction, AuthUser, SignupState } from '../../src/auth-core.ts';
import type { createPasskeyProvider } from '../../src/passkeys.ts';

type PasskeyProvider = ReturnType<typeof createPasskeyProvider>;
/** WebAuthn creation options, exactly as the provider generates them. */
export type PasskeyCreationOptions = Awaited<ReturnType<PasskeyProvider['beginRegistration']>>;
/** WebAuthn request options, exactly as the provider generates them. */
export type PasskeyRequestOptions = Awaited<ReturnType<PasskeyProvider['beginAuthentication']>>;

/** `GET /csrf` */
export interface CsrfBody { csrf: string }

/** `POST /login`, `/email-code`, `/register`, `/passkeys/login/verify`, `/providers/<name>/callback` — the `finish()` result. */
export interface SessionBody {
    user: AuthUser;
    csrf: string;
    restrictions?: AuthRestriction[];
    impersonatorId?: string;
    /** Session material travels by `set-cookie` only; never in the body. */
    token?: undefined;
}

/** `GET /signup`. `step` reads `'identifier'` when no flow is in progress. */
export interface SignupStatusBody {
    step: SignupState['step'] | 'identifier';
    csrf: string;
    expires?: number;
    /** Flow internals stay server-side: a resumed signup must not echo them back. */
    flowId?: undefined;
    email?: undefined;
}

/** `POST /signup/begin` — and, without `expires`, the shared `/signup/verify` and `/signup/password` reply. */
export interface SignupStepBody { step: SignupState['step']; expires: number }

/** `POST /signup/passkeys/options` */
export interface SignupPasskeyOptionsBody { options: PasskeyCreationOptions }

/** `POST /signup/complete`. `csrf` is present only when an account and session were created. */
export interface SignupCompleteBody { complete: true; redirect: string; csrf?: string }

/** `POST /passkeys/{register,login,step-up}/options` */
export interface PasskeyLoginOptionsBody { options: PasskeyRequestOptions; flowId: string }

/** `POST /second-factor/options` */
export interface SecondFactorOptionsBody { flowId: string; options: PasskeyRequestOptions }

/** `POST /second-factor/verify` */
export interface SecondFactorTokenBody { secondFactorToken: string }

/** `GET /second-factors` */
export interface SecondFactorsBody {
    passkeys: {
        id: string;
        secondFactor: boolean;
        /** Credential material must not be served to the account holder. */
        publicKey?: undefined;
    }[];
    csrf: string;
}

/** `GET /trusted-devices` */
export interface TrustedDevicesBody {
    devices: { id: string; label: string; created: number; expires: number }[];
    csrf: string;
}

/** `POST /trusted-devices/remember` */
export interface TrustedDeviceRememberedBody {
    remembered: true;
    expires: number;
    /** The device secret is set as a cookie, never returned. */
    token?: undefined;
}

/** `POST /step-up`, `POST /passkeys/step-up/verify` */
export interface StepUpBody { confirmed: true; csrf: string; restrictions?: AuthRestriction[] }

/** `POST /restore-access`, `POST /recover-factor/complete` — lower-assurance recovery, always into enrollment. */
export interface EnrollmentRequiredBody {
    enrollmentRequired: true;
    user: AuthUser;
    csrf: string;
    /** As with `SessionBody`, the session arrives by cookie. */
    token?: undefined;
}

/** `POST /forgot-password`, `/send-verification`, `/recover-factor`, and the `202` honeypot/waitlist reply — deliberately free of any user-enumeration signal. */
export interface MessageBody { message: string }

/** `POST /totp/begin` — the raw enrollment object, unwrapped. */
export interface TotpBeginBody { secret: string; otpauthUrl: string }

/**
 * Reads a JSON response body as one of the contract shapes above. `response.json()` is `unknown`
 * under auth's tsconfig (ES2024 lib, no DOM), so the assertion is made once, here, against a
 * named shape instead of at each call site against `any`.
 */
export async function body<T>(response: { json(): Promise<unknown> }): Promise<T> {
    return await response.json() as T;
}
