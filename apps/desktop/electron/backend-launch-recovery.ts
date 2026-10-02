import type { ChildProcess } from 'node:child_process'

import { type BackendOutputTail, createBackendOutputTail } from './backend-claim'
import { waitForDashboardPortAnnouncement } from './backend-ready'

export interface LauncherBackend {
  command: string | null
  args: string[]
  shell: boolean
}

interface LaunchRecoveryDeps<Backend extends LauncherBackend, Owner> {
  spawn: (backend: Backend) => ChildProcess
  claim: (child: ChildProcess, backend: Backend, output: BackendOutputTail) => Promise<Owner>
  stop: (child: ChildProcess) => Promise<void>
  release: (child: ChildProcess) => void
  assertCurrent: () => void
  recover: (backend: Backend) => Promise<Backend | null>
  log: (message: string) => void
  readyFile?: string | null
}

export class LauncherRecoveryExhaustedError extends Error {
  constructor(firstFailure: string, replacementFailure: string, cause: unknown) {
    super(
      `Hermes launcher recovery exhausted.\nInitial failure: ${firstFailure}\nReplacement failure: ${replacementFailure}`,
      { cause }
    )
  }
}

export async function launchBackendWithRecovery<Backend extends LauncherBackend, Owner>(
  initial: Backend,
  deps: LaunchRecoveryDeps<Backend, Owner>
) {
  let backend = initial
  let firstFailure = ''

  // Only one physical replacement. Failed cleanup or stale ownership fences
  // recovery before resolving or spawning anything else.
  for (let attempt = 0; attempt < 2; attempt++) {
    deps.assertCurrent()
    let child: ChildProcess | undefined
    let announcementError: unknown
    const outputTail = createBackendOutputTail()

    try {
      child = deps.spawn(backend)
      outputTail.attach(child)

      const portAnnouncement = waitForDashboardPortAnnouncement(child, {
        bufferedOutput: () => outputTail.text(),
        describeOutputTail: () => outputTail.describe(),
        readyFile: deps.readyFile
      }) as Promise<number>

      portAnnouncement.catch(error => {
        announcementError = error
      })

      const owner = await deps.claim(child, backend, outputTail)
      const port = await portAnnouncement
      deps.assertCurrent()

      if (child.exitCode !== null || child.signalCode !== null || child.killed) {
        throw new Error(`Hermes backend exited after its port announcement.${outputTail.describe()}`)
      }

      // Callers attach their streaming log listeners after this boundary.
      // Preserve output (including READY) emitted during the identity probe.
      if (outputTail.text()) {
        deps.log(outputTail.text())
      }

      return { backend, child, outputTail, owner, portAnnouncement: Promise.resolve(port) }
    } catch (error) {
      const spawnCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EINVAL'])
      const code = (value: unknown): string | undefined => (value as NodeJS.ErrnoException | null)?.code
      const failure = spawnCodes.has(code(announcementError) ?? '') ? announcementError : error
      const detail = `${failure instanceof Error ? failure.message : String(failure)}${outputTail.describe()}`

      const launcherFailed =
        spawnCodes.has(code(failure) ?? '') ||
        code(failure) === 'HERMES_BACKEND_LAUNCH_FAILED' ||
        (failure === announcementError && child?.exitCode !== null && child?.signalCode === null)

      const runtimeFailed = /Traceback \(most recent call last\)|ModuleNotFoundError|ImportError|SyntaxError/.test(
        outputTail.text()
      )

      if (child) {
        await deps.stop(child)
        deps.release(child)
      }

      deps.assertCurrent()

      if (attempt === 0 && launcherFailed && !runtimeFailed) {
        const replacement = await deps.recover(backend)
        deps.assertCurrent()

        if (replacement) {
          firstFailure = detail
          deps.log(`[launcher-recovery] ${detail}\nRetrying with ${replacement.command}`)
          backend = replacement

          continue
        }
      }

      if (firstFailure) {
        throw new LauncherRecoveryExhaustedError(firstFailure, detail, failure)
      }

      throw failure
    }
  }

  throw new Error('Hermes launcher recovery exhausted.')
}
