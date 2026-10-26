import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNIT_NAME,
  WRAPPER_MARK,
  applicationsDir,
  forgetAppImage,
  installUnit,
  installWrapper,
  isOurWrapper,
  patchDesktopEntries,
  recordAppImage,
  removeUnit,
  removeWrapper,
  renderWrapper,
  resolveAppImage,
  restoreDesktopEntries,
  unitEnabled,
  unitPath,
  wrapperPath,
} from "../src/desktop.js";

const APP = (name, bytes = 1_200_000) => {
  const path = join(process.env["HOME"], "Applications", name);
  writeFileSync(path, `#!/bin/sh\nexit 0\n${"#".repeat(bytes)}`);
  chmodSync(path, 0o755);
  return path;
};

let home;

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "blackout-desktop-"));
  process.env["HOME"] = home;
  mkdirSync(join(home, "Applications"), { recursive: true });
});

test("the newest AppImage wins when nothing is recorded", () => {
  const older = APP("ADCode-2.4.0.AppImage");
  const newer = APP("ADCode-2.5.0.AppImage");
  const past = new Date(Date.now() - 120_000);
  utimesSync(older, past, past);
  const resolved = resolveAppImage({ home, env: {} });
  assert.equal(resolved.found, true);
  assert.equal(resolved.reason, "newest");
  assert.equal(resolved.path, newer);
});

test("a recorded path is preferred while it still exists", () => {
  const first = APP("ADCode-2.4.0.AppImage");
  const second = APP("ADCode-2.5.0.AppImage");
  recordAppImage(first, home);
  assert.equal(resolveAppImage({ home, env: {} }).path, first);
  assert.ok(second);
});

test("when the recorded AppImage is gone, discovery takes over", () => {
  const present = APP("ADCode-2.5.0.AppImage");
  recordAppImage(join(home, "Applications", "deleted.AppImage"), home);
  const resolved = resolveAppImage({ home, env: {} });
  assert.equal(resolved.path, present);
  assert.equal(resolved.reason, "newest");
});

test("an explicit path and ADCODE_APPIMAGE both beat discovery", () => {
  APP("ADCode-2.5.0.AppImage");
  const chosen = APP("ADCode-custom.AppImage");
  assert.equal(resolveAppImage({ home, env: {}, explicit: chosen }).reason, "explicit");
  assert.equal(resolveAppImage({ home, env: { ADCODE_APPIMAGE: chosen } }).reason, "env");
});

test("a file too small to be an AppImage is not one", () => {
  const tiny = join(home, "Applications", "ADCode-tiny.AppImage");
  writeFileSync(tiny, "not really");
  const resolved = resolveAppImage({ home, env: {} });
  assert.equal(resolved.found, false);
  assert.equal(resolved.reason, "none");
});

test("the wrapper is marked, executable and quotes its paths", () => {
  const path = installWrapper({ home, node: "/usr/bin/node", cli: "/tmp/it's here/blackout.js" });
  const text = readFileSync(path, "utf8");
  assert.match(text, new RegExp(WRAPPER_MARK));
  assert.match(text, /NODE='\/usr\/bin\/node'/);
  assert.match(text, /'\/tmp\/it'\\''s here\/blackout\.js'/);
  assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.equal(isOurWrapper(path), true);
});

test("a foreign file at the wrapper path is left alone", () => {
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(wrapperPath(home), "#!/bin/sh\necho mine\n");
  assert.throws(() => installWrapper({ home, cli: "/x" }), /already exists/);
  assert.throws(() => removeWrapper(home), /refusing to remove/);
});

test("install is idempotent and uninstall removes only its own wrapper", () => {
  const path = installWrapper({ home, cli: "/x/blackout.js" });
  installWrapper({ home, cli: "/x/blackout.js" });
  assert.equal(removeWrapper(home), true);
  assert.equal(existsSync(path), false);
  assert.equal(removeWrapper(home), false);
});

test("desktop entries for this AppImage are repointed, with a backup", () => {
  const app = APP("ADCode-2.4.0.AppImage");
  const dir = applicationsDir(home);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "adcode.desktop");
  writeFileSync(entry, `[Desktop Entry]\nType=Application\nName=ADCode\nExec=${app} %U\n`);
  const other = join(dir, "other.desktop");
  writeFileSync(other, `[Desktop Entry]\nExec=/opt/other %U\n`);

  const patched = patchDesktopEntries({ home, appImage: app });
  assert.equal(patched.length, 1);
  assert.match(readFileSync(entry, "utf8"), new RegExp(`Exec="${wrapperPath(home)}" %U`));
  assert.doesNotMatch(readFileSync(other, "utf8"), /blackout/);
  assert.ok(existsSync(`${entry}.blackout-backup`));

  restoreDesktopEntries(home);
  assert.match(readFileSync(entry, "utf8"), new RegExp(app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a symlinked entry is left alone, and so is its target", () => {
  // ~/.local/share/applications sometimes links to /usr/share. Following the
  // link would rewrite a file outside the directory this command owns, and the
  // backup would then replace the link on uninstall.
  const target = join(home, "system-adcode.desktop");
  writeFileSync(target, `[Desktop Entry]\nExec=/home/me/Applications/ADCode-2.3.0.AppImage %U\n`);
  const link = join(applicationsDir(home), "linked.desktop");
  mkdirSync(applicationsDir(home), { recursive: true });
  symlinkSync(target, link);

  const app = APP("ADCode-2.4.0.AppImage");
  const patched = patchDesktopEntries({ home, appImage: app });
  assert.equal(patched.length, 0);
  assert.match(readFileSync(target, "utf8"), /ADCode-2\.3\.0\.AppImage/, "the target is untouched");
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
  assert.ok(!existsSync(`${link}.blackout-backup`), "no backup was written beside the link");

  // And a backup next to a link is not restored over it.
  writeFileSync(`${link}.blackout-backup`, "backup\n");
  assert.deepEqual(restoreDesktopEntries(home), []);
  assert.ok(lstatSync(link).isSymbolicLink());
  rmSync(`${link}.blackout-backup`);
});

test("an entry for an older AppImage is repointed too", () => {
  const old = join(applicationsDir(home), "adcode.desktop");
  mkdirSync(applicationsDir(home), { recursive: true });
  writeFileSync(old, `[Desktop Entry]\nExec="/home/me/Applications/ADCode-2.3.0.AppImage" %U\n`);
  const current = APP("ADCode-2.5.0.AppImage");
  const patched = patchDesktopEntries({ home, appImage: current });
  assert.equal(patched.length, 1);
  assert.match(readFileSync(old, "utf8"), new RegExp(`Exec="${wrapperPath(home)}" %U`));
  assert.ok(existsSync(`${old}.blackout-backup`));
});

test("patchDesktopEntries does not touch an entry twice", () => {
  const app = APP("ADCode-2.4.0.AppImage");
  mkdirSync(applicationsDir(home), { recursive: true });
  const entry = join(applicationsDir(home), "adcode.desktop");
  writeFileSync(entry, `[Desktop Entry]\nExec=${app} %U\n`);
  patchDesktopEntries({ home, appImage: app });
  assert.equal(patchDesktopEntries({ home, appImage: app }).length, 0);
});

test("the unit carries the resolved node and CLI, and can be removed", () => {
  const path = installUnit({ home, node: "/usr/bin/node", cli: "/opt/blackout.js", port: 9000 });
  const text = readFileSync(path, "utf8");
  assert.match(text, /ExecStart="\/usr\/bin\/node" "\/opt\/blackout\.js" serve --foreground --port 9000/);
  assert.match(text, /StateDirectory=blackout/);
  assert.match(text, /NoNewPrivileges=yes/);
  assert.match(text, /PrivateTmp=yes/);
  assert.match(text, /ProtectSystem=strict/);
  assert.match(text, /ProtectHome=read-only/);
  assert.equal(removeUnit(home), true);
  assert.equal(existsSync(unitPath(home)), false);
});

test("forgetting the record removes only the record", () => {
  const app = APP("ADCode-2.4.0.AppImage");
  recordAppImage(app, home);
  assert.equal(forgetAppImage(home), true);
  assert.equal(forgetAppImage(home), false);
  assert.ok(existsSync(app));
});

test("renderWrapper survives a path containing a single quote", () => {
  const wrapper = renderWrapper({ node: "/bin/node", cli: "/tmp/a'b/blackout.js" });
  assert.match(wrapper, /'\/tmp\/a'\\''b\/blackout\.js'/);
});

test("an explicit path that cannot be used is named back, and is not second-guessed", () => {
  const usable = APP("ADCode-2.5.0.AppImage");
  const tiny = join(home, "Applications", "ADCode-small.AppImage");
  writeFileSync(tiny, "not really");
  const resolved = resolveAppImage({ home, env: {}, explicit: tiny });
  assert.equal(resolved.found, false);
  assert.equal(resolved.rejected, tiny);
  assert.equal(resolved.reason, "explicit-rejected");
  // There is a usable AppImage in this home; refusing is still right, because
  // launching a different build than the one named is the worse answer.
  assert.equal(resolveAppImage({ home, env: {} }).path, usable);
  assert.equal(resolveAppImage({ home, env: {} }).rejected, undefined);
});

test("a wrapper that cannot be read is not ours", () => {
  assert.equal(isOurWrapper(join(home, ".local", "bin", "adcode")), false, "a missing file is not ours");
  const file = wrapperPath(home);
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(file, "#!/bin/sh\necho someone else\n");
  assert.equal(isOurWrapper(file), false, "and neither is one somebody else wrote");
  writeFileSync(file, renderWrapper({ cli: "/opt/blackout/bin/blackout.js", home }));
  assert.equal(isOurWrapper(file), true);
});

test("an entry that is not a regular file is left alone", () => {
  const dir = applicationsDir(home);
  mkdirSync(dir, { recursive: true });
  // A directory wearing an entry's name, and a link to a build that is gone.
  // Neither can be patched, and neither may be deleted by a patch that decided
  // to "fix" what it found.
  mkdirSync(join(dir, "adcode.desktop"), { recursive: true });
  symlinkSync(join(home, "Applications", "gone.AppImage"), join(dir, "dangling.desktop"));
  const app = APP("ADCode-2.4.0.AppImage");

  assert.deepEqual(patchDesktopEntries({ home, appImage: app }), []);
  assert.equal(lstatSync(join(dir, "adcode.desktop")).isDirectory(), true);
  assert.equal(existsSync(join(dir, "dangling.desktop.blackout-backup")), false);
});

test("an enabled unit is visible in the wants directory", () => {
  assert.equal(unitEnabled(home), false);
  const wants = join(home, ".config", "systemd", "user", "default.target.wants");
  mkdirSync(wants, { recursive: true });
  writeFileSync(join(wants, UNIT_NAME), "");
  assert.equal(unitEnabled(home), true);
});
