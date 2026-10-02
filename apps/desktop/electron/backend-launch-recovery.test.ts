import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'

import { test } from 'vitest'

import { launchBackendWithRecovery } from './backend-launch-recovery'

const failing = {
  command: process.execPath,
  args: ['-e', 'console.error("Access denied"); process.exit(1)'],
  shell: false
}

const working = {
  command: process.execPath,
  args: ['-e', 'console.log("HERMES_BACKEND_READY port=23456"); setInterval(()=>{},1000)'],
  shell: false
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return
  }

  const exited = once(child, 'exit')
  child.kill()
  await exited
}

test('launcher failure is stopped before one replacement is claimed, preserving diagnostics on exhaustion', async () => {
  const children: ChildProcess[] = []
  const stopped: ChildProcess[] = []
  const logs: string[] = []
  let claims = 0
  let replacements = 0

  const deps = {
    spawn: (backend: typeof failing) => {
      if (children.length) {
        assert.equal(stopped.at(-1), children.at(-1))
      }

      const child = spawn(backend.command, backend.args, { stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child)

      return child
    },
    claim: async (child: ChildProcess) => {
      claims++

      if (claims === 1) {
        await once(child, 'exit')
        throw Object.assign(new Error('died before identity'), { code: 'HERMES_BACKEND_LAUNCH_FAILED' })
      }

      return { pid: child.pid }
    },
    stop: async (child: ChildProcess) => {
      await stop(child)
      stopped.push(child)
    },
    release: () => {},
    assertCurrent: () => {},
    recover: async () => {
      replacements++

      return working
    },
    log: (message: string) => logs.push(message)
  }

  try {
    const result = await launchBackendWithRecovery(failing, deps)
    assert.equal(result.backend, working)
    assert.equal(await result.portAnnouncement, 23456)
    assert.equal(children.length, 2)
    assert.equal(replacements, 1)
    assert.ok(logs.some(message => message.includes('Access denied')))
    assert.ok(
      logs.some(message => message.includes('HERMES_BACKEND_READY')),
      'early successful startup output must reach Desktop logs'
    )
    await stop(result.child)

    claims = 0
    children.length = 0
    stopped.length = 0

    deps.recover = async () => {
      replacements++

      return failing
    }

    deps.claim = async child => {
      await once(child, 'exit')
      throw Object.assign(new Error('died before identity'), { code: 'HERMES_BACKEND_LAUNCH_FAILED' })
    }

    await assert.rejects(launchBackendWithRecovery(failing, deps), /Access denied/)
    assert.equal(children.length, 2, 'replacement failure must not start a third process')
    assert.deepEqual(stopped, children)
  } finally {
    await Promise.all(children.map(stop))
  }
}, 15_000)

test('a child that announced READY but exited during its claim cannot be returned as live', async () => {
  let replaced = false
  await assert.rejects(
    launchBackendWithRecovery(working, {
      spawn: () =>
        spawn(process.execPath, ['-e', 'console.log("HERMES_BACKEND_READY port=23456"); process.exit(0)'], {
          stdio: ['ignore', 'pipe', 'pipe']
        }),
      claim: async child => {
        await once(child, 'exit')

        return child.pid
      },
      stop,
      release: () => {},
      assertCurrent: () => {},
      recover: async () => {
        replaced = true

        return working
      },
      log: () => {}
    }),
    /exited/
  )
  assert.equal(replaced, false, 'a READY runtime exit is not a launcher failure')
})

test('runtime, ownership and cancelled failures never change launchers', async () => {
  for (const scenario of ['runtime', 'ownership', 'cancelled']) {
    let replaced = false
    let cancelled = false

    const output =
      scenario === 'runtime' ? 'Traceback (most recent call last): ModuleNotFoundError: dotenv' : 'Access denied'

    const child = spawn(process.execPath, ['-e', `console.error(${JSON.stringify(output)}); process.exit(1)`], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    await assert.rejects(
      launchBackendWithRecovery(failing, {
        spawn: () => child,
        claim: async () => {
          await once(child, 'exit')
          cancelled = scenario === 'cancelled'
          throw Object.assign(new Error(scenario), {
            code: scenario === 'ownership' ? 'EIO' : 'HERMES_BACKEND_LAUNCH_FAILED'
          })
        },
        stop,
        release: () => {},
        assertCurrent: () => {
          if (cancelled) {
            throw new Error('cancelled')
          }
        },
        recover: async () => {
          replaced = true

          return working
        },
        log: () => {}
      })
    )
    assert.equal(replaced, false, scenario)
  }
}, 15_000)
