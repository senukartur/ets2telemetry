// ET-055 PR-4 (UP13): every Vitest suite runs with the same build-channel environment, whatever the shell that starts it
// sets. The build variables are removed before any test file loads, so scripts/build-channel.mjs resolves its default
// (staging) in-process and in every child process a test starts with process.env. Tests that compare script helpers with
// the unbundled apps/desktop/src/channel.ts (production, it has no build define) pass the channel explicitly, and tests of
// the resolver pass their own environment objects. No test sets the owner override; a test reads the production packaging
// configuration only through tests/shared/forge-config.ts, which builds nothing.
for (const name of ['ETS2TELEMETRY_BUILD_CHANNEL', 'ETS2TELEMETRY_OWNER_PRODUCTION_BUILD', 'ETS2TELEMETRY_STAGING_RUN_NUMBER']) delete process.env[name];
