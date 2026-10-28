import {version as packageVersion} from '../../../package.json';

// The application version of this build (ET-055 UP15). scripts/build-channel.mjs resolves it and scripts/build.mjs replaces
// __ETS2TELEMETRY_APP_VERSION__ in every bundle: the package.json version in production, `<version>-stg.<run>` in staging.
// The packaged package.json, the Squirrel package, the plugin bundle and this constant carry the same value.

/** Replaced by scripts/build.mjs with the resolved build version; undefined where no build defines it. */
declare const __ETS2TELEMETRY_APP_VERSION__: string | undefined;

/** This build's version; unbundled code (Vitest, the storage test bundles) uses the package.json version. */
export const APP_VERSION: string = typeof __ETS2TELEMETRY_APP_VERSION__ === 'undefined' ? packageVersion : __ETS2TELEMETRY_APP_VERSION__;
