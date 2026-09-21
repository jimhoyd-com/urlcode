// The identity release automation commits as. A runner or a release container has no
// git identity of its own ("Author identity unknown", #376), so every commit the release
// scripts make passes this on the command line rather than relying on ambient config.
// test/release-rehearsal.test.ts fails a script that commits without it.
export const releaseIdentity: readonly string[] = ['-c', 'user.name=urlcode-release', '-c', 'user.email=urlcode-release@users.noreply.github.com'];
