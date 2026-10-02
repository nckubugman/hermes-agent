import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { type ElectronApplication, expect, test } from '@playwright/test'
import type { BrowserWindow } from 'electron'

import { buildAppEnv, createSandbox, findElectron } from './fixtures'

const desktop = path.resolve(import.meta.dirname, '..')
const repository = path.resolve(desktop, '..', '..')
const python = process.env.HERMES_E2E_PYTHON || path.join(repository, 'venv', 'Scripts', 'python.exe')

test.skip(process.platform !== 'win32', 'Real Windows launchers and process identity probes')
test.setTimeout(180_000)

type Connection = { baseUrl: string; wsUrl: string; token: string; profile: string }
type Audit = { launcher: string; pid: number; profile: string }

function events(file: string): Audit[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

async function connection(app: ElectronApplication, profile = 'default'): Promise<Connection> {
  return app.evaluate(async ({ ipcMain, BrowserWindow }, profile) => {
    const handlers = (ipcMain as any)._invokeHandlers
    const sender = BrowserWindow.getAllWindows().find((window: BrowserWindow) => !window.isDestroyed())!.webContents

    return profile === 'default'
      ? handlers.get('hermes:connection')({ sender }, 'default')
      : handlers.get('hermes:connection:for')({ sender }, { connectionId: 'local', profile, priority: 'foreground' })
  }, profile)
}

async function verifyTransport(route: Connection): Promise<void> {
  const response = await fetch(`${route.baseUrl}/api/health`, { headers: { Authorization: `Bearer ${route.token}` } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true })
  const ws = new WebSocket(route.wsUrl)

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket ping timed out')), 30_000)
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')) }, { once: true })
      ws.addEventListener('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })), { once: true })
      ws.addEventListener('message', event => {
        const reply = JSON.parse(String(event.data))

        if (reply.id === 1) {
          clearTimeout(timer)

          if (reply.error) {
            reject(new Error(JSON.stringify(reply.error)))
          } else {
            resolve()
          }
        }
      })
    })
  } finally {
    ws.close()
  }
}

for (const exhausted of [false, true]) {
  test(exhausted ? 'replacement exhaustion is latched without a third physical launch' : 'primary and Bots recover through the same installation and preserve profiles', async ({ playwright }, testInfo) => {
    const scratch = process.env.TMPDIR || path.join(process.env.LOCALAPPDATA!, 'hermes', 'cache', 'scratch')
    fs.mkdirSync(scratch, { recursive: true })
    process.env.TEMP = scratch
    process.env.TMP = scratch
    const sandbox = createSandbox(`launcher-recovery-${exhausted}`)
    const root = path.join(sandbox.hermesHome, 'hermes-agent')
    const audit = path.join(sandbox.root, 'launch-audit.jsonl')
    const failReplacement = path.join(sandbox.root, 'replacement-fails')
    let app: ElectronApplication | undefined
    const logs: string[] = []

    try {
      execFileSync(python, ['-I', path.join(import.meta.dirname, 'launcher-recovery-fixture.py'), root, repository, audit, failReplacement], { timeout: 30_000 })
      fs.writeFileSync(path.join(sandbox.hermesHome, 'config.yaml'), 'security:\n  tirith_enabled: false\nauxiliary:\n  title_generation:\n    enabled: false\n')
      fs.mkdirSync(path.join(sandbox.hermesHome, 'profiles', 'fw'), { recursive: true })
      fs.writeFileSync(path.join(sandbox.hermesHome, 'profiles', 'fw', 'config.yaml'), 'security:\n  tirith_enabled: false\n')

      if (exhausted) {
        fs.writeFileSync(failReplacement, 'fail')
      }

      const appData = path.join(sandbox.root, 'AppData', 'Roaming')
      const localAppData = path.join(sandbox.root, 'AppData', 'Local')
      fs.mkdirSync(appData, { recursive: true })
      fs.mkdirSync(localAppData, { recursive: true })

      const env = buildAppEnv(sandbox, {
        USERPROFILE: sandbox.root,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        HERMES_DESKTOP_HERMES_ROOT: '',
        HERMES_DESKTOP_PYTHON: '',
        HERMES_DESKTOP_HERMES: path.join(root, '.hermes', 'bin', 'hermes.exe'),
        HERMES_DESKTOP_DEV_SERVER: '',
        HERMES_DESKTOP_POOL_MAX: '2',
        HERMES_DISABLE_LAZY_INSTALLS: '1',
        HERMES_DESKTOP_APP_NAME: `HermesRecovery-${path.basename(sandbox.root)}`
      })

      app = await playwright._electron.launch({ executablePath: process.env.HERMES_E2E_RECOVERY_EXE || findElectron(), args: [process.env.HERMES_E2E_RECOVERY_DESKTOP || desktop, '--disable-gpu', '--no-sandbox'], env, cwd: desktop, timeout: 30_000 })
      app.process().stdout?.on('data', data => logs.push(data.toString()))
      app.process().stderr?.on('data', data => logs.push(data.toString()))
      await app.firstWindow({ timeout: 30_000 })

      if (exhausted) {
        await expect(connection(app)).rejects.toThrow(/recovery exhausted/)
        const initial = events(audit).filter(row => row.profile === 'default')
        expect(initial.map(row => row.launcher)).toEqual(['failed', 'replacement'])
        await expect(connection(app)).rejects.toThrow(/recovery exhausted/)
        expect(events(audit).filter(row => row.profile === 'default')).toHaveLength(2)
        await expect(connection(app, 'fw')).rejects.toThrow(/recovery exhausted/)
        await expect(connection(app, 'fw')).rejects.toThrow(/recovery exhausted/)
        expect(events(audit).filter(row => row.profile === 'fw')).toHaveLength(2)
        fs.unlinkSync(failReplacement)
        await app.evaluate(async ({ ipcMain }) => {
          await (ipcMain as any)._invokeHandlers.get('hermes:backend:recycle')({}, 'fw')
        })
        await verifyTransport(await connection(app, 'fw'))
        expect(events(audit).filter(row => row.profile === 'fw').map(row => row.launcher)).toEqual(['failed', 'replacement', 'failed', 'replacement'])
        await app.evaluate(async ({ ipcMain }) => {
          // fw's real serve command may update the remembered CLI profile.
          // Pin this explicit retry to the same primary profile being tested.
          await (ipcMain as any)._invokeHandlers.get('hermes:profile:remember')({}, 'default')
          await (ipcMain as any)._invokeHandlers.get('hermes:bootstrap:reset')({})
        })
        const retried = await connection(app)
        expect(retried.profile).toBe('default')
        await verifyTransport(retried)
        expect(events(audit).filter(row => row.profile === 'default').map(row => row.launcher)).toEqual(['failed', 'replacement', 'failed', 'replacement'])
      } else {
        const primary = await connection(app)
        expect(primary.profile).toBe('default')
        await verifyTransport(primary)
        const pool = await connection(app, 'fw')
        expect(pool.profile).toBe('fw')
        expect(pool.baseUrl).not.toBe(primary.baseUrl)
        await verifyTransport(pool)

        for (const profile of ['default', 'fw']) {
          expect(events(audit).filter(row => row.profile === profile).map(row => row.launcher)).toEqual(['failed', 'replacement'])
        }

        await expect.poll(() => fs.readFileSync(path.join(sandbox.hermesHome, 'logs', 'desktop.log'), 'utf8')).toContain('[launcher-recovery]')
      }
    } finally {
      if (app) {
        await app.close()
      }

      const recorded = events(audit)
      await testInfo.attach('launch-audit', { body: JSON.stringify(recorded, null, 2), contentType: 'application/json' })
      await testInfo.attach('electron-output', { body: logs.join(''), contentType: 'text/plain' })
      const desktopLog = path.join(sandbox.hermesHome, 'logs', 'desktop.log')

      if (fs.existsSync(desktopLog)) {
        const destination = testInfo.outputPath('desktop.log')
        fs.copyFileSync(desktopLog, destination)
        await testInfo.attach('desktop-log', { path: destination, contentType: 'text/plain' })
      }

      await expect.poll(() => JSON.parse(execFileSync(python, ['-c', 'import json,psutil,sys; print(json.dumps([p for p in json.loads(sys.argv[1]) if psutil.pid_exists(p)]))', JSON.stringify(recorded.map(row => row.pid))], { encoding: 'utf8', timeout: 15_000 })), { timeout: 30_000 }).toEqual([])
      sandbox.cleanup()
    }
  })
}
