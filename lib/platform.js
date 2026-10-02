// Cross-platform facts about the droid CLI: where its executable lives, how a
// user signs a second account in, and where the machine's envelope key is kept.
//
// droid ships as one compiled binary whose install location differs per OS and
// per install method (npm global prefix, the Factory desktop app bundle, a plain
// PATH install), and it keeps its AES key in the OS keyring — macOS login
// keychain, Windows Credential Manager, Linux Secret Service. Everything here is
// pure path/command construction that takes `{ platform, env, homedir }` instead
// of reading `process.*`, so the whole matrix is unit-testable from any one OS.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEYCHAIN_SERVICE = "Factory CLI";
const KEYCHAIN_ACCOUNT = "auth-encryption-key-security-cli";

/** PowerShell that reads one generic credential from the Windows Credential
 *  Manager. `CredReadW` is the same API the Rust keyring crate uses, so no
 *  third-party module has to be installed. `{target}` is substituted with the
 *  service name; the script prints `user<TAB>secret` and exits 1 when absent. */
export const WINDOWS_CRED_READ_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$sig=@'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class DshCred {",
  "  [DllImport(\"advapi32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]",
  "  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);",
  "  [DllImport(\"advapi32.dll\")] public static extern void CredFree(IntPtr buffer);",
  "  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]",
  "  public struct CREDENTIAL { public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;",
  "    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;",
  "    public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; }",
  "  public static string Read(string target) {",
  "    IntPtr raw;",
  "    if (!CredReadW(target, 1, 0, out raw)) return null;",
  "    try {",
  "      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(raw, typeof(CREDENTIAL));",
  "      string user = cred.UserName == IntPtr.Zero ? \"\" : Marshal.PtrToStringUni(cred.UserName);",
  "      byte[] blob = new byte[cred.CredentialBlobSize];",
  "      if (cred.CredentialBlobSize > 0) Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);",
  "      return user + \"\\t\" + System.Text.Encoding.UTF8.GetString(blob);",
  "    } finally { CredFree(raw); }",
  "  }",
  "}",
  "'@",
  "Add-Type -TypeDefinition $sig",
  "$hit=[DshCred]::Read('{target}')",
  "if ($null -eq $hit) { exit 1 }",
  "Write-Output $hit",
].join("\n");

/** Path helpers for the platform being described, not the one running. */
function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Candidate droid executables, most specific first. `PATH` itself is not
 *  enumerated here: a bare `droid` is the last resort and the OS resolves it. */
export function droidCandidates({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const p = pathFor(platform);
  const names =
    platform === "win32" ? ["droid.exe", "droid.cmd", "droid.bat", "droid"] : ["droid"];
  const localAppData = env.LOCALAPPDATA ?? p.join(homedir, "AppData", "Local");
  const appData = env.APPDATA ?? p.join(homedir, "AppData", "Roaming");
  const dirs =
    platform === "win32"
      ? [
          p.join(localAppData, "Programs", "Factory"),
          p.join(localAppData, "Factory"),
          p.join(appData, "npm"),
          p.join(env.ProgramFiles ?? "C:\\Program Files", "Factory"),
          p.join(homedir, ".factory", "bin"),
          p.join(homedir, ".local", "bin"),
        ]
      : [
          p.join(homedir, ".local", "bin"),
          "/usr/local/bin",
          "/opt/homebrew/bin",
          "/usr/bin",
          p.join(homedir, ".factory", "bin"),
          ...(platform === "darwin"
            ? [
                "/Applications/Factory.app/Contents/Resources/bin",
                "/Applications/Factory.app/Contents/MacOS",
              ]
            : []),
        ];
  return dirs.flatMap((dir) => names.map((name) => p.join(dir, name)));
}

/** The first candidate that exists, else `undefined` so callers can fall back
 *  to the bare name and let the OS PATH decide. */
export function findDroidExecutable({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  return droidCandidates({ platform, env, homedir }).find((candidate) => {
    try {
      return exists(candidate);
    } catch {
      return false;
    }
  });
}

/** Quote an argument for the shell that will run it. Windows paths contain
 *  spaces far more often than POSIX ones, and both `cmd` and PowerShell accept
 *  double quotes. */
function quote(argument) {
  return `"${String(argument).replace(/"/g, '\\"')}"`;
}

/** The command that signs a new account into an isolated home. The environment
 *  syntax differs per OS — `VAR=value cmd` does not work in cmd.exe or
 *  PowerShell — so the caller gets a ready-to-paste line for its platform. */
export function loginCommand({
  platform = process.platform,
  home,
  droid = "droid",
  shell,
} = {}) {
  if (platform === "win32") {
    const selected = shell ?? "powershell";
    return selected === "cmd"
      ? `set "FACTORY_HOME_OVERRIDE=${home}" && ${quote(droid)}`
      : `$env:FACTORY_HOME_OVERRIDE="${home}"; & ${quote(droid)}`;
  }
  return `FACTORY_HOME_OVERRIDE=${quote(home)} ${quote(droid)}`;
}

/** Envelope file names in the order droid may have written them. droid <0.231
 *  used a plaintext key file next to `auth.v2.file`; later versions keep the key
 *  in the OS keyring and name the envelope after the backend that holds it —
 *  `auth.v2.loginkeychain` on macOS, `auth.v2.keyring` for the generic
 *  (Windows Credential Manager / Secret Service) path. */
export const ENVELOPE_NAMES = ["auth.v2.file", "auth.v2.keyring", "auth.v2.loginkeychain"];

/** The first keyring reader that can apply on this platform, as a runnable
 *  descriptor: `{ id, file, args }`. Tests assert the exact command per OS
 *  without executing anything; production runs it and parses stdout. */
export function authKeyCommands({ platform = process.platform, env = process.env } = {}) {
  const service = env.FACTORY_KEYCHAIN_SERVICE ?? KEYCHAIN_SERVICE;
  const account = env.FACTORY_KEYCHAIN_ACCOUNT ?? KEYCHAIN_ACCOUNT;
  if (platform === "darwin") {
    return [
      {
        id: "macos-login-keychain",
        file: "/usr/bin/security",
        args: ["find-generic-password", "-s", service, "-a", account, "-w"],
      },
    ];
  }
  if (platform === "win32") {
    return [
      {
        id: "windows-credential-manager",
        file: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_CRED_READ_SCRIPT.replace("{target}", service),
        ],
        // `user<TAB>secret` – the user name picks out the account when a target
        // holds several credentials.
        account,
        parse: "windows-credential",
      },
    ];
  }
  if (platform === "linux") {
    return [
      {
        id: "linux-secret-service",
        file: "secret-tool",
        args: ["lookup", "service", service, "account", account],
      },
      {
        id: "linux-secret-service-username",
        file: "secret-tool",
        args: ["lookup", "service", service, "username", account],
      },
    ];
  }
  return [];
}
