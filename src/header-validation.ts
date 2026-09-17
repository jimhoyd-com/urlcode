// Header validation with no Node dependency, so one response policy runs on a
// Node server, a provider adapter and a Web-standard runtime. The rules are
// Node's: a name is an RFC 7230 token, and a value carries no control
// characters. test/header-validation.test.ts compares this against node:http
// across a wide input range, because disagreeing here is header injection.
const token = /^[\^`\-\w!#$%&'*+.|~]+$/;
const invalidValue = /[^\t -~-ÿ]/;

export function validateHeaderName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !token.test(name)) {
    throw new TypeError(`Invalid header name: ${String(name)}`);
  }
}

export function validateHeaderValue(name: string, value: unknown): void {
  if (value === undefined) throw new TypeError(`Invalid value "undefined" for header "${name}"`);
  if (invalidValue.test(String(value))) throw new TypeError(`Invalid character in header content ["${name}"]`);
}
