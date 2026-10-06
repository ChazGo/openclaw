/**
 * Build-time switch for local trusted-install builds. `OPENCLAW_LOCAL_TRUSTED_INSTALL=1 pnpm build`
 * defines it; source runs and every default build leave it off.
 *
 * TRADE-OFF (read before enabling). With the switch on:
 * - installed plugins load in place, like bundled plugins: no capture copy, no per-file source
 *   digest, no per-import capture containment, no native-addon admission, and no digest
 *   expectation on install or reload (reloads fall back to a full plugin reload);
 * - the updater fingerprints package trees by stat identity (inode, mode, size, mtime) instead of
 *   hashing file bytes, and its retention and package-swap checks ignore ctime.
 * A process that rewrites plugin or package bytes in place while preserving size and mtime is no
 * longer detected at load, reload, or update. The installer's package-level check (TGZ SHA-256
 * and embedded commit) stays the integrity boundary. Manifest discovery, package-owner metadata,
 * plugin entry resolution, and every sandbox, approval, and auth boundary are unchanged.
 *
 * It exists for hosts where Endpoint DLP stamps ctime on the first read of files and makes each
 * fresh read expensive. Never enable it in a published build.
 */
declare const OPENCLAW_LOCAL_TRUSTED_INSTALL: boolean;

export const LOCAL_TRUSTED_INSTALL: boolean =
  typeof OPENCLAW_LOCAL_TRUSTED_INSTALL === "boolean" && OPENCLAW_LOCAL_TRUSTED_INSTALL;
