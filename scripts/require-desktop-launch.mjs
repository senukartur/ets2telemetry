if (process.env.ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH !== '1') {
  console.error('Desktop launch is gated after the host freeze. Obtain owner authorization for a runtime check in an isolated environment, then set ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH=1. Build/package/unit checks do not need this variable.');
  process.exit(1);
}
