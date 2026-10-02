import { existsSync } from 'node:fs'
import path from 'node:path'

import { buildDesktopBackendEnv } from './backend-env'
import { execProbe, PROBE_TIMEOUT_MS } from './backend-probes'
import { launcherTargetsInstallation, resolveInstallationLauncher } from './updater-process'

export interface SourceBackend {
  kind: 'command' | 'python'
  label: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  root: string
  bootstrap: false
  shell: boolean
  local: 'installed'
}

interface SourceOptions {
  isWindows?: boolean
  env?: NodeJS.ProcessEnv
  excludedLaunchers?: readonly string[]
}

/** Keep the validated command. PM owns interpreter and generation selection. */
export async function resolveSourceInstallationBackend(
  root: string,
  args: string[],
  options: SourceOptions & { hermesHome?: string } = {}
): Promise<SourceBackend | null> {
  if (!existsSync(path.join(root, 'hermes_cli', 'main.py'))) {
    return null
  }

  const isWindows: boolean = options.isWindows ?? process.platform === 'win32'
  const env: NodeJS.ProcessEnv = buildDesktopBackendEnv({ currentEnv: options.env ?? process.env })
  const excluded = new Set((options.excludedLaunchers ?? []).map(value => path.resolve(value).toLowerCase()))

  for (;;) {
    const launcher = resolveInstallationLauncher(root, isWindows, options.hermesHome, excluded)

    if (!launcher) {
      return null
    }

    const shell = isWindows && /\.(cmd|bat)$/i.test(launcher)
    const command = shell ? `"${launcher}"` : launcher

    try {
      await execProbe(command, ['--version'], {
        cwd: root,
        env: { ...process.env, ...options.env, ...env },
        shell,
        stdio: 'ignore',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true
      })
    } catch {
      if (!isWindows) {
        return null
      }

      excluded.add(path.resolve(launcher).toLowerCase())

      continue
    }

    return {
      kind: 'command',
      label: `Hermes at ${root}`,
      command,
      args: [...args],
      env,
      root,
      bootstrap: false,
      shell,
      local: 'installed'
    }
  }
}

interface RecoverableLauncher {
  kind: string
  command: string | null
  args: string[]
  env: NodeJS.ProcessEnv
  shell: boolean
  root?: string
  local?: string
}

/** Never turn an explicit deployment failure into an unrelated install. */
export async function resolveWindowsLauncherReplacement<Backend extends RecoverableLauncher>(
  backend: Backend,
  activeRoot: string,
  hermesHome: string
): Promise<Backend | null> {
  if (process.platform !== 'win32' || backend.kind !== 'command' || backend.local === 'bundled' || !backend.command) {
    return null
  }

  const root = backend.root ?? activeRoot
  const command = backend.command.replace(/^"(.*)"$/, '$1')
  const key = (value: string): string => path.resolve(value).toLowerCase()
  const dirs = [path.join(root, '.hermes', 'bin')]

  if (key(root) === key(activeRoot)) {
    dirs.push(path.join(hermesHome, 'bin'))
  }

  const owned = dirs.some(dir => ['hermes.exe', 'hermes.cmd'].some(name => key(path.join(dir, name)) === key(command)))

  if (!owned) {
    return null
  }

  const replacement = await resolveSourceInstallationBackend(root, backend.args, {
    hermesHome,
    excludedLaunchers: [command],
    env: backend.env
  })

  if (!replacement || !launcherTargetsInstallation(replacement.command.replace(/^"(.*)"$/, '$1'), root)) {
    return null
  }

  return { ...backend, ...replacement, env: { ...backend.env, ...replacement.env } }
}

/** Developer overrides retain their interpreter, even outside the checkout. */
export function createSourcePythonBackend(
  root: string,
  python: string | null,
  args: string[],
  options: SourceOptions = {}
): SourceBackend | null {
  if (!python) {
    return null
  }

  let command: string = python

  if ((options.isWindows ?? process.platform === 'win32') && /[\\/]pythonw\.exe$/i.test(python)) {
    // Use only the console interpreter beside the selected windowless one.
    const consolePython: string = python.replace(/pythonw\.exe$/i, 'python.exe')

    if (existsSync(consolePython)) {
      command = consolePython
    }
  }

  return {
    kind: 'python',
    label: `Hermes source at ${root}`,
    command,
    args: ['-m', 'hermes_cli.main', ...args],
    // The backend runs in the user's workspace cwd, and the selected
    // interpreter need not have this checkout installed: name it explicitly.
    // (The scrubbed inherited value could point at another checkout.)
    env: { ...buildDesktopBackendEnv({ currentEnv: options.env ?? process.env }), PYTHONPATH: root },
    root,
    bootstrap: false,
    shell: false,
    local: 'installed'
  }
}
