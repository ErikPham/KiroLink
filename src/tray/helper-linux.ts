/**
 * Linux tray helper.
 *
 * Linux has no tray mechanism that is guaranteed present, so this probes for one
 * in order of preference and reports honestly when none is available. The
 * supervisor then runs headless rather than failing — the proxy is the point, the
 * icon is a convenience.
 *
 * Order: python3 + AppIndicator3 (proper StatusNotifierItem, full menu), then
 * yad (menu support, widely packaged), then none.
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 10_000

export type LinuxTrayBackend = 'appindicator' | 'yad'

/**
 * The GTK helper. AppIndicator3 (or its Ayatana fork) is what GNOME, KDE, and
 * XFCE all understand; plain GtkStatusIcon is removed from GTK4 and ignored by
 * modern GNOME, so it is not attempted.
 */
const PYTHON_SOURCE = String.raw`#!/usr/bin/env python3
"""KiroLink tray helper.

Reads tab-separated status lines on stdin, writes command words to stdout.
See src/tray/protocol.ts.
"""
import json
import sys

import gi

gi.require_version("Gtk", "3.0")
try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator
except (ValueError, ImportError):
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3 as AppIndicator

from gi.repository import GLib, Gtk

try:
    gi.require_version("Notify", "0.7")
    from gi.repository import Notify

    Notify.init("KiroLink")
    HAVE_NOTIFY = True
except (ValueError, ImportError):
    HAVE_NOTIFY = False


def emit(command):
    sys.stdout.write(command + "\n")
    sys.stdout.flush()


class Tray:
    def __init__(self):
        self.indicator = AppIndicator.Indicator.new(
            "kirolink",
            "network-transmit-receive",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS,
        )
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)

        menu = Gtk.Menu()
        self.status_item = self._label("Starting…", menu)
        self.credits_item = self._label("", menu)
        self.requests_item = self._label("", menu)
        menu.append(Gtk.SeparatorMenuItem())
        self._action("Open Dashboard", "dashboard", menu)
        self._action("Copy Base URL", "copy", menu)
        menu.append(Gtk.SeparatorMenuItem())
        self._action("Restart Proxy", "restart", menu)
        self._action("Stop Proxy", "stop", menu)
        menu.append(Gtk.SeparatorMenuItem())
        self._action("Quit KiroLink", "quit", menu, quit_after=True)
        menu.show_all()
        self.indicator.set_menu(menu)

        # Watch stdin without blocking the GTK main loop.
        GLib.io_add_watch(sys.stdin, GLib.IO_IN, self.on_stdin)
        GLib.io_add_watch(sys.stdin, GLib.IO_HUP, self.on_hup)

    def _label(self, text, menu):
        item = Gtk.MenuItem(label=text)
        item.set_sensitive(False)
        menu.append(item)
        return item

    def _action(self, text, command, menu, quit_after=False):
        item = Gtk.MenuItem(label=text)

        def clicked(_widget):
            emit(command)
            if quit_after:
                GLib.timeout_add(200, Gtk.main_quit)

        item.connect("activate", clicked)
        menu.append(item)
        return item

    def on_hup(self, _source, _condition):
        # Parent closed stdin: exit rather than linger as an orphan.
        Gtk.main_quit()
        return False

    def on_stdin(self, source, _condition):
        line = source.readline()
        if not line:
            Gtk.main_quit()
            return False
        self.handle(line.rstrip("\n"))
        return True

    def handle(self, line):
        fields = line.split("\t")
        if not fields:
            return
        if fields[0] == "status" and len(fields) >= 2:
            self.apply_status(fields[1])
        elif fields[0] == "notify" and len(fields) >= 3:
            self.notify(fields[1], fields[2])

    def apply_status(self, payload):
        try:
            status = json.loads(payload)
        except json.JSONDecodeError:
            return
        base_url = status.get("baseUrl", "")
        if status.get("running"):
            self.status_item.set_label("Running · " + base_url)
            self.indicator.set_title("KiroLink · " + base_url)
        else:
            self.status_item.set_label("Stopped")
            self.indicator.set_title("KiroLink · stopped")
        credits = status.get("credits") or "Credits: unknown"
        self.status_item.show()
        self.credits_item.set_label(credits)
        self.requests_item.set_label(
            "Requests: %s · auth %s" % (status.get("requests", 0), status.get("auth", ""))
        )

    def notify(self, title, body):
        if not HAVE_NOTIFY:
            return
        Notify.Notification.new(title, body, "dialog-information").show()


Tray()
Gtk.main()
`

/** Detect a usable backend, or undefined when the desktop offers none. */
export async function detectLinuxTrayBackend(): Promise<LinuxTrayBackend | undefined> {
  if (await hasPythonAppIndicator()) return 'appindicator'
  if (await hasCommand('yad')) return 'yad'
  return undefined
}

/** Write the helper if needed and return the command to run it. */
export async function buildLinuxTrayHelper(
  runtimeDir: string,
  backend: LinuxTrayBackend,
): Promise<{ command: string; args: string[] }> {
  if (backend === 'yad') {
    // yad's notification mode takes menu entries as a single spec string and
    // prints the chosen command on stdout, matching the protocol closely enough
    // that no wrapper script is needed.
    const menu = [
      'Open Dashboard!echo dashboard',
      'Copy Base URL!echo copy',
      'Restart Proxy!echo restart',
      'Stop Proxy!echo stop',
      'Quit KiroLink!echo quit',
    ].join('|')
    return {
      command: 'yad',
      args: ['--notification', '--listen', '--image=network-transmit-receive', '--text=KiroLink', `--menu=${menu}`],
    }
  }

  const scriptPath = join(runtimeDir, 'kirolink-tray.py')
  const stampPath = join(runtimeDir, 'kirolink-tray.py.sha256')
  const hash = createHash('sha256').update(PYTHON_SOURCE).digest('hex')

  const stamp = await readFile(stampPath, 'utf8').catch(() => '')
  if (stamp.trim() !== hash) {
    await writeFile(scriptPath, PYTHON_SOURCE, { mode: 0o700 })
    await writeFile(stampPath, `${hash}\n`, { mode: 0o600 })
  }

  return { command: 'python3', args: [scriptPath] }
}

/** What to tell the user when no backend is available. */
export function linuxTrayInstallHint(): string {
  return 'Install a tray backend for the menu icon: apt install gir1.2-ayatanaappindicator3-0.1 python3-gi (or: apt install yad)'
}

async function hasPythonAppIndicator(): Promise<boolean> {
  try {
    await execFileAsync('python3', [
      '-c',
      // Verify the exact imports the helper needs, so a partial install is not
      // mistaken for a working one.
      'import gi;gi.require_version("Gtk","3.0");'
      + 'exec(\'try:\\n gi.require_version("AyatanaAppIndicator3","0.1")\\nexcept ValueError:\\n gi.require_version("AppIndicator3","0.1")\')',
    ], { timeout: PROBE_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command], { timeout: PROBE_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}
