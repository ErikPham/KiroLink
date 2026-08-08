/**
 * Windows notification-area helper.
 *
 * PowerShell with System.Windows.Forms is available on every supported Windows
 * install, so nothing needs compiling and no toolchain is required. The script is
 * written to the runtime directory and run with -ExecutionPolicy Bypass, which
 * applies only to this invocation and does not change machine policy.
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Note on quoting: this script is passed as a file path, never interpolated with
 * user data, so there is no injection surface here. All dynamic values arrive on
 * stdin as JSON.
 */
const POWERSHELL_SOURCE = String.raw`# KiroLink notification-area helper.
# Reads tab-separated status lines on stdin, writes command words to stdout.
# See src/tray/protocol.ts.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Send-Command([string]$name) {
    [Console]::Out.WriteLine($name)
    [Console]::Out.Flush()
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.Text = 'KiroLink'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

# Disabled entries act as status labels.
$statusItem = $menu.Items.Add('Starting...')
$statusItem.Enabled = $false
$creditsItem = $menu.Items.Add('')
$creditsItem.Enabled = $false
$requestsItem = $menu.Items.Add('')
$requestsItem.Enabled = $false
[void]$menu.Items.Add('-')

$dashboardItem = $menu.Items.Add('Open Dashboard')
$dashboardItem.Add_Click({ Send-Command 'dashboard' })
$copyItem = $menu.Items.Add('Copy Base URL')
$copyItem.Add_Click({ Send-Command 'copy' })
[void]$menu.Items.Add('-')
$restartItem = $menu.Items.Add('Restart Proxy')
$restartItem.Add_Click({ Send-Command 'restart' })
$stopItem = $menu.Items.Add('Stop Proxy')
$stopItem.Add_Click({ Send-Command 'stop' })
[void]$menu.Items.Add('-')
$quitItem = $menu.Items.Add('Quit KiroLink')
$quitItem.Add_Click({
    Send-Command 'quit'
    $script:running = $false
})

$icon.ContextMenuStrip = $menu

$script:running = $true

# Reading stdin on a background runspace keeps the UI message pump responsive.
$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput())

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    while ($reader.Peek() -ge 0) {
        $line = $reader.ReadLine()
        if ($null -eq $line) {
            # Parent closed stdin: exit rather than linger as an orphan.
            $script:running = $false
            return
        }
        $fields = $line -split "\t"
        if ($fields[0] -eq 'status' -and $fields.Count -ge 2) {
            try {
                $status = $fields[1] | ConvertFrom-Json
                if ($status.running) {
                    $statusItem.Text = "Running - $($status.baseUrl)"
                    $icon.Text = "KiroLink - $($status.baseUrl)"
                } else {
                    $statusItem.Text = 'Stopped'
                    $icon.Text = 'KiroLink - stopped'
                }
                if ([string]::IsNullOrEmpty($status.credits)) {
                    $creditsItem.Text = 'Credits: unknown'
                } else {
                    $creditsItem.Text = $status.credits
                }
                $requestsItem.Text = "Requests: $($status.requests) - auth $($status.auth)"
            } catch {
                # A malformed status line is ignored rather than fatal.
            }
        } elseif ($fields[0] -eq 'notify' -and $fields.Count -ge 3) {
            $icon.BalloonTipTitle = $fields[1]
            $icon.BalloonTipText = $fields[2]
            $icon.ShowBalloonTip(5000)
        }
    }
    if (-not $script:running) {
        $timer.Stop()
        [System.Windows.Forms.Application]::Exit()
    }
})
$timer.Start()

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $icon.Visible = $false
    $icon.Dispose()
}
`

/** Write the helper script if needed and return the command to run it. */
export async function buildWindowsTrayHelper(runtimeDir: string): Promise<{ command: string; args: string[] }> {
  const scriptPath = join(runtimeDir, 'kirolink-tray.ps1')
  const stampPath = join(runtimeDir, 'kirolink-tray.ps1.sha256')
  const hash = createHash('sha256').update(POWERSHELL_SOURCE).digest('hex')

  const stamp = await readFile(stampPath, 'utf8').catch(() => '')
  if (stamp.trim() !== hash) {
    await writeFile(scriptPath, POWERSHELL_SOURCE, { mode: 0o600 })
    await writeFile(stampPath, `${hash}\n`, { mode: 0o600 })
  }

  return {
    command: 'powershell.exe',
    // -STA is required for Windows Forms; -NonInteractive keeps it from
    // prompting on a policy question.
    args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  }
}

export async function isWindowsTrayAvailable(): Promise<boolean> {
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      timeout: 15_000,
    })
    return true
  } catch {
    return false
  }
}
