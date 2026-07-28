// Llama Manager Flasher — electron-builder afterSign notarization hook.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Notarizes the macOS build with Apple when credentials are provided via the
// environment (APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD, plus APPLE_TEAM_ID),
// and SKIPS with a loud warning when they are absent so unsigned local / CI
// builds still complete. Non-mac platforms are a no-op. The CI mac node
// provides the credentials when notarized releases are wanted.

/**
 * electron-builder afterSign hook entry point.
 *
 * @param {import('electron-builder').AfterPackContext} context - Builder
 *   context; `electronPlatformName` and `appOutDir` identify the artifact.
 * @returns {Promise<void>} Resolves when notarization finished or was skipped.
 */
module.exports = async function notarizeHook(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !applePassword) {
    console.warn(
      '[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD not set — SKIPPING notarization. ' +
      'The dmg will trip Gatekeeper until it is notarized.',
    );
    return;
  }
  if (!teamId) {
    console.warn('[notarize] APPLE_TEAM_ID not set — SKIPPING notarization.');
    return;
  }

  const { notarize } = require('@electron/notarize');
  const appName = packager.appInfo.productFilename;
  console.log(`[notarize] Notarizing ${appName}.app with Apple…`);
  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword: applePassword,
    teamId,
  });
  console.log('[notarize] Done.');
};
