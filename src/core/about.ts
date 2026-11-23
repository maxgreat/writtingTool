import { version } from "../../src-tauri/tauri.conf.json";

/**
 * The app's version, read from src-tauri/tauri.conf.json when the interface
 * is built: the version the desktop bundles and Android's versionName carry.
 */
export const APP_VERSION: string = version;

/**
 * The privacy policy, on the app's website (docs/privacy.html). The app may
 * open pages of that site only: see src-tauri/capabilities/default.json.
 */
export const PRIVACY_POLICY_URL = "https://maxgreat.github.io/writtingTool/privacy.html";
